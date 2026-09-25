import { envNumber, loopObjective, noul, recentEvents, sh, taskCounts } from "./jev.mjs";

export const DIFFICULTY_LEVELS = [
  "A one-line fix or a trivial edit to a single file that the objective names.",
  "One self-contained change: a small feature or bug fix in a few known files.",
  "Several dependent steps across a handful of files: a feature, a bug traced from its symptom, or two parts of the system connected.",
  "The shape of the work has to be figured out first: a cross-cutting change, a design decision with trade-offs, or a problem whose cause is unknown.",
];

export const SUGGESTED_ITERATIONS = [5, 15, 40, 100];

export const MODES = {
  triage: {
    event: "pre.loop.start",
    questions: {
      difficulty: {
        type: "score",
        instructions: "Which situation best matches how much work `objective` requires in this repository?",
        criteria: DIFFICULTY_LEVELS,
      },
      ambiguous: {
        type: "noul",
        instructions:
          "Is `objective` missing a concrete, checkable definition of done, so that an agent could not tell from the text alone when the work is finished?",
      },
    },
    state: (payload, ws) => ({
      objective: loopObjective(ws).slice(0, 4000),
      max_iterations: payload.iteration?.max,
      repository_files: Number(sh(ws, "git", ["ls-files"]).split("\n").filter(Boolean).length),
    }),
    decide: (answers, state) => {
      const difficulty = answers?.difficulty?.score;
      const ambiguous = noul(answers, "ambiguous");
      const level = Number.isFinite(difficulty) ? Math.min(3, Math.max(0, Math.round(difficulty))) : null;
      const suggested = level === null ? null : SUGGESTED_ITERATIONS[level];
      const metadata = { difficulty, ambiguous, suggested_max_iterations: suggested };
      const warnings = [];
      if (suggested && state.max_iterations && state.max_iterations < suggested) {
        warnings.push(`max_iterations=${state.max_iterations} looks low for this objective (suggested ${suggested})`);
      }
      const blocking = ambiguous >= envNumber("RALPH_JEV_AMBIGUOUS_THRESHOLD", 0.7);
      if (blocking) warnings.push(`objective has no clear definition of done (ambiguous=${ambiguous.toFixed(2)}); add acceptance criteria`);
      return { metadata, warnings, blocking };
    },
  },
  progress: {
    event: "pre.iteration.start",
    skip: (payload) => (payload.iteration?.current ?? 0) < envNumber("RALPH_JEV_PROGRESS_MIN_ITERATION", 3),
    questions: {
      stalled: {
        type: "noul",
        instructions:
          "Do `recent_events` and `recent_commits` show the loop repeating the same step or the same failure without new commits, newly closed tasks or different outcomes?",
      },
    },
    state: (payload, ws) => ({
      objective: loopObjective(ws).slice(0, 2000),
      iteration: payload.iteration,
      recent_events: recentEvents(ws, 20),
      recent_commits: sh(ws, "git", ["log", "--oneline", "-10"]),
      uncommitted_changes: sh(ws, "git", ["status", "--short"]).slice(0, 1500),
      tasks: taskCounts(ws),
    }),
    decide: (answers) => {
      const stalled = noul(answers, "stalled");
      const blocking = stalled >= envNumber("RALPH_JEV_STALL_THRESHOLD", 0.75);
      return {
        metadata: { stalled },
        warnings: blocking ? [`loop looks stalled (stalled=${stalled.toFixed(2)}); change approach or ask for guidance`] : [],
        blocking,
      };
    },
  },
};
