//! A device's live pixels and input stay in a native child view, outside the JS VM.
use gpui::{App, Window};
#[cfg(not(target_os = "macos"))]
use gpui::{IntoElement, ParentElement};
use gpui_shell::ComponentArgs;

pub fn set_occluded(window: &Window, visible: &std::collections::HashSet<u64>, occluded: bool) {
    #[cfg(target_os = "macos")]
    macos::set_occluded(window, visible, occluded);
    #[cfg(not(target_os = "macos"))]
    let _ = (window, visible, occluded);
}

pub fn release(copy: u64) {
    #[cfg(target_os = "macos")]
    macos::release(copy);
    #[cfg(not(target_os = "macos"))]
    let _ = copy;
}

pub fn build(copy: u64, args: ComponentArgs<'_>, window: &mut Window, cx: &mut App) -> gpui::AnyElement {
    #[cfg(target_os = "macos")]
    {
        macos::build(copy, args, window, cx)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (copy, args, window, cx);
        gpui::div().child("Live device viewing currently requires macOS.").into_any_element()
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
struct ViewCache<K, P, V> { entries: std::collections::HashMap<K, (P, V)> }

#[cfg(any(target_os = "macos", test))]
impl<K: Eq + std::hash::Hash, P: PartialEq, V: Clone> ViewCache<K, P, V> {
    fn get(&mut self, key: K, props: P, create: impl FnOnce() -> V) -> V {
        if let Some((previous, view)) = self.entries.get(&key) && previous == &props { return view.clone(); }
        let view = create();
        self.entries.insert(key, (props, view.clone()));
        view
    }
}

#[cfg(test)]
mod retention_tests {
    use super::ViewCache;
    use std::{collections::HashMap, rc::Rc};

    #[test]
    fn tab_hide_retains_view_and_reconnect_or_close_releases_only_its_owner() {
        let mut cache = ViewCache { entries: HashMap::new() };
        let first = cache.get((1, "session"), "revision-0", || Rc::new(1));
        let weak = Rc::downgrade(&first);
        drop(first);
        // Hidden tabs don't build their components. Another mod may render in
        // between; neither event releases the owning tab's native browser.
        let other = cache.get((2, "session"), "revision-0", || Rc::new(2));
        let restored = cache.get((1, "session"), "revision-0", || panic!("tab return must not recreate a stream"));
        assert!(Rc::ptr_eq(&weak.upgrade().unwrap(), &restored));
        drop(restored);
        let reconnected = cache.get((1, "session"), "revision-1", || Rc::new(3));
        assert!(weak.upgrade().is_none());
        drop(reconnected);
        cache.entries.retain(|(owner, _), _| *owner != 1);
        assert_eq!(cache.entries.len(), 1);
        assert!(Rc::ptr_eq(&other, &cache.get((2, "session"), "revision-0", || panic!("unrelated owner was removed"))));
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use gpui::{div, canvas, px, App, AppContext, Bounds, Context, Entity, IntoElement, ParentElement, Pixels, Render, Styled, Window};
    use gpui_shell::{ComponentArgs, HostValue};
    use std::{cell::{Cell, RefCell}, io::{BufRead, BufReader}, process::{ChildStdin, Command, Stdio}, rc::{Rc, Weak}};
    use wry::{WebView, WebViewBuilder, Rect, dpi::{LogicalPosition, LogicalSize}};

    pub struct DeviceView {
        copy: u64,
        owner: Option<ChildStdin>,
        url: Option<String>,
        webview: Option<Rc<NativeSurface>>,
        error: Option<String>,
    }

    struct NativeSurface { webview: WebView, visible: Cell<bool> }

    thread_local! {
        static VIEWS: RefCell<Vec<(gpui::WindowId, u64, Weak<NativeSurface>)>> = const { RefCell::new(Vec::new()) };
        static OWNED: RefCell<super::ViewCache<(u64, gpui::WindowId, String), (String, HostValue), Entity<DeviceView>>> = RefCell::new(super::ViewCache { entries: std::collections::HashMap::new() });
        static OCCLUDED: RefCell<std::collections::HashSet<gpui::WindowId>> = RefCell::new(std::collections::HashSet::new());
    }

    pub fn build(copy: u64, args: ComponentArgs<'_>, window: &mut Window, cx: &mut App) -> gpui::AnyElement {
        let props = args.props().clone();
        let session = props.get("session").and_then(HostValue::as_str).unwrap_or(args.id()).to_owned();
        let key = (copy, window.window_handle().window_id(), session);
        if props.get("active").and_then(HostValue::as_bool) == Some(false) {
            OWNED.with_borrow_mut(|views| { views.entries.remove(&key); });
            return div().into_any_element();
        }
        // The mod owns this entity even when its tab isn't painted. Reconnect
        // changes its props/id; closing the mod explicitly releases its copies.
        OWNED.with_borrow_mut(|views| views.get(key, (args.id().to_owned(), props.clone()), || cx.new(|cx| DeviceView::new(copy, props, cx)))).into_any_element()
    }

    pub fn release(copy: u64) {
        OWNED.with_borrow_mut(|views| views.entries.retain(|(owner, _, _), _| *owner != copy));
    }

    pub fn set_occluded(window: &Window, visible: &std::collections::HashSet<u64>, occluded: bool) {
        let id = window.window_handle().window_id();
        OCCLUDED.with_borrow_mut(|windows| { if occluded { windows.insert(id); } else { windows.remove(&id); } });
        // Child NSViews draw above the GPU scene. Hide them while a Herdr
        // overlay is open so they cannot cover or intercept its controls.
        VIEWS.with_borrow_mut(|views| views.retain(|(owner, copy, weak)| {
            let Some(view) = weak.upgrade() else { return false; };
            if *owner == id { let _ = view.webview.set_visible(view.visible.get() && visible.contains(copy) && !occluded); }
            true
        }));
    }

    impl DeviceView {
        pub fn new(copy: u64, props: HostValue, cx: &mut Context<Self>) -> Self {
            let mut view = Self { copy, owner: None, url: None, webview: None, error: None };
            let string = |key| props.get(key).and_then(HostValue::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
                .ok_or_else(|| format!("DeviceView needs {key}."));
            let start = || -> Result<_, String> {
                let node = string("node")?;
                let script = string("script")?;
                let tools = string("toolsRoot")?;
                let platform = string("platform")?;
                let device = string("device")?;
                let mut child = Command::new(node).args([script, tools, platform, device])
                    .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
                let owner = child.stdin.take();
                let output = child.stdout.take().unwrap();
                let (tx, rx) = async_channel::unbounded();
                // EOF on the ownership pipe tears down the server even when this
                // entity disappears while startup is still in progress.
                std::thread::spawn(move || {
                    for line in BufReader::new(output).lines() {
                        match line { Ok(line) => { let _ = tx.send_blocking(line); }, Err(_) => break }
                    }
                    let status = child.wait();
                    let _ = tx.send_blocking(serde_json::json!({ "error": format!("Live server stopped: {status:?}") }).to_string());
                });
                Ok((owner, rx))
            };
            match start() {
                Ok((owner, rx)) => {
                    view.owner = owner;
                    cx.spawn(async move |this, cx| {
                        while let Ok(line) = rx.recv().await {
                            let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
                            if this.update(cx, |view, cx| {
                                if let Some(error) = message["error"].as_str() {
                                    view.error = Some(error.to_owned()); view.webview = None; view.url = None;
                                } else if let Some(url) = message["url"].as_str() {
                                    if valid_url(url) { view.url = Some(url.to_owned()); }
                                    else { view.error = Some("Live server returned an invalid local address.".into()); }
                                }
                                cx.notify();
                            }).is_err() { break; }
                        }
                    }).detach();
                }
                Err(error) => view.error = Some(error),
            }
            view
        }

        fn place(&mut self, bounds: Bounds<Pixels>, visible: bool, window: &mut Window) {
            if self.webview.is_none() && self.error.is_none() && let Some(url) = &self.url {
                let origin = url.clone();
                let builder = WebViewBuilder::new().with_url(url).with_incognito(true).with_focused(false)
                    .with_visible(false)
                    .with_accept_first_mouse(true)
                    .with_navigation_handler(move |url| url.starts_with(&origin))
                    .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny);
                #[cfg(debug_assertions)]
                let builder = proof::instrument(builder);
                match builder.build_as_child(window) {
                    Ok(webview) => {
                        let webview = Rc::new(NativeSurface { webview, visible: Cell::new(false) });
                        VIEWS.with_borrow_mut(|views| views.push((window.window_handle().window_id(), self.copy, Rc::downgrade(&webview))));
                        self.webview = Some(webview);
                    }
                    Err(error) => self.error = Some(format!("Cannot embed device stream: {error}")),
                }
            }
            if let Some(surface) = &self.webview {
                let webview = &surface.webview;
                let _ = webview.set_bounds(Rect {
                    position: LogicalPosition::new(f64::from(f32::from(bounds.origin.x)), f64::from(f32::from(bounds.origin.y))).into(),
                    size: LogicalSize::new(f64::from(f32::from(bounds.size.width)), f64::from(f32::from(bounds.size.height))).into(),
                });
                let occluded = OCCLUDED.with_borrow(|windows| windows.contains(&window.window_handle().window_id()));
                surface.visible.set(visible);
                let _ = webview.set_visible(visible && !occluded);
            }
        }
    }

    // Native browser probes run only in an explicitly isolated debug app. They
    // exercise DOM input without synthesizing input on the person's display.
    #[cfg(debug_assertions)]
    mod proof {
        pub fn instrument(builder: wry::WebViewBuilder<'_>) -> wry::WebViewBuilder<'_> {
            let Ok(home) = crate::mods::app_dir().canonicalize() else { return builder; };
            let Ok(temp) = std::env::temp_dir().canonicalize() else { return builder; };
            let scratch = home.starts_with(temp) || home.starts_with(crate::mods::home().join(".cache"));
            if !scratch || !home.file_name().is_some_and(|n| n.to_string_lossy().starts_with("herdr-live-native")) { return builder; }
            let Some(path) = std::env::var_os("HERDR_DEVICE_PROBE") else { return builder; };
            let Ok(script) = std::fs::read_to_string(&path) else { return builder; };
            let output = std::path::PathBuf::from(path).with_extension("jsonl");
            builder.with_initialization_script(script).with_ipc_handler(move |request| {
                use std::io::Write;
                if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&output) {
                    let _ = writeln!(file, "{}", request.body());
                }
            })
        }
    }

    fn valid_url(url: &str) -> bool {
        url.strip_prefix("http://127.0.0.1:").and_then(|s| s.strip_suffix('/'))
            .and_then(|s| s.parse::<u16>().ok()).is_some_and(|port| port != 0)
    }

    impl Render for DeviceView {
        fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
            let this = cx.entity().downgrade();
            div().size_full().min_h(px(180.)).child(if let Some(error) = &self.error {
                div().p_3().child(error.clone()).into_any_element()
            } else if self.url.is_none() {
                div().p_3().child("Connecting live device stream…").into_any_element()
            } else {
                canvas(|bounds, window, _| (bounds, window.content_mask().bounds), move |_, (bounds, mask), window, cx| {
                    let visible = bounds.intersect(&mask) == bounds && bounds.size.width > px(0.) && bounds.size.height > px(0.);
                    let _ = this.update(cx, |view, _| view.place(bounds, visible, window));
                }).size_full().into_any_element()
            })
        }
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn stream_address_is_an_exact_loopback_origin() {
            assert!(super::valid_url("http://127.0.0.1:3497/"));
            for address in ["https://127.0.0.1:3497/", "http://127.0.0.1:0/", "http://localhost:3497/", "http://127.0.0.1:3497/other", "http://127.0.0.1:3497@evil.test/"] {
                assert!(!super::valid_url(address), "{address}");
            }
        }
    }
}
