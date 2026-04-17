import { register } from "../router.js";
import * as core from "../../core/morning.js";

register("brief", {
  description:
    "Run your morning brief — scan watchlist, read indicators, apply your rules",
  options: {
    rules: {
      type: "string",
      short: "r",
      description: "Path to rules.json (default: ./rules.json)",
    },
    "signals-only": {
      type: "boolean",
      description: "Return only symbols with an active signal",
    },
    "changed-only": {
      type: "boolean",
      description: "Only return signals that changed since the baseline file",
    },
    "update-baseline": {
      type: "boolean",
      description: "Persist the latest scan state to the baseline file",
    },
  },
  handler: async (opts) =>
    core.runBrief({
      rules_path: opts.rules,
      signals_only: opts["signals-only"],
      changed_only: opts["changed-only"],
      update_baseline: opts["update-baseline"],
    }),
});

register("signals", {
  description: "Run the signal-only market-hours scan for automation",
  options: {
    rules: {
      type: "string",
      short: "r",
      description: "Path to rules.json (default: ./rules.json)",
    },
    notify: {
      type: "boolean",
      description: "Send ntfy notification when signals are found",
    },
    all: {
      type: "boolean",
      description: "Return all active signals instead of only changed ones",
    },
  },
  handler: async (opts) =>
    core.runSignalJob({
      rules_path: opts.rules,
      changed_only: !opts.all,
      notify: opts.notify,
    }),
});

register("session", {
  description: "Get or save a session brief",
  subcommands: new Map([
    [
      "get",
      {
        description:
          "Get today's saved session brief (or yesterday's if today not found)",
        options: {
          date: {
            type: "string",
            description: "Date YYYY-MM-DD (default: today)",
          },
        },
        handler: async ({ date }) => core.getSession({ date }),
      },
    ],
    [
      "save",
      {
        description: "Save a session brief to disk",
        options: {
          brief: {
            type: "string",
            short: "b",
            description: "Brief text to save",
          },
          date: {
            type: "string",
            description: "Date YYYY-MM-DD (default: today)",
          },
        },
        handler: async ({ brief, date }) => {
          if (!brief) throw new Error("--brief is required");
          return core.saveSession({ brief, date });
        },
      },
    ],
  ]),
});
