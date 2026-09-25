# Troubleshooting

## Agent not found

`No supported AI backend found in PATH.` Install a builder CLI (Claude Code, Codex, Gemini CLI, Kiro, ...) and make sure it is on `PATH`, then run `ralph-jev-gauntlet doctor`. To use a specific one, set `cli.backend` in `ralph.yml`.

## Ambiguous routing

Two hats claim the same trigger. Keep the trigger on one hat, or have one hat publish a new event and let the other hat subscribe to that.

## Mutually exclusive fields

Two config fields that can't be used together are both set. Remove one of them, or split the setup into separate configs.

## Custom backend command

`cli.backend: custom` needs `cli.command`. Set it in `ralph.yml`, or generate a starting config with `ralph-jev-gauntlet init --backend custom`.

## Reserved trigger

`task.start` and `task.resume` are reserved for the loop coordinator. A hat must subscribe to a delegated event such as `work.start` instead.

## Missing hat description

Every hat needs a short `description` of its purpose. Add one to the hat definition.

## Robot config

The Telegram robot (`RObot`) section has an invalid or missing field. The error names the field and gives a hint; fix it or disable the robot. `ralph-jev-gauntlet bot --help` has the setup commands.

## Config file exists

`ralph-jev-gauntlet init` won't overwrite an existing `ralph.yml`. Pass `--force` to replace it.

## Unknown preset

Monolithic presets were replaced by split config. Generate core config with `ralph-jev-gauntlet init --backend <backend>`, pick a hat collection from `ralph-jev-gauntlet init --list-presets`, and run with `-H builtin:<collection>`.

## The judge rejects work that looks done

- Read the reason in the loop output or `ralph-jev-gauntlet events`. It names the gap and the next step.
- Jev can only see verification it has evidence for. Set `RALPH_JEV_VERIFY_CMD` so the judge runs your tests itself.
- Put acceptance criteria in the objective so the definition of done is explicit.

## The judge never runs

- Check that `event_loop.completion_judge.command` is set in the config that is actually loaded (`ralph-jev-gauntlet preflight` checks the loaded config).
- Judge failures are logged; with `fail_closed: false` they accept the completion. Look for `Completion judge` in the loop output.

## `TYPESAFE_API_KEY not configured`

Set the variable or add it to `~/.config/jev-browser-use/.env`. Until then the hooks skip and the judge fails open.

## `circuit open`

Jev returned a 429 or 5xx recently and calls are paused for `JEV_COOLDOWN_MS`. Wait, or remove `~/.cache/ralph-jev/circuit.json`.

## Hooks run in every project

Hooks in the user config apply to every loop you start with that binary, including test runs. Move them to the project's `ralph.yml`, or run with `RALPH_USER_CONFIG` pointing at a file that doesn't exist to load no user config.
