//! One VM per mod copy; a successful reload must also retire its module cache.
use anyhow::Result;
use gpui::{App, Entity, Window};
use gpui_shell::{ShellRoot, ShellRuntime, SourceWatcher, policy::{self, Policy}};
use std::{path::{Path, PathBuf}, rc::Rc, time::{Duration, Instant}};

pub struct ModRuntime {
    runtime: Rc<ShellRuntime>,
    pub root: Entity<ShellRoot>,
    policy: Rc<Policy>,
    directory: PathBuf,
    watcher: Option<SourceWatcher>,
    scanning: Option<std::sync::mpsc::Receiver<(SourceWatcher, Result<bool>)>>,
    fit: bool,
    retired: [u64; 4],
}

impl ModRuntime {
    pub fn load(directory: &Path, watch: bool, window: &mut Window, cx: &mut App) -> Result<Self> {
        let runtime = ShellRuntime::new_isolated()?;
        let policy = policy::default();
        let root = runtime.try_load_with_policy(directory, policy.clone(), window, cx)?;
        Ok(Self { runtime, root, policy, directory: directory.into(), watcher: if watch { SourceWatcher::new(directory.into()).map_err(|e| tracing::warn!("no mod source watcher: {e:#}")).ok() } else { None }, scanning: None, fit: false, retired: [0; 4] })
    }

    pub fn reload(&mut self, window: &mut Window, cx: &mut App) -> Result<()> {
        // QuickJS retains ES modules until its context dies. Re-evaluating in
        // place accumulates every saved version, even after its views retire.
        let runtime = ShellRuntime::new_isolated()?;
        let watcher = self.watcher.as_ref().map(|_| SourceWatcher::new(self.directory.clone())).transpose()?;
        let root = runtime.try_load_with_policy(&self.directory, self.policy.clone(), window, cx)?;
        if self.fit { root.update(cx, |root, cx| root.set_fit_content(true, cx)); }
        self.runtime.retire_root(&self.root, cx)?;
        self.retired = self.metrics();
        self.root = root;
        self.runtime = runtime;
        self.watcher = watcher;
        Ok(())
    }

    pub fn poll(&mut self, cx: &mut App) -> Result<bool> {
        if let Some(scan) = &self.scanning {
            match scan.try_recv() {
                Ok((watcher, result)) => {
                    self.scanning = None;
                    if result.is_ok() { self.watcher = Some(watcher); }
                    return result;
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => return Ok(false),
                Err(error) => { self.scanning = None; return Err(error.into()); }
            }
        }
        if let Some(mut watcher) = self.watcher.take() {
            let (tx, rx) = std::sync::mpsc::channel();
            self.scanning = Some(rx);
            // Preserve the shell watcher's background scan: walking a mod's
            // source tree must not stall the window when OS watches fail.
            cx.background_executor().spawn(async move {
                let result = watcher.poll();
                let _ = tx.send((watcher, result));
            }).detach();
        }
        Ok(false)
    }

    pub fn fit_content(&mut self, cx: &mut App) {
        self.fit = true;
        self.root.update(cx, |root, cx| root.set_fit_content(true, cx));
    }

    pub fn refresh(&self, cx: &mut App) -> Result<()> { self.runtime.refresh(&self.root, cx) }

    pub fn close(&self, window: &mut Window, cx: &mut App) {
        self.runtime.close(&self.root, Instant::now() + Duration::from_millis(250), window, cx).detach();
    }

    pub fn close_now(&self, deadline: Instant, window: &mut Window, cx: &mut App) {
        self.runtime.close_now(&self.root, deadline, window, cx);
    }

    pub fn metrics(&self) -> [u64; 4] {
        let reading = self.runtime.read_metrics();
        let current = [reading.script_renders(), reading.script_render_time().as_micros() as u64, reading.materializations(), reading.materialize_time().as_micros() as u64];
        std::array::from_fn(|i| self.retired[i].saturating_add(current[i]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{Context, IntoElement, Render, TestAppContext};
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!("herdr-mod-reload-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn write(&self, generation: usize, large: bool) {
            let payload = if large { "x".repeat(3 * 1024 * 1024) } else { "x".into() };
            std::fs::write(self.0.join("main.js"), format!(r#"
import {{ View, div }} from "gpui-kit";
export const payload = "{generation}:{payload}";
export default class extends View {{
  render() {{ return div().child(payload.length); }}
}}"#)).unwrap();
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    struct Empty;
    impl Render for Empty {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement { gpui::div() }
    }

    #[gpui::test]
    fn mod_reload_releases_previous_module_runtime(cx: &mut TestAppContext) {
        cx.update(gpui_shell::init);
        let fixture = Fixture::new(); fixture.write(0, false);
        let window = cx.add_window(|_, _| Empty);
        let mut copy = window.update(cx, |_, window, cx| ModRuntime::load(&fixture.0, false, window, cx).unwrap()).unwrap();
        let previous = Rc::downgrade(&copy.runtime);
        fixture.write(1, false);
        window.update(cx, |_, window, cx| copy.reload(window, cx).unwrap()).unwrap();
        cx.run_until_parked();
        assert!(previous.upgrade().is_none(), "a saved mod must not retain its old VM and module definitions");
    }

    #[gpui::test]
    fn mod_reload_large_modules_stay_bounded_and_failed_saves_keep_the_good_copy(cx: &mut TestAppContext) {
        cx.update(gpui_shell::init);
        let fixture = Fixture::new(); fixture.write(0, true);
        let peer_fixture = Fixture::new(); peer_fixture.write(0, false);
        let window = cx.add_window(|_, _| Empty);
        let mut copy = window.update(cx, |_, window, cx| ModRuntime::load(&fixture.0, false, window, cx).unwrap()).unwrap();
        let peer = window.update(cx, |_, window, cx| ModRuntime::load(&peer_fixture.0, false, window, cx).unwrap()).unwrap();
        let peer_runtime = Rc::downgrade(&peer.runtime);
        for generation in 1..=96 {
            fixture.write(generation, true);
            window.update(cx, |_, window, cx| copy.reload(window, cx).unwrap_or_else(|e| panic!("reload {generation}: {e:#}"))).unwrap();
            cx.run_until_parked();
        }
        let good = copy.root.entity_id();
        std::fs::write(fixture.0.join("main.js"), "export default class {").unwrap();
        assert!(window.update(cx, |_, window, cx| copy.reload(window, cx)).unwrap().is_err());
        assert_eq!(copy.root.entity_id(), good, "a broken save must keep the last working view");
        assert!(Rc::ptr_eq(&peer_runtime.upgrade().unwrap(), &peer.runtime), "another mod must not restart");
        fixture.write(97, false);
        window.update(cx, |_, window, cx| copy.reload(window, cx).unwrap()).unwrap();
    }
    #[gpui::test]
    fn mod_reload_keeps_its_policy_and_storage_without_closing_the_host_overlay(cx: &mut TestAppContext) {
        use gpui_shell::{HostModule, HostValue, Capabilities};
        use std::cell::RefCell;
        cx.update(gpui_shell::init);
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join("main.js"), r#"
import { View, div } from "gpui-kit";
import { tag, note } from "fixture";
export default class extends View {
  init() { note(tag() + ":" + (localStorage.getItem("draft") || "empty")); localStorage.setItem("draft", "kept"); }
  close() { note("overlay closed"); }
  render() { return div(); }
}"#).unwrap();
        let seen = Rc::new(RefCell::new(Vec::new()));
        let notes = seen.clone();
        policy::set_default(Policy::new().with_application("mod-a")
            .with_capabilities(Capabilities::new().storage(true))
            .with_storage_path(fixture.0.join("store.json"))
            .with_host_module(HostModule::new("fixture")
                .function("tag", |_| Ok("A".into()))
                .function("note", move |a| { notes.borrow_mut().push(a.string(0)?.to_owned()); Ok(HostValue::Null) })).unwrap());
        let window = cx.add_window(|_, _| Empty);
        let mut copy = window.update(cx, |_, window, cx| ModRuntime::load(&fixture.0, false, window, cx).unwrap()).unwrap();
        policy::set_default(Policy::new().with_application("mod-b"));
        window.update(cx, |_, window, cx| copy.reload(window, cx).unwrap()).unwrap();
        cx.run_until_parked();
        assert_eq!(*seen.borrow(), ["A:empty", "A:kept"], "reload must preserve this mod's storage and host authority, without running its overlay-dismiss command");
        assert_eq!(policy::default().application(), "mod-b", "another mod's ambient policy must stay untouched");
    }

    #[gpui::test]
    fn mod_reload_polling_fallback_also_replaces_the_runtime(cx: &mut TestAppContext) {
        cx.update(gpui_shell::init);
        let fixture = Fixture::new(); fixture.write(0, false);
        let window = cx.add_window(|_, _| Empty);
        let mut copy = window.update(cx, |_, window, cx| ModRuntime::load(&fixture.0, true, window, cx).unwrap()).unwrap();
        let previous = Rc::downgrade(&copy.runtime);
        fixture.write(1, false);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let changed = window.update(cx, |_, _, cx| copy.poll(cx).unwrap()).unwrap();
            cx.run_until_parked();
            if changed { break; }
            assert!(Instant::now() < deadline, "the polling fallback missed a source edit");
            std::thread::sleep(Duration::from_millis(10));
        }
        window.update(cx, |_, window, cx| copy.reload(window, cx).unwrap()).unwrap();
        cx.run_until_parked();
        assert!(previous.upgrade().is_none(), "fallback reload must release its old module cache too");
    }

}
