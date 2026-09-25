use crate::config::CompletionJudgeConfig;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
pub struct JudgeRequest<'a> {
    pub schema_version: u32,
    pub objective: Option<&'a str>,
    pub completion_promise: &'a str,
    pub iteration: u32,
    pub rejections: u32,
    pub workspace: String,
    pub loop_id: Option<String>,
    pub closed_tasks: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct JudgeVerdict {
    pub verdict: JudgeDecision,
    #[serde(default)]
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JudgeDecision {
    Pass,
    Fail,
}

pub fn run_judge(
    config: &CompletionJudgeConfig,
    workspace: &Path,
    request: &JudgeRequest<'_>,
) -> Result<JudgeVerdict, String> {
    let Some((program, args)) = config.command.split_first() else {
        return Err("completion_judge.command is empty".to_string());
    };
    let payload = serde_json::to_vec(request).map_err(|e| e.to_string())?;

    let mut command = Command::new(program);
    if !workspace.as_os_str().is_empty() {
        command.current_dir(workspace);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn judge '{program}': {e}"))?;

    let mut stdin = child.stdin.take().ok_or("judge stdin unavailable")?;
    let (writer_tx, writer_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let error = match stdin.write_all(&payload) {
            Err(e) if e.kind() != std::io::ErrorKind::BrokenPipe => Some(e.to_string()),
            _ => None,
        };
        let _ = writer_tx.send(error);
    });
    let stdout = Captured::start(child.stdout.take(), MAX_STDOUT_BYTES);
    let stderr = Captured::start(child.stderr.take(), MAX_STDERR_BYTES);

    let deadline = Instant::now() + Duration::from_secs(config.timeout_seconds.max(1));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                terminate_process_group(&mut child);
                return Err(format!("judge timed out after {}s", config.timeout_seconds));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("failed to wait for judge: {e}")),
        }
    };

    kill_process_group(child.id());
    let grace = deadline
        .saturating_duration_since(Instant::now())
        .clamp(Duration::from_millis(100), JUDGE_EXIT_GRACE);
    if let Ok(Some(error)) = writer_rx.recv_timeout(grace) {
        return Err(format!("failed to write judge stdin: {error}"));
    }
    let output = stdout.finish(grace);
    let errors = stderr.finish(grace);
    if !status.success() {
        let detail = stderr_tail(&errors);
        return Err(if detail.is_empty() {
            format!("judge exited with {status}")
        } else {
            format!("judge exited with {status}: {detail}")
        });
    }
    parse_verdict(&output)
}

const JUDGE_EXIT_GRACE: Duration = Duration::from_secs(2);
const JUDGE_TERM_GRACE: Duration = Duration::from_secs(3);

fn kill_process_group(pid: u32) {
    #[cfg(unix)]
    {
        use nix::sys::signal::{Signal, kill};
        use nix::unistd::Pid;
        let _ = kill(Pid::from_raw(-(pid as i32)), Signal::SIGKILL);
    }
    #[cfg(not(unix))]
    let _ = pid;
}

fn terminate_process_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        use nix::sys::signal::{Signal, kill};
        use nix::unistd::Pid;
        let group = Pid::from_raw(-(child.id() as i32));
        if kill(group, Signal::SIGTERM).is_ok() {
            let until = Instant::now() + JUDGE_TERM_GRACE;
            while Instant::now() < until {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = kill(group, Signal::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}
const MAX_STDOUT_BYTES: usize = 1 << 20;
const MAX_STDERR_BYTES: usize = 64 << 10;

struct Captured {
    data: Arc<Mutex<Vec<u8>>>,
    done: mpsc::Receiver<()>,
    limit: usize,
}

impl Captured {
    fn start<R: Read + Send + 'static>(stream: Option<R>, limit: usize) -> Self {
        let data = Arc::new(Mutex::new(Vec::new()));
        let (tx, done) = mpsc::channel();
        let sink = Arc::clone(&data);
        std::thread::spawn(move || {
            if let Some(mut stream) = stream {
                let mut chunk = [0u8; 8192];
                while let Ok(n) = stream.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    if let Ok(mut buf) = sink.lock() {
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.len() > limit.saturating_mul(2) {
                            let excess = buf.len() - limit;
                            buf.drain(..excess);
                        }
                    }
                }
            }
            let _ = tx.send(());
        });
        Self { data, done, limit }
    }

    fn finish(self, grace: Duration) -> String {
        let _ = self.done.recv_timeout(grace);
        self.data
            .lock()
            .map(|buf| {
                let keep = buf.len().saturating_sub(self.limit);
                String::from_utf8_lossy(&buf[keep..]).into_owned()
            })
            .unwrap_or_default()
    }
}

fn stderr_tail(stderr: &str) -> String {
    const MAX: usize = 500;
    let trimmed = stderr.trim();
    let start = trimmed.len().saturating_sub(MAX);
    let start = (start..=trimmed.len())
        .find(|&i| trimmed.is_char_boundary(i))
        .unwrap_or(trimmed.len());
    trimmed[start..].replace('\n', " | ")
}

fn parse_verdict(output: &str) -> Result<JudgeVerdict, String> {
    let line = output
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .ok_or("judge produced no output")?;
    serde_json::from_str(line.trim()).map_err(|e| format!("invalid judge verdict: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::TempDir;

    fn script(dir: &TempDir, body: &str) -> String {
        let path = dir.path().join("judge.sh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn request() -> JudgeRequest<'static> {
        JudgeRequest {
            schema_version: 1,
            objective: Some("ship it"),
            completion_promise: "LOOP_COMPLETE",
            iteration: 3,
            rejections: 0,
            workspace: "/tmp".to_string(),
            loop_id: None,
            closed_tasks: vec![],
        }
    }

    fn config(command: String, timeout_seconds: u64) -> CompletionJudgeConfig {
        let command = if std::path::Path::new(&command).exists() {
            vec!["sh".to_string(), command]
        } else {
            vec![command]
        };
        CompletionJudgeConfig {
            command,
            timeout_seconds,
            ..CompletionJudgeConfig::default()
        }
    }

    #[test]
    fn parses_fail_verdict_from_last_line() {
        let dir = TempDir::new().unwrap();
        let cmd = script(
            &dir,
            "cat >/dev/null\necho noise\necho '{\"verdict\":\"fail\",\"reason\":\"tests missing\"}'",
        );
        let verdict = run_judge(&config(cmd, 5), dir.path(), &request()).unwrap();
        assert_eq!(verdict.verdict, JudgeDecision::Fail);
        assert_eq!(verdict.reason, "tests missing");
    }

    #[test]
    fn judge_receives_objective_on_stdin() {
        let dir = TempDir::new().unwrap();
        let cmd = script(
            &dir,
            "if grep -q 'ship it'; then echo '{\"verdict\":\"pass\"}'; else echo '{\"verdict\":\"fail\"}'; fi",
        );
        let verdict = run_judge(&config(cmd, 5), dir.path(), &request()).unwrap();
        assert_eq!(verdict.verdict, JudgeDecision::Pass);
    }

    #[test]
    fn nonzero_exit_is_error() {
        let dir = TempDir::new().unwrap();
        let cmd = script(&dir, "cat >/dev/null\nexit 3");
        assert!(run_judge(&config(cmd, 5), dir.path(), &request()).is_err());
    }

    #[test]
    fn timeout_is_error() {
        let dir = TempDir::new().unwrap();
        let cmd = script(&dir, "sleep 5");
        let err = run_judge(&config(cmd, 1), dir.path(), &request()).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
    }

    #[test]
    fn parse_verdict_table() {
        let cases: &[(&str, Option<(JudgeDecision, &str)>)] = &[
            (r#"{"verdict":"pass"}"#, Some((JudgeDecision::Pass, ""))),
            (
                r#"{"verdict":"fail","reason":"x"}"#,
                Some((JudgeDecision::Fail, "x")),
            ),
            (
                "noise\n{\"verdict\":\"pass\",\"reason\":\"ok\"}\n\n  \n",
                Some((JudgeDecision::Pass, "ok")),
            ),
            (
                "  {\"verdict\":\"fail\"}  ",
                Some((JudgeDecision::Fail, "")),
            ),
            (
                r#"{"verdict":"pass","reason":"r","extra":1}"#,
                Some((JudgeDecision::Pass, "r")),
            ),
            ("{\"verdict\":\"pass\"}\ntrailing text", None),
            (r#"{"verdict":"PASS"}"#, None),
            (r#"{"verdict":"maybe"}"#, None),
            (r#"{"reason":"no verdict"}"#, None),
            (r#"{"verdict":true}"#, None),
            ("", None),
            ("   \n  \n", None),
            ("not json", None),
            ("[]", None),
        ];
        for (input, expected) in cases {
            let parsed = parse_verdict(input);
            match expected {
                Some((decision, reason)) => {
                    let verdict = parsed.unwrap_or_else(|e| panic!("{input:?}: {e}"));
                    assert_eq!(verdict.verdict, *decision, "{input:?}");
                    assert_eq!(verdict.reason, *reason, "{input:?}");
                }
                None => assert!(parsed.is_err(), "{input:?} should fail"),
            }
        }
    }

    #[test]
    fn empty_command_is_error() {
        let dir = TempDir::new().unwrap();
        let cfg = CompletionJudgeConfig::default();
        let err = run_judge(&cfg, dir.path(), &request()).unwrap_err();
        assert!(err.contains("empty"));
    }

    #[test]
    fn missing_program_is_error() {
        let dir = TempDir::new().unwrap();
        let err = run_judge(
            &config("/definitely/not/a/judge".to_string(), 5),
            dir.path(),
            &request(),
        )
        .unwrap_err();
        assert!(err.contains("failed to spawn"));
    }

    #[test]
    fn judge_runs_in_workspace_directory() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("marker"), "x").unwrap();
        let cmd = script(
            &dir,
            "cat >/dev/null\nif [ -f marker ]; then echo '{\"verdict\":\"pass\"}'; else echo '{\"verdict\":\"fail\"}'; fi",
        );
        let verdict = run_judge(&config(cmd, 5), dir.path(), &request()).unwrap();
        assert_eq!(verdict.verdict, JudgeDecision::Pass);
    }

    #[test]
    fn judge_receives_full_request_json() {
        let dir = TempDir::new().unwrap();
        let out = dir.path().join("stdin.json");
        let cmd = script(
            &dir,
            &format!("cat > {}\necho '{{\"verdict\":\"pass\"}}'", out.display()),
        );
        run_judge(&config(cmd, 5), dir.path(), &request()).unwrap();
        let sent: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(out).unwrap()).unwrap();
        assert_eq!(sent["schema_version"], 1);
        assert_eq!(sent["objective"], "ship it");
        assert_eq!(sent["completion_promise"], "LOOP_COMPLETE");
        assert_eq!(sent["iteration"], 3);
        assert_eq!(sent["rejections"], 0);
        assert!(sent["closed_tasks"].as_array().unwrap().is_empty());
        assert!(sent["loop_id"].is_null());
    }

    #[test]
    fn large_output_does_not_deadlock() {
        let dir = TempDir::new().unwrap();
        let cmd = script(
            &dir,
            "cat >/dev/null\nhead -c 2000000 /dev/zero | tr '\\0' 'x'\necho\necho '{\"verdict\":\"pass\"}'",
        );
        let verdict = run_judge(&config(cmd, 10), dir.path(), &request()).unwrap();
        assert_eq!(verdict.verdict, JudgeDecision::Pass);
    }

    #[test]
    fn judge_that_ignores_stdin_still_works() {
        let dir = TempDir::new().unwrap();
        let cmd = script(&dir, "exec echo '{\"verdict\":\"pass\"}'");
        let padding = "x".repeat(1 << 20);
        let big = JudgeRequest {
            objective: Some(&padding),
            ..request()
        };
        for _ in 0..20 {
            let verdict = run_judge(&config(cmd.clone(), 5), dir.path(), &big).unwrap();
            assert_eq!(verdict.verdict, JudgeDecision::Pass);
        }
    }

    #[test]
    fn config_yaml_defaults_and_overrides() {
        let cfg: CompletionJudgeConfig = serde_yaml::from_str("command: [\"j\"]").unwrap();
        assert_eq!(cfg.command, vec!["j".to_string()]);
        assert_eq!(cfg.timeout_seconds, 60);
        assert_eq!(cfg.max_rejections, 3);
        assert!(!cfg.fail_closed);
        let cfg: CompletionJudgeConfig = serde_yaml::from_str(
            "command: [\"a\", \"b\"]\ntimeout_seconds: 900\nmax_rejections: 0\nfail_closed: true",
        )
        .unwrap();
        assert_eq!(cfg.command.len(), 2);
        assert_eq!(cfg.timeout_seconds, 900);
        assert_eq!(cfg.max_rejections, 0);
        assert!(cfg.fail_closed);
    }

    #[test]
    fn ralph_config_accepts_completion_judge() {
        let cfg: crate::config::RalphConfig = serde_yaml::from_str(
            "event_loop:\n  completion_judge:\n    command: [\"ralph-gauntlet-judge\"]\n    max_rejections: 0\n",
        )
        .unwrap();
        let judge = cfg.event_loop.completion_judge.unwrap();
        assert_eq!(judge.command, vec!["ralph-gauntlet-judge".to_string()]);
        assert_eq!(judge.max_rejections, 0);
        let cfg: crate::config::RalphConfig = serde_yaml::from_str("event_loop: {}\n").unwrap();
        assert!(cfg.event_loop.completion_judge.is_none());
    }

    #[test]
    fn nonzero_exit_reports_stderr_tail() {
        let dir = TempDir::new().unwrap();
        let cmd = script(
            &dir,
            "cat >/dev/null\necho 'first line' >&2\necho 'git add failed' >&2\nexit 1",
        );
        let err = run_judge(&config(cmd, 5), dir.path(), &request()).unwrap_err();
        assert!(err.contains("exited with"), "{err}");
        assert!(err.contains("first line | git add failed"), "{err}");
    }

    #[test]
    fn stderr_tail_keeps_the_end_and_char_boundaries() {
        assert_eq!(stderr_tail(""), "");
        assert_eq!(stderr_tail("  a\nb  "), "a | b");
        let long = format!("{}é{}", "x".repeat(600), "end");
        let tail = stderr_tail(&long);
        assert!(tail.ends_with("éend") || tail.ends_with("end"));
        assert!(tail.len() <= 502);
    }

    #[test]
    fn timeout_applies_when_judge_never_reads_a_large_request() {
        let dir = TempDir::new().unwrap();
        let cmd = script(&dir, "sleep 30");
        let padding = "x".repeat(8 << 20);
        let big = JudgeRequest {
            objective: Some(&padding),
            ..request()
        };
        let started = std::time::Instant::now();
        let err = run_judge(&config(cmd, 1), dir.path(), &big).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[test]
    fn lingering_child_holding_stdout_does_not_hang_the_loop() {
        let dir = TempDir::new().unwrap();
        let cmd = script(
            &dir,
            "cat >/dev/null\n(sleep 30 &)\necho '{\"verdict\":\"pass\",\"reason\":\"ok\"}'",
        );
        let started = std::time::Instant::now();
        let verdict = run_judge(&config(cmd, 60), dir.path(), &request()).unwrap();
        assert_eq!(verdict.verdict, JudgeDecision::Pass);
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[test]
    fn lingering_child_holding_stdin_does_not_hang_the_loop() {
        let dir = TempDir::new().unwrap();
        let cmd = script(
            &dir,
            "(sleep 30 <&0 &)\necho '{\"verdict\":\"fail\",\"reason\":\"r\"}'",
        );
        let padding = "x".repeat(4 << 20);
        let big = JudgeRequest {
            objective: Some(&padding),
            ..request()
        };
        let started = std::time::Instant::now();
        let verdict = run_judge(&config(cmd, 60), dir.path(), &big).unwrap();
        assert_eq!(verdict.verdict, JudgeDecision::Fail);
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[test]
    fn huge_output_is_bounded_and_the_verdict_still_parses() {
        let dir = TempDir::new().unwrap();
        let cmd = script(
            &dir,
            "cat >/dev/null\nhead -c 30000000 /dev/zero | tr '\\0' 'y'\necho\nhead -c 3000000 /dev/zero | tr '\\0' 'e' >&2\necho '{\"verdict\":\"fail\",\"reason\":\"tail kept\"}'",
        );
        let verdict = run_judge(&config(cmd, 60), dir.path(), &request()).unwrap();
        assert_eq!(verdict.verdict, JudgeDecision::Fail);
        assert_eq!(verdict.reason, "tail kept");
    }

    #[test]
    fn captured_keeps_only_the_tail() {
        let data: &[u8] = b"0123456789abcdefghij";
        let captured = Captured::start(Some(data), 5);
        assert_eq!(captured.finish(Duration::from_secs(2)), "fghij");
    }

    #[test]
    fn timeout_kills_the_whole_process_group() {
        let dir = TempDir::new().unwrap();
        let marker = dir.path().join("survived");
        let cmd = script(
            &dir,
            &format!(
                "cat >/dev/null\nsh -c 'sleep 2; touch {}' &\nsleep 30",
                marker.display()
            ),
        );
        let err = run_judge(&config(cmd, 1), dir.path(), &request()).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        std::thread::sleep(Duration::from_secs(3));
        assert!(!marker.exists(), "a judge descendant survived the timeout");
    }

    #[test]
    fn timeout_gives_the_judge_a_chance_to_clean_up() {
        let dir = TempDir::new().unwrap();
        let marker = dir.path().join("cleaned");
        let cmd = script(
            &dir,
            &format!(
                "trap 'touch {}; exit 143' TERM\ncat >/dev/null\nsleep 30 &\nwait",
                marker.display()
            ),
        );
        run_judge(&config(cmd, 3), dir.path(), &request()).unwrap_err();
        assert!(
            marker.exists(),
            "judge did not receive SIGTERM before SIGKILL"
        );
    }

    #[test]
    fn descendants_left_by_a_finished_judge_are_killed() {
        let dir = TempDir::new().unwrap();
        let marker = dir.path().join("survived");
        let cmd = script(
            &dir,
            &format!(
                "cat >/dev/null\nsh -c 'sleep 1; touch {}' >/dev/null 2>&1 &\necho '{{\"verdict\":\"pass\"}}'",
                marker.display()
            ),
        );
        let verdict = run_judge(&config(cmd, 30), dir.path(), &request()).unwrap();
        assert_eq!(verdict.verdict, JudgeDecision::Pass);
        std::thread::sleep(Duration::from_secs(2));
        assert!(!marker.exists(), "a judge descendant outlived the judge");
    }
}
