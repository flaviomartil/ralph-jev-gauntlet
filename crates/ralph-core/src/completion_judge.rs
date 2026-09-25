use crate::config::CompletionJudgeConfig;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
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
    let mut child = command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn judge '{program}': {e}"))?;

    if let Some(mut stdin) = child.stdin.take()
        && let Err(e) = stdin.write_all(&payload)
        && e.kind() != std::io::ErrorKind::BrokenPipe
    {
        return Err(format!("failed to write judge stdin: {e}"));
    }

    let mut stdout = child.stdout.take().ok_or("judge stdout unavailable")?;
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });

    let deadline = Instant::now() + Duration::from_secs(config.timeout_seconds.max(1));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("judge timed out after {}s", config.timeout_seconds));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => return Err(format!("failed to wait for judge: {e}")),
        }
    };

    let output = reader.join().unwrap_or_default();
    if !status.success() {
        return Err(format!("judge exited with {status}"));
    }
    parse_verdict(&output)
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
        CompletionJudgeConfig {
            command: vec![command],
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
        assert!(err.contains("timed out"));
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
}
