# Gauntlet gate

![Gauntlet gate](../architecture/gauntlet.png)

[Open the interactive diagram](../architecture/gauntlet.html)

An agent that grades its own work almost always passes, and numeric scores from a model creep upward every round. The gauntlet gate removes both problems: the builder and the critic are different agents, and the critic compares attempts blind instead of giving a score.

## 1. Requirements

The judge takes the requirements from the first of these that it finds:

1. Bullets in `.ralph/gauntlet/criteria.md`.
2. An `Acceptance criteria`, `Definition of done` or `Requirements` section in the objective.
3. Checkboxes in the objective.
4. The whole objective as a single requirement.

## 2. Jev screen

The judge collects evidence (see [Judge evidence](judge-evidence.md)) and asks Jev one yes/no question per requirement, plus whether the work was verified:

| Question | Threshold | Env var |
|---|---|---|
| `c1`..`cN`: is requirement N met? | 0.5 each | `RALPH_JEV_CRITERION_THRESHOLD` |
| `verified`: did tests or a build actually run and pass? | 0.5 | `RALPH_JEV_VERIFIED_THRESHOLD` |

Any answer below its threshold rejects the attempt right away, naming the failing requirements. The critic does not run. If Jev is unreachable, the judge skips this step and goes straight to the critic.

## 3. Blind critique

1. The judge snapshots the workspace, including uncommitted and untracked files, without touching your index or branch. Untracked files that look like secrets are left out.
2. The snapshot and the champion (the best attempt so far, stored under `refs/gauntlet/`, one per loop and set of requirements) are exported with `git archive` into plain directories labeled `A` and `B` at random. The copies have no `.git` and no `.ralph`, and both use the same fixed author and date.
3. A fresh critic (`claude` or `codex`) gets the requirements and both directories. It runs the checks and replies with a pass or fail per requirement, a `pick` and a list of defects. Its verdict JSON must be the last thing it prints.
4. When `.ralph/gauntlet/bar.md` exists, the critic also has to beat that reference.

## 4. Verdict

- **pass**: every requirement passes, the attempt wins the blind pick (or there is no champion yet), and it beats the bar when one is set.
- **fail**: the failing requirements and defects go back to the builder as `task.resume`.

Whenever the attempt wins the pick, it becomes the new champion with a compare-and-swap, even if it still fails some requirements. Every later attempt has to beat it, so the loop can't quietly regress. The temporary copies are removed after every run, and on `SIGTERM`.

## Critic isolation

The critic runs non-interactively inside the throwaway copies (`claude -p --permission-mode bypassPermissions` or `codex exec -s workspace-write`) so it can run your tests. It is told not to edit source files, and your working tree is never touched. It runs without secret-looking environment variables, except the login of the critic that is running and anything in `RALPH_GAUNTLET_CRITIC_ENV_KEEP`. It still runs as your user, so treat it like any other agent you allow to run commands.
