/**
 * state-reader.ts — Parse, cache, read, write STATE.md + artifact scanning.
 *
 * Focused module. No side effects beyond filesystem I/O.
 * All caching is module-scoped — shared across sessions (STATE.md is repo state, not session state).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CurrentSection {
  focus: string;
  phase?: string;
  task?: string;
  blockers?: string;
  next?: string;
  handoff?: string;
}

export interface StateFile {
  current: CurrentSection;
  decisions: string[]; // raw lines (including leading "- ")
  log: string[]; // raw lines (including leading "- ")
  raw: string; // full file content
  mtime: number; // epoch ms, for cache invalidation
}

export interface ArtifactInfo {
  name: string; // e.g. "goal.md"
  size: number; // bytes
  mtime: Date;
}

export interface PluginConfig {
  stateFileName: string; // default: "STATE.md"
  plansDir: string; // default: "~/.config/opencode/plans"
  agentsMdFileName: string; // default: "AGENTS.md"
  gitCacheTtlMs: number; // default: 30_000
  artifactCacheTtlMs: number; // default: 30_000
  maxLogEntries: number; // default: 30 — trim Log section to this many entries on write
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: PluginConfig = {
  stateFileName: "STATE.md",
  plansDir: path.join(os.homedir(), ".config", "opencode", "plans"),
  agentsMdFileName: "AGENTS.md",
  gitCacheTtlMs: 30_000,
  artifactCacheTtlMs: 30_000,
  maxLogEntries: 30,
};

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Resolve `~/` prefix to the user's home directory. */
export function resolveTilde(filePath: string): string {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/** Merge user overrides with defaults. */
export function resolveConfig(overrides?: Partial<PluginConfig>): PluginConfig {
  if (!overrides) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...overrides };
}

// ---------------------------------------------------------------------------
// STATE.md parsing
// ---------------------------------------------------------------------------

/** Parse STATE.md content into structured sections. */
export function parseStateFile(content: string): Omit<StateFile, "mtime"> {
  const current: CurrentSection = { focus: "" };
  const decisions: string[] = [];
  const log: string[] = [];

  let activeSection: "current" | "decisions" | "log" | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    // Section headers
    if (trimmed === "## Current") {
      activeSection = "current";
      continue;
    }
    if (trimmed === "## Decisions") {
      activeSection = "decisions";
      continue;
    }
    if (trimmed === "## Log") {
      activeSection = "log";
      continue;
    }
    // Stop on any other H2 (future-proofing)
    if (trimmed.startsWith("## ")) {
      activeSection = null;
      continue;
    }

    // Skip empty lines and the H1 header
    if (trimmed === "" || trimmed === "# State") continue;

    switch (activeSection) {
      case "current": {
        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) break;
        const key = line.slice(0, colonIndex).trim().toLowerCase();
        const value = line.slice(colonIndex + 1).trim();
        switch (key) {
          case "focus":
            current.focus = value;
            break;
          case "phase":
            current.phase = value;
            break;
          case "task":
            current.task = value;
            break;
          case "blockers":
            current.blockers = value;
            break;
          case "next":
            current.next = value;
            break;
          case "handoff":
            current.handoff = value;
            break;
        }
        break;
      }
      case "decisions":
        if (trimmed.startsWith("- ")) {
          decisions.push(trimmed);
        }
        break;
      case "log":
        if (trimmed.startsWith("- ")) {
          log.push(trimmed);
        }
        break;
    }
  }

  return { current, decisions, log, raw: content };
}

// ---------------------------------------------------------------------------
// STATE.md cache
// ---------------------------------------------------------------------------

let stateCache: (StateFile & { filePath: string }) | null = null;

/** Force re-read on next access. */
export function invalidateStateCache(): void {
  stateCache = null;
}

/** Read + parse STATE.md with mtime-based cache invalidation. Returns null if file doesn't exist. */
export function readState(repoRoot: string, config: PluginConfig): StateFile | null {
  const filePath = path.join(repoRoot, config.stateFileName);

  try {
    const stat = fs.statSync(filePath);
    const mtimeMs = stat.mtimeMs;

    // Cache hit — same file path and mtime unchanged
    if (stateCache !== null && stateCache.filePath === filePath && stateCache.mtime === mtimeMs) {
      return stateCache;
    }

    // Cache miss or stale — re-read
    const content = fs.readFileSync(filePath, "utf-8");
    const parsed = parseStateFile(content);
    stateCache = { ...parsed, mtime: mtimeMs, filePath };
    return stateCache;
  } catch {
    // File doesn't exist or unreadable
    stateCache = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// STATE.md writing
// ---------------------------------------------------------------------------

/** Build the full STATE.md content string from sections. */
function buildStateContent(current: CurrentSection, decisions: string[], log: string[]): string {
  const lines: string[] = ["# State", "", "## Current"];

  // Always write focus first
  lines.push(`focus: ${current.focus}`);
  if (current.phase !== undefined) lines.push(`phase: ${current.phase}`);
  if (current.task !== undefined) lines.push(`task: ${current.task}`);
  if (current.blockers !== undefined) lines.push(`blockers: ${current.blockers}`);
  if (current.next !== undefined) lines.push(`next: ${current.next}`);
  if (current.handoff !== undefined) lines.push(`handoff: ${current.handoff}`);

  lines.push("", "## Decisions");
  for (const d of decisions) lines.push(d);

  lines.push("", "## Log");
  for (const l of log) lines.push(l);

  // Trailing newline
  lines.push("");
  return lines.join("\n");
}

/** Overwrite Current section, preserve Decisions + Log. Creates file if absent. */
export function writeCurrentSection(
  repoRoot: string,
  config: PluginConfig,
  current: CurrentSection,
): void {
  const existing = readState(repoRoot, config);
  const decisions = [...(existing?.decisions ?? [])];
  const log = [...(existing?.log ?? [])];

  const content = buildStateContent(current, decisions, log);
  const filePath = path.join(repoRoot, config.stateFileName);
  fs.writeFileSync(filePath, content, "utf-8");
  invalidateStateCache();
}

/** Append a line to Decisions or Log. Creates file if absent. */
export function appendToSection(
  repoRoot: string,
  config: PluginConfig,
  section: "decisions" | "log",
  line: string,
): void {
  const existing = readState(repoRoot, config);
  const current = existing?.current ?? { focus: "No focus set" };
  const decisions = [...(existing?.decisions ?? [])];
  const log = [...(existing?.log ?? [])];

  const entry = line.startsWith("- ") ? line : `- ${line}`;
  if (section === "decisions") {
    decisions.push(entry);
  } else {
    log.push(entry);
    // Trim log to keep only the most recent entries (Decisions are never trimmed)
    if (log.length > config.maxLogEntries) {
      log.splice(0, log.length - config.maxLogEntries);
    }
  }

  const content = buildStateContent(current, decisions, log);
  const filePath = path.join(repoRoot, config.stateFileName);
  fs.writeFileSync(filePath, content, "utf-8");
  invalidateStateCache();
}

// ---------------------------------------------------------------------------
// Artifact scanning
// ---------------------------------------------------------------------------

let artifactCache: { folder: string; artifacts: ArtifactInfo[]; timestamp: number } | null = null;

/** List .md files in a task folder with TTL-based cache. */
export function scanArtifacts(taskFolder: string, config: PluginConfig): ArtifactInfo[] {
  const now = Date.now();

  // Cache hit — same folder, within TTL
  if (
    artifactCache !== null &&
    artifactCache.folder === taskFolder &&
    now - artifactCache.timestamp < config.artifactCacheTtlMs
  ) {
    return artifactCache.artifacts;
  }

  const resolved = resolveTilde(taskFolder);

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const artifacts: ArtifactInfo[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const stat = fs.statSync(path.join(resolved, entry.name));
        artifacts.push({
          name: entry.name,
          size: stat.size,
          mtime: stat.mtime,
        });
      } catch {
        // Skip unreadable files
      }
    }

    artifactCache = { folder: taskFolder, artifacts, timestamp: now };
    return artifacts;
  } catch {
    // Folder doesn't exist or unreadable
    artifactCache = { folder: taskFolder, artifacts: [], timestamp: now };
    return [];
  }
}
