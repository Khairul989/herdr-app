//! Routes callbacks through GPUI APIs that require `Send + Sync` closures.

use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    rc::Weak,
    sync::Arc,
};

use gpui::{App, Window};

use crate::{
    ComponentDataValue, HostValue,
    engine::ShellRuntime,
    spec::CallbackId,
};

#[derive(Clone)]
pub(crate) struct ScriptCallbackRoute(Arc<RouteId>);

struct RouteId(u64);

struct RouteTarget {
    runtime: Weak<ShellRuntime>,
    callback: CallbackId,
}

thread_local! {
    static NEXT_ROUTE: Cell<u64> = const { Cell::new(1) };
    static ROUTES: RefCell<BTreeMap<u64, RouteTarget>> = const { RefCell::new(BTreeMap::new()) };
}

impl Drop for RouteId {
    fn drop(&mut self) {
        ROUTES.with_borrow_mut(|routes| {
            routes.remove(&self.0);
        });
    }
}

impl ScriptCallbackRoute {
    pub(crate) fn new(runtime: Weak<ShellRuntime>, callback: CallbackId) -> Self {
        let id = NEXT_ROUTE.with(|next| {
            let id = next.get();
            next.set(
                id.checked_add(1)
                    .expect("script callback route id space exhausted"),
            );
            id
        });
        ROUTES.with_borrow_mut(|routes| {
            routes.insert(id, RouteTarget { runtime, callback });
        });
        Self(Arc::new(RouteId(id)))
    }

    pub(crate) fn emit(&self, payload: HostValue, window: &mut Window, cx: &mut App) {
        self.emit_args(vec![payload], window, cx);
    }

    // HERDR: asks the handler to present one inline math node. Layout-phase, read-only.
    // A throw or a malformed result is logged and falls back to the readable source.
    pub(crate) fn inline_math(
        &self,
        node: (&str, &str),
        font_size: f32,
        line_height: f32,
        foreground: String,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<(gpui::AnyElement, f32)> {
        let (runtime, callback) = ROUTES.with_borrow(|routes| {
            routes
                .get(&self.0.0)
                .map(|target| (target.runtime.clone(), target.callback))
        })?;
        let runtime = runtime.upgrade()?;
        let object = |fields: Vec<(&str, ComponentDataValue)>| {
            ComponentDataValue::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
        };
        let arguments = [
            object(vec![
                ("tex", ComponentDataValue::String(node.0.into())),
                ("source", ComponentDataValue::String(node.1.into())),
            ]),
            object(vec![
                ("font_size", ComponentDataValue::Number(font_size.into())),
                ("line_height", ComponentDataValue::Number(line_height.into())),
                ("foreground", ComponentDataValue::String(foreground)),
            ]),
        ];
        match runtime.dispatch_inline_math(callback, &arguments, window, cx) {
            Ok(presented) => presented,
            Err(error) => {
                tracing::warn!("inline math renderer failed: {error:#}");
                None
            }
        }
    }

    /// Delivers several values to the handler, before its context.
    pub(crate) fn emit_args(&self, payloads: Vec<HostValue>, window: &mut Window, cx: &mut App) {
        let target = ROUTES.with_borrow(|routes| {
            routes
                .get(&self.0.0)
                .map(|target| (target.runtime.clone(), target.callback))
        });
        let Some((runtime, callback)) = target else {
            return;
        };
        if let Some(runtime) = runtime.upgrade() {
            runtime.dispatch_host_event_args(callback, payloads, window, cx);
        }
    }
}
