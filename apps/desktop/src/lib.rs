use std::fs::{OpenOptions, create_dir_all};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use nsh_base::theme;
use nsh_core::prelude::*;

#[native_module("companiondesktop/native")]
fn native(registry: &mut Registry) {
    registry
        .register::<StatusPill>()
        .module::<DaemonDefaults>()
        .class::<SessionMetrics>()
        .class::<DaemonSidecar>();
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
        if let Ok(url) = std::env::var("LIVE_FOR_LLM_DAEMON_URL")
            && !url.trim().is_empty()
        {
            return url;
        }
        let port = std::env::var("LIVE_FOR_LLM_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(4777);
        format!("http://127.0.0.1:{port}")
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

fn parse_local_host_port(base_url: &str) -> Option<(String, u16)> {
    let trimmed = base_url.trim();
    let without_scheme = trimmed.strip_prefix("http://")?;
    let authority = without_scheme.split('/').next()?.trim();
    if authority.is_empty() {
        return None;
    }

    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h.trim(), p.parse::<u16>().ok()?),
        None => (authority, 4777),
    };

    if host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost") {
        Some((host.to_ascii_lowercase(), port))
    } else {
        None
    }
}

fn is_tcp_listening(host: &str, port: u16) -> bool {
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    for addr in addrs {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(80)).is_ok() {
            return true;
        }
    }
    false
}

fn resolve_daemon_entrypoint() -> Option<(String, Vec<String>, Option<PathBuf>)> {
    if let Some(bin) = std::env::var_os("LIVE_FOR_LLM_DAEMON_BIN") {
        let bin_str = bin.to_string_lossy().into_owned();
        if !bin_str.trim().is_empty() {
            return Some((bin_str, vec!["start".to_owned()], None));
        }
    }

    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join("live-for-llm-daemon");
        if sibling.is_file() {
            return Some((
                sibling.to_string_lossy().into_owned(),
                vec!["start".to_owned()],
                None,
            ));
        }
    }

    let manifest_cli = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/daemon/src/cli.ts");
    let cwd_candidates = [
        manifest_cli,
        PathBuf::from("packages/daemon/src/cli.ts"),
        PathBuf::from("../../packages/daemon/src/cli.ts"),
    ];
    for candidate in cwd_candidates {
        if candidate.is_file() {
            let resolved = candidate.canonicalize().unwrap_or(candidate);
            let root = resolved
                .parent()
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .and_then(|p| p.parent())
                .map(Path::to_path_buf);
            return Some((
                "node".to_owned(),
                vec![
                    "--experimental-strip-types".to_owned(),
                    resolved.to_string_lossy().into_owned(),
                    "start".to_owned(),
                ],
                root,
            ));
        }
    }

    None
}

fn open_sidecar_log() -> Option<(Stdio, Stdio)> {
    let base_dir = std::env::var_os("LIVE_FOR_LLM_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|h| h.join(".local/share/live-for-llm"))
        })?;
    create_dir_all(&base_dir).ok()?;
    let log_path = base_dir.join("daemon-sidecar.log");
    let out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .ok()?;
    let err = out.try_clone().ok()?;
    Some((Stdio::from(out), Stdio::from(err)))
}

/// Manages an automatically spawned local daemon sidecar for single-command desktop launches.
#[class]
pub struct DaemonSidecar {
    child: Option<Child>,
}

#[class]
impl DaemonSidecar {
    /// Creates an idle sidecar supervisor without spawning any process yet.
    pub fn new() -> Self {
        Self { child: None }
    }

    /// Ensures a local daemon is running for `base_url`, reusing an existing instance or spawning one.
    pub fn ensure_local(&mut self, base_url: String) -> String {
        let Some((host, port)) = parse_local_host_port(&base_url) else {
            return "remote-skipped".to_owned();
        };

        if let Some(child) = self.child.as_mut() {
            match child.try_wait() {
                Ok(None) => return "already-managed".to_owned(),
                _ => {
                    self.child = None;
                }
            }
        }

        if is_tcp_listening(&host, port) {
            return "already-running".to_owned();
        }

        let Some((program, args, workdir)) = resolve_daemon_entrypoint() else {
            return "unavailable:daemon-entrypoint-not-found".to_owned();
        };

        let mut cmd = Command::new(&program);
        cmd.args(&args)
            .env("LIVE_FOR_LLM_HOST", &host)
            .env("LIVE_FOR_LLM_PORT", port.to_string())
            .stdin(Stdio::null());

        if let Some(dir) = workdir {
            cmd.current_dir(dir);
        }

        if let Some((stdout_cfg, stderr_cfg)) = open_sidecar_log() {
            cmd.stdout(stdout_cfg).stderr(stderr_cfg);
        } else {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }

        match cmd.spawn() {
            Ok(child) => {
                self.child = Some(child);
                "started".to_owned()
            }
            Err(err) => format!("unavailable:{err}"),
        }
    }

    /// Stops the sidecar daemon if this desktop session spawned it.
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Whether this desktop instance owns a running daemon child process.
    #[getter]
    pub fn managed(&self) -> bool {
        self.child.is_some()
    }
}

impl Drop for DaemonSidecar {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::parse_local_host_port;

    #[test]
    fn parses_local_http_urls_and_skips_remote_hosts() {
        assert_eq!(
            parse_local_host_port("http://127.0.0.1:4777"),
            Some(("127.0.0.1".to_owned(), 4777))
        );
        assert_eq!(
            parse_local_host_port("http://localhost:4888/api"),
            Some(("localhost".to_owned(), 4888))
        );
        assert_eq!(
            parse_local_host_port("http://100.64.0.10:4777"),
            None
        );
        assert_eq!(parse_local_host_port("https://127.0.0.1:4777"), None);
    }
}
