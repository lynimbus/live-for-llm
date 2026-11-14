use nsh_base::theme;
use nsh_core::prelude::*;

#[native_module("companiondesktop/native")]
fn native(registry: &mut Registry) {
    registry
        .register::<StatusPill>()
        .module::<DaemonDefaults>()
        .class::<SessionMetrics>();
}

#[derive(Debug, Clone, PartialEq, Props)]
pub struct StatusPillProps {
    pub label: Prop<SharedString>,
    pub tone: Prop<SharedString>,
}

#[derive(Debug, Clone, PartialEq, Event)]
pub enum StatusPillEvent {
    Press,
}

#[component]
pub fn StatusPill(props: StatusPillProps, cx: Scope<StatusPillEvent>) -> impl IntoElement {
    let bg_tone = props.tone.clone();
    let fg_tone = props.tone;
    view()
        .px_3()
        .py_1()
        .rounded_full()
        .bg(move || match bg_tone.get().as_str() {
            "connected" => theme().primary,
            "warning" => theme().destructive,
            _ => theme().muted,
        })
        .on_press(move || cx.emit(StatusPillEvent::Press))
        .child(text(props.label).text_color(move || match fg_tone.get().as_str() {
            "connected" | "warning" => theme().primary_foreground,
            _ => theme().muted_foreground,
        }))
}

#[module]
pub struct DaemonDefaults;

#[module]
impl DaemonDefaults {
    pub fn default_url() -> String {
        "http://127.0.0.1:4777".to_owned()
    }

    pub fn short_id(raw: String) -> String {
        raw.chars().take(12).collect()
    }
}

#[class]
pub struct SessionMetrics {
    turns: u32,
    tasks: u32,
}

#[class]
impl SessionMetrics {
    pub fn new() -> Self {
        Self { turns: 0, tasks: 0 }
    }

    pub fn record_turn(&mut self) -> u32 {
        self.turns += 1;
        self.turns
    }

    pub fn record_task(&mut self) -> u32 {
        self.tasks += 1;
        self.tasks
    }

    #[getter]
    pub fn turns(&self) -> u32 {
        self.turns
    }

    #[getter]
    pub fn tasks(&self) -> u32 {
        self.tasks
    }
}
