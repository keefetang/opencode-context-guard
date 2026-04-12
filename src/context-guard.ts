/**
 * context-guard.ts — System prompt injection hook, git integration, and session tracking.
 *
 * Injects project context (STATE.md, planning artifacts, git status, session info,
 * obligations) into the system prompt on every API call via
 * `experimental.chat.system.transform`.
 *
 * Tracks per-session state (tool calls, file modifications) via `tool.execute.after`.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { tool, type Hooks, type PluginInput, type ToolContext, type ToolDefinition } from "@opencode-ai/plugin";

import {
  appendToSection,
  invalidateStateCache,
  readState,
  scanArtifacts,
  writeCurrentSection,
} from "./state-reader.js";
import type { CurrentSection, PluginConfig, StateFile } from "./state-reader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GitStatus {
  branch: string;
  uncommitted: number;
  ahead: number;
  lastCommitHash: string; // short hash for change detection
  lastCommit: string; // "message (relative time)" for display
}

interface GitCache {
  status: GitStatus;
  timestamp: number;
}

interface SessionState {
  id: string;
  startTime: number;
  lastActivityTime: number;
  toolCallCount: number;
  filesModified: boolean;
  isFirstTurn: boolean;
  stateAtSessionStart: number | null; // STATE.md mtime at session creation, null if no STATE.md
  lastSeenStateMtime: number | null; // mtime of STATE.md as of last turn
  lastSeenAgentsMtime: number | null; // mtime of AGENTS.md as of last turn
}

/** Return shape of `createContextGuard`. */
export interface ContextGuardResult {
  hooks: Pick<Hooks, "experimental.chat.system.transform" | "experimental.session.compacting" | "tool.execute.after">;
  tools: Record<string, ToolDefinition>;
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
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve `~/` prefix to the user's home directory. */
function resolveTilde(filePath: string): string {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// File size formatting
// ---------------------------------------------------------------------------

/** Format a byte count as a human-readable string (e.g. "1.2 KB"). */
function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

/** Format current local time as `[YYYY-MM-DD HH:MM]` for log entries. */
function formatTimestamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `[${date} ${time}]`;
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

    // Last commit — hash for change detection, message+time for display
    let lastCommitHash = "";
    let lastCommit = "";
    try {
      lastCommitHash = execSync("git log -1 --format=%h", {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      lastCommit = execSync('git log -1 --format="%s (%cr)"', {
        cwd: repoRoot,
        encoding: "utf-8",
        timeout: 5_000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      // No commits yet or other error — leave empty
    }

    return { branch, uncommitted, ahead, lastCommitHash, lastCommit };
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
  // Session tracking — per-session state via Map (closure-scoped)
  // -----------------------------------------------------------------------
  const sessions = new Map<string, SessionState>();

  /** Get the current STATE.md mtime, or null if the file doesn't exist. */
  function getStateMtime(): number | null {
    try {
      const stat = fs.statSync(path.join(repoRoot, config.stateFileName));
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  /** Get the current AGENTS.md mtime, or null if the file doesn't exist. */
  function getAgentsMtime(): number | null {
    try {
      const stat = fs.statSync(path.join(repoRoot, config.agentsMdFileName));
      return stat.mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Get or create a SessionState for the given sessionID.
   * On creation, records the current STATE.md mtime for obligation tracking.
   * Sweeps stale entries when the Map grows beyond 50 to prevent memory leaks.
   */
  function getOrCreateSession(sessionID: string): SessionState {
    const existing = sessions.get(sessionID);
    if (existing !== undefined) return existing;

    // Sweep inactive entries — safety net for abandoned sessions.
    // Primary cleanup is session.idle (Unit 5); this prevents unbounded growth.
    // Uses lastActivityTime so active long-running sessions are preserved.
    if (sessions.size > 50) {
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1_000;
      for (const [id, session] of sessions) {
        if (session.lastActivityTime < fiveMinutesAgo) {
          sessions.delete(id);
        }
      }
    }

    const now = Date.now();
    const session: SessionState = {
      id: sessionID,
      startTime: now,
      lastActivityTime: now,
      toolCallCount: 0,
      filesModified: false,
      isFirstTurn: true,
      stateAtSessionStart: getStateMtime(),
      lastSeenStateMtime: null, // initialized after first buildSystemPrompt
      lastSeenAgentsMtime: null, // initialized after first buildSystemPrompt
    };
    sessions.set(sessionID, session);
    return session;
  }

  // -----------------------------------------------------------------------
  // Git cache — shared across sessions (git status is repo state)
  // -----------------------------------------------------------------------
  let gitCache: GitCache | null = null;

  /** Strip trailing ` (relative time)` from git log format `"%s (%cr)"`. */
  function extractCommitMessage(logLine: string): string {
    const match = /^(.+)\s+\([^)]+\)$/.exec(logLine);
    return match?.[1] ?? logLine;
  }

  function getGitStatus(): GitStatus | null {
    const now = Date.now();
    if (gitCache !== null && now - gitCache.timestamp < config.gitCacheTtlMs) {
      return gitCache.status;
    }

    const previousHash = gitCache?.status.lastCommitHash ?? "";
    const status = fetchGitStatus(repoRoot);
    if (status !== null) {
      gitCache = { status, timestamp: now };

      // Detect new commits — compare short hashes for reliable change detection.
      // Hashes are stable (unlike commit messages which could be identical across commits).
      // Skip the first cache fill (previousHash === "") to avoid false positives.
      if (
        previousHash !== "" &&
        status.lastCommitHash !== "" &&
        status.lastCommitHash !== previousHash
      ) {
        const message = extractCommitMessage(status.lastCommit);
        appendToSection(
          repoRoot,
          config,
          "log",
          `[auto] ${formatTimestamp()} Committed: "${message}"`,
        );
      }
    } else {
      gitCache = null;
    }
    return status;
  }

  // -----------------------------------------------------------------------
  // System prompt builder
  // -----------------------------------------------------------------------

  function buildSystemPrompt(session: SessionState | null): string {
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

    // Session line
    if (session !== null) {
      const elapsedMs = Date.now() - session.startTime;
      const elapsedMin = Math.floor(elapsedMs / 60_000);
      const durationStr = elapsedMin < 1 ? "< 1 min" : `${elapsedMin} min`;
      let sessionLine = `Session: ${durationStr}, ${session.toolCallCount} tool calls`;
      if (session.filesModified) {
        sessionLine += ", files modified";
      }
      lines.push(sessionLine);
    }

    // Obligations
    const obligations = buildObligations(session, state, git);
    if (obligations.length > 0) {
      lines.push(`Obligations: ${obligations.join(", ")}`);
    }

    // First-turn reminder + inter-session resumption warning
    if (session !== null && session.isFirstTurn) {
      // Check if last session ended without explicit checkpoint
      if (state !== null && state.log.length > 0) {
        const lastLog = state.log[state.log.length - 1];
        if (lastLog !== undefined && lastLog.includes("[auto]")) {
          lines.push("");
          lines.push(
            "\u26a0 Last session ended without an explicit checkpoint. Verify state before building on it.",
          );
        }
      }
      lines.push("");
      lines.push(
        "Note: Read repo AGENTS.md for project conventions before making changes.",
      );
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

  /**
   * Detect actionable obligations based on session state, STATE.md, and git status.
   * Returns an array of human-readable obligation strings.
   */
  function buildObligations(
    session: SessionState | null,
    state: StateFile | null,
    git: GitStatus | null,
  ): string[] {
    const obligations: string[] = [];

    // STATE.md needs checkpoint: files changed this session, but STATE.md mtime
    // hasn't changed since session start. Missing STATE.md is already shown in
    // the focus line — don't duplicate it as an obligation.
    if (session !== null && state !== null && session.filesModified) {
      const currentStateMtime = getStateMtime();
      if (
        currentStateMtime !== null &&
        session.stateAtSessionStart !== null &&
        currentStateMtime === session.stateAtSessionStart
      ) {
        obligations.push(
          "STATE.md needs checkpoint (files changed since last update)",
        );
      }
    }

    // Uncommitted changes
    if (git !== null && git.uncommitted > 0) {
      obligations.push(`${git.uncommitted} uncommitted files`);
    }

    // Ahead of remote
    if (git !== null && git.ahead > 0) {
      obligations.push(`${git.ahead} commits not pushed`);
    }

    return obligations;
  }

  // -----------------------------------------------------------------------
  // Hooks
  // -----------------------------------------------------------------------

  const chatSystemTransform: Hooks["experimental.chat.system.transform"] =
    async (input, output) => {
      if (!output.system) return;
      const session =
        input.sessionID !== undefined
          ? getOrCreateSession(input.sessionID)
          : null;

      // External change detection — compare current mtimes to last-seen values.
      // Skip on first turn (lastSeen is null) — it's not an "external change".
      if (session !== null && !session.isFirstTurn) {
        const currentStateMtime = getStateMtime();
        if (
          session.lastSeenStateMtime !== null &&
          currentStateMtime !== null &&
          currentStateMtime !== session.lastSeenStateMtime
        ) {
          output.system.push(
            `\u26a0 ${config.stateFileName} was updated externally since your last turn.`,
          );
        }

        const currentAgentsMtime = getAgentsMtime();
        if (
          session.lastSeenAgentsMtime !== null &&
          currentAgentsMtime !== null &&
          currentAgentsMtime !== session.lastSeenAgentsMtime
        ) {
          output.system.push(
            `\u26a0 ${config.agentsMdFileName} was updated externally since your last turn.`,
          );
        }
      }

      output.system.push(buildSystemPrompt(session));

      // Update last-seen mtimes after building the prompt
      if (session !== null) {
        session.lastSeenStateMtime = getStateMtime();
        session.lastSeenAgentsMtime = getAgentsMtime();
      }

      // Clear first-turn flag after prompt is built — keeps buildSystemPrompt pure
      if (session !== null && session.isFirstTurn) {
        session.isFirstTurn = false;
      }
    };

  const toolExecuteAfter: Hooks["tool.execute.after"] = async (input) => {
    const session = getOrCreateSession(input.sessionID);
    session.toolCallCount++;
    session.lastActivityTime = Date.now();
    if (input.tool === "edit" || input.tool === "write") {
      session.filesModified = true;
    }
  };

  // -----------------------------------------------------------------------
  // Pre-compaction hook — inject project state into compaction context
  // -----------------------------------------------------------------------

  const sessionCompacting: Hooks["experimental.session.compacting"] = async (
    input,
    output,
  ) => {
    const session = sessions.get(input.sessionID);

    // Auto-append log entry if files were modified but no explicit checkpoint
    if (session !== undefined && session.filesModified) {
      const currentStateMtime = getStateMtime();
      if (
        session.stateAtSessionStart !== null &&
        currentStateMtime !== null &&
        currentStateMtime === session.stateAtSessionStart
      ) {
        appendToSection(
          repoRoot,
          config,
          "log",
          `[auto] ${formatTimestamp()} Session compacted. ${session.toolCallCount} tool calls. No explicit checkpoint.`,
        );
        // Update lastSeenStateMtime so the next turn doesn't fire a false
        // "updated externally" warning for the write the plugin just made.
        session.lastSeenStateMtime = getStateMtime();
      }
    }

    // Inject full STATE.md into compaction context
    const state = readState(repoRoot, config);
    if (state !== null) {
      const taskLine =
        state.current.task !== undefined
          ? `Active task: ${state.current.task}`
          : "No active task.";

      output.context.push(
        `## Project State at Compaction\n${state.raw}\n${taskLine}\nPreserve: current focus, locked decisions, active blockers, what comes next.`,
      );
    } else {
      output.context.push(
        `## Project State at Compaction\nNo STATE.md found. Project state is not being tracked.\nPreserve any project context mentioned in the conversation.`,
      );
    }
  };

  // -----------------------------------------------------------------------
  // Tools
  // -----------------------------------------------------------------------

  const z = tool.schema;

  const contextCheckpoint = tool({
    description:
      "Update the Current section of STATE.md. Call after significant work, decisions, or before ending a session.",
    args: {
      focus: z.string().describe("What the project is focused on right now"),
      phase: z
        .enum(["planning", "implementing", "testing", "reviewing", "shipping"])
        .optional()
        .describe("Current phase"),
      task: z.string().optional().describe("Path to the active task folder"),
      blockers: z
        .string()
        .optional()
        .describe('Current blockers, or "none"'),
      next: z
        .string()
        .optional()
        .describe("What the next session should do"),
      handoff: z
        .string()
        .optional()
        .describe("Who should continue and where to start"),
    },
    async execute(args, context: ToolContext): Promise<string> {
      const current: CurrentSection = { focus: args.focus };
      if (args.phase !== undefined) current.phase = args.phase;
      if (args.task !== undefined) current.task = args.task;
      if (args.blockers !== undefined) current.blockers = args.blockers;
      if (args.next !== undefined) current.next = args.next;
      if (args.handoff !== undefined) current.handoff = args.handoff;

      // writeCurrentSection writes + invalidates cache; appendToSection re-reads
      // from disk (seeing the just-written Current section) then appends the log entry.
      writeCurrentSection(repoRoot, config, current);
      appendToSection(
        repoRoot,
        config,
        "log",
        `${formatTimestamp()} Checkpoint: ${args.focus}`,
      );

      // Clear checkpoint obligation and suppress false external-change warning next turn.
      // writeCurrentSection + appendToSection changed STATE.md mtime. If we don't update
      // lastSeenStateMtime now, the next system.transform will see the mtime change and
      // incorrectly warn "updated externally".
      const session = sessions.get(context.sessionID);
      if (session !== undefined) {
        const newMtime = getStateMtime();
        session.stateAtSessionStart = newMtime;
        session.lastSeenStateMtime = newMtime;
        session.filesModified = false;
      }

      return `STATE.md updated. Focus: ${args.focus}`;
    },
  });

  const contextLoad = tool({
    description:
      "Load planning artifacts for a task. Returns a summary of all artifacts in the folder.",
    args: {
      task_folder: z
        .string()
        .describe("Path to the task folder containing planning artifacts"),
    },
    async execute(args): Promise<string> {
      // Resolve ~/ once — scanArtifacts resolves internally, but we need
      // the resolved path to read file contents.
      const resolved = resolveTilde(args.task_folder);
      const artifacts = scanArtifacts(args.task_folder, config);

      if (artifacts.length === 0) {
        // Distinguish between missing folder and empty folder
        try {
          fs.statSync(resolved);
          return `No .md artifacts found in ${path.basename(args.task_folder)}`;
        } catch {
          return `Folder not found: ${args.task_folder}`;
        }
      }

      const sections: string[] = [];
      const maxPreviewLines = 10;

      for (const artifact of artifacts) {
        const filePath = path.join(resolved, artifact.name);

        let preview = "";
        try {
          const content = fs.readFileSync(filePath, "utf-8");
          const allLines = content.split("\n");
          const previewLines = allLines.slice(0, maxPreviewLines);
          preview = previewLines.join("\n");
          if (allLines.length > maxPreviewLines) {
            preview += `\n... (${allLines.length} lines total)`;
          }
        } catch {
          preview = "(unable to read file)";
        }

        const sizeStr = formatFileSize(artifact.size);
        const relTime = formatRelativeTime(artifact.mtime);

        sections.push(`## ${artifact.name} (${sizeStr}, updated ${relTime})\n${preview}`);
      }

      const folderName = path.basename(args.task_folder);
      sections.push(
        `\n${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} found in ${folderName}`,
      );

      return sections.join("\n\n");
    },
  });

  const contextDiscover = tool({
    description: "Append a finding, decision, or note to STATE.md or a file.",
    args: {
      content: z.string().describe("What to save"),
      target: z
        .string()
        .optional()
        .describe(
          'Where to save: "log" (default), "decisions", or a file path',
        ),
    },
    async execute(args, context: ToolContext): Promise<string> {
      const target = args.target ?? "log";

      if (target === "log") {
        appendToSection(
          repoRoot,
          config,
          "log",
          `${formatTimestamp()} ${args.content}`,
        );
        // Suppress false external-change warning on next turn (same as context_checkpoint)
        const session = sessions.get(context.sessionID);
        if (session !== undefined) {
          const newMtime = getStateMtime();
          session.lastSeenStateMtime = newMtime;
          session.stateAtSessionStart = newMtime;
        }
        return `Saved to STATE.md Log: ${args.content}`;
      }

      if (target === "decisions") {
        appendToSection(
          repoRoot,
          config,
          "decisions",
          `${args.content} [${new Date().toISOString().slice(0, 10)}]`,
        );
        // Suppress false external-change warning on next turn (same as context_checkpoint)
        const session = sessions.get(context.sessionID);
        if (session !== undefined) {
          const newMtime = getStateMtime();
          session.lastSeenStateMtime = newMtime;
          session.stateAtSessionStart = newMtime;
        }
        return `Saved to STATE.md Decisions: ${args.content}`;
      }

      // Arbitrary file path
      try {
        const timestamp = formatTimestamp();
        fs.appendFileSync(target, `\n${timestamp} ${args.content}\n`, "utf-8");
        return `Appended to ${target}`;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return `Failed to append to ${target}: ${msg}`;
      }
    },
  });

  // -----------------------------------------------------------------------
  // Return
  // -----------------------------------------------------------------------

  return {
    hooks: {
      "experimental.chat.system.transform": chatSystemTransform,
      "experimental.session.compacting": sessionCompacting,
      "tool.execute.after": toolExecuteAfter,
    },
    tools: {
      context_checkpoint: contextCheckpoint,
      context_load: contextLoad,
      context_discover: contextDiscover,
    },
    event: async (input) => {
      if (input.event.type !== "session.idle") return;
      const sessionID = input.event.properties.sessionID;
      const session = sessions.get(sessionID);

      if (session !== undefined) {
        // Auto-append log entry if files were modified but no explicit checkpoint
        if (session.filesModified) {
          const currentStateMtime = getStateMtime();
          if (
            session.stateAtSessionStart !== null &&
            currentStateMtime !== null &&
            currentStateMtime === session.stateAtSessionStart
          ) {
            appendToSection(
              repoRoot,
              config,
              "log",
              `[auto] ${formatTimestamp()} Session ended. ${session.toolCallCount} tool calls. No explicit checkpoint.`,
            );
          }
          // If STATE.md WAS updated (mtime changed since session start): do nothing
        }

        // Cleanup — remove session from Map
        sessions.delete(sessionID);
      }
    },
  };
}
