/**
 * context-guard.ts — System prompt injection hook and git integration.
 *
 * Injects project context (STATE.md, planning artifacts, git status)
 * into the system prompt on every API call via `experimental.chat.system.transform`.
 *
 * Later units will add session tracking, obligations, tools, and lifecycle events.
 */

import { execSync } from "node:child_process";
import * as path from "node:path";

import type { Hooks, PluginInput } from "@opencode-ai/plugin";

import { readState, scanArtifacts } from "./state-reader.js";
import type { PluginConfig, StateFile } from "./state-reader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitStatus {
  branch: string;
  uncommitted: number;
  ahead: number;
  lastCommit: string; // "message (relative time)"
}

interface GitCache {
  status: GitStatus;
  timestamp: number;
}

/** Return shape of `createContextGuard`. Tools added in Unit 5. */
export interface ContextGuardResult {
  hooks: Pick<Hooks, "experimental.chat.system.transform">;
  event: NonNullable<Hooks["event"]>;
}

// ---------------------------------------------------------------------------
// Relative time formatting
// ---------------------------------------------------------------------------

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Format a Date or epoch-ms as a human-readable relative time string. */
export function formatRelativeTime(date: Date | number): string {
  const ms = typeof date === "number" ? date : date.getTime();
  const elapsed = Date.now() - ms;

  if (elapsed < MINUTE) return "just now";

  if (elapsed < HOUR) {
    const n = Math.floor(elapsed / MINUTE);
    return n === 1 ? "1 minute ago" : `${n} minutes ago`;
  }

  if (elapsed < DAY) {
    const n = Math.floor(elapsed / HOUR);
    return n === 1 ? "1 hour ago" : `${n} hours ago`;
  }

  if (elapsed < WEEK) {
    const n = Math.floor(elapsed / DAY);
    return n === 1 ? "1 day ago" : `${n} days ago`;
  }

  if (elapsed < MONTH) {
    const n = Math.floor(elapsed / WEEK);
    return n === 1 ? "1 week ago" : `${n} weeks ago`;
  }

  if (elapsed < YEAR) {
    const n = Math.floor(elapsed / MONTH);
    return n === 1 ? "1 month ago" : `${n} months ago`;
  }

  const n = Math.floor(elapsed / YEAR);
  return n === 1 ? "1 year ago" : `${n} years ago`;
}

// ---------------------------------------------------------------------------
// Git integration
// ---------------------------------------------------------------------------

/**
 * Run `git status --branch --porcelain` and `git log -1` together,
 * parse the results into a structured GitStatus.
 *
 * Returns null if git fails (not a git repo, git not installed, etc.).
 */
function fetchGitStatus(repoRoot: string): GitStatus | null {
  try {
    const statusOutput = execSync("git status --branch --porcelain", {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse first line: ## main...origin/main [ahead 2]
    const lines = statusOutput.split("\n");
    const branchLine = lines[0] ?? "";

    let branch = "unknown";
    let ahead = 0;

    if (branchLine.startsWith("## ")) {
      const rest = branchLine.slice(3);
      // Branch name is between "## " and "..." (or end/space if no tracking)
      const dotsIndex = rest.indexOf("...");
      if (dotsIndex !== -1) {
        branch = rest.slice(0, dotsIndex);
      } else {
        // No tracking info — branch name may be followed by space or end of line
        const spaceIndex = rest.indexOf(" ");
        branch = spaceIndex !== -1 ? rest.slice(0, spaceIndex) : rest;
      }

      // Ahead count: [ahead N] anywhere in the line
      const aheadMatch = /\[ahead (\d+)/.exec(rest);
      if (aheadMatch?.[1]) {
        ahead = parseInt(aheadMatch[1], 10);
      }
    }

    // Uncommitted count: non-empty lines after the first
    const uncommitted = lines.slice(1).filter((l) => l.trim() !== "").length;

    // Last commit message
    let lastCommit = "";
    try {
      lastCommit = execSync('git log -1 --format="%s (%cr)"', {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      // No commits yet or other error — leave empty
    }

    return { branch, uncommitted, ahead, lastCommit };
  } catch {
    // Not a git repo, git not installed, etc.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the context guard hook handlers.
 *
 * @param ctx - Plugin context from the `init` callback.
 * @param repoRoot - Absolute path to the repository root.
 * @param config - Resolved plugin configuration.
 */
export function createContextGuard(
  _ctx: PluginInput,
  repoRoot: string,
  config: PluginConfig,
): ContextGuardResult {
  // -----------------------------------------------------------------------
  // Git cache — shared across sessions (git status is repo state)
  // -----------------------------------------------------------------------
  let gitCache: GitCache | null = null;

  function getGitStatus(): GitStatus | null {
    const now = Date.now();
    if (gitCache !== null && now - gitCache.timestamp < config.gitCacheTtlMs) {
      return gitCache.status;
    }

    const status = fetchGitStatus(repoRoot);
    if (status !== null) {
      gitCache = { status, timestamp: now };
    } else {
      gitCache = null;
    }
    return status;
  }

  // -----------------------------------------------------------------------
  // System prompt builder
  // -----------------------------------------------------------------------

  function buildSystemPrompt(): string {
    const projectName = path.basename(repoRoot);
    const lines: string[] = [
      "## Context Guard",
      `Project: ${projectName} (${repoRoot})`,
    ];

    const state = readState(repoRoot, config);

    // Focus — always shown
    if (state !== null) {
      lines.push(`focus: ${state.current.focus || "No focus set"}`);
    } else {
      lines.push("focus: No STATE.md \u2014 create one to track project state");
    }

    // Optional Current fields — omit if not present
    if (state !== null) {
      const c = state.current;
      if (c.phase !== undefined) {
        lines.push(`phase: ${c.phase}`);
      }
      if (c.blockers !== undefined && c.blockers.toLowerCase() !== "none") {
        lines.push(`blockers: ${c.blockers}`);
      }
      if (c.next !== undefined) {
        lines.push(`next: ${c.next}`);
      }
      if (c.handoff !== undefined) {
        lines.push(`handoff: ${c.handoff}`);
      }
    }

    // State updated — relative time since mtime
    if (state !== null) {
      lines.push(`State updated: ${formatRelativeTime(state.mtime)}`);
    }

    // Decisions — count locked vs rejected
    if (state !== null && state.decisions.length > 0) {
      const rejected = state.decisions.filter((d) =>
        d.toLowerCase().includes("[rejected]"),
      ).length;
      const locked = state.decisions.length - rejected;
      lines.push(`Decisions: ${locked} locked, ${rejected} rejected`);
    }

    // Task — artifact presence
    buildTaskLine(state, lines);

    // Git status
    const git = getGitStatus();
    if (git !== null) {
      let gitLine = `Git: ${git.branch}, ${git.uncommitted} uncommitted, ${git.ahead} ahead`;
      if (git.lastCommit) {
        gitLine += `. Last: "${git.lastCommit}"`;
      }
      lines.push(gitLine);
    }

    return lines.join("\n");
  }

  /**
   * Build the Task line showing standard artifact presence.
   * Only added if STATE.md has a `task` field pointing to a folder.
   */
  function buildTaskLine(state: StateFile | null, lines: string[]): void {
    if (state === null || state.current.task === undefined) return;

    const taskFolder = state.current.task;
    const folderName = path.basename(taskFolder);
    const artifacts = scanArtifacts(taskFolder, config);

    // Build a Set of artifact names for quick lookup
    const present = new Set(artifacts.map((a) => a.name));

    const standardArtifacts = [
      "goal.md",
      "anchor.md",
      "plan.md",
      "summary.md",
      "backtrack.md",
    ] as const;

    const markers = standardArtifacts
      .map((name) => `${name} ${present.has(name) ? "\u2713" : "\u2717"}`)
      .join(", ");

    lines.push(`Task: ${folderName} \u2014 ${markers}`);
  }

  // -----------------------------------------------------------------------
  // Hooks
  // -----------------------------------------------------------------------

  const chatSystemTransform: Hooks["experimental.chat.system.transform"] =
    async (_input, output) => {
      if (!output.system) return;
      output.system.push(buildSystemPrompt());
    };

  // -----------------------------------------------------------------------
  // Return
  // -----------------------------------------------------------------------

  return {
    hooks: {
      "experimental.chat.system.transform": chatSystemTransform,
    },
    event: async () => {
      // Empty for now — session lifecycle events added in later units
    },
  };
}
