# Testing

```bash
node --test jev/test/*.test.mjs
cargo test -p ralph-core completion_judge
cargo test -p ralph-cli --bin ralph write_objective_marker
cargo test -p ralph-cli --bin ralph config_resolution
```

The Node suite covers the judge, the gauntlet runner, the hooks and the Jev client:

- **Tables** for known edge cases.
- **Seeded property tests** checked against an independent oracle.
- **Fuzz tests** on random and corrupted input: parsers never crash and only return well-formed results.
- **Metamorphic tests**: swapping the A/B labels never changes a verdict, and entry order and wording don't matter, and more evidence never makes a verdict worse.
- **Process tests** that run the real CLIs against a local fake Jev server and check exit codes, stdout contracts, circuit breaker behavior and the objective each hook reads in a worktree loop.
- **Git end-to-end tests** with a scripted critic: snapshots, blind copies, champion promotion, cleanup, concurrent runs, unusual file names, and an untouched workspace and index.

Rust tests cover the completion gate (verdict parsing, timeouts, process groups, output limits), the objective marker and the user config override.

## Isolation

Your user config applies to test runs too, including CLI integration tests that start `ralph` with your real home directory (tests that set their own `HOME` clear `RALPH_USER_CONFIG`). Point `RALPH_USER_CONFIG` at a file that doesn't exist to run the full suite without it:

```bash
RALPH_USER_CONFIG=/nonexistent cargo test --workspace
```

Keep `TMPDIR` on a Linux filesystem. Some tests rely on Unix permissions and executable bits, which Windows drives mounted in WSL don't support.
