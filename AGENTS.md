# AGENTS.md -- opencode-context-guard

## What This Is

An OpenCode plugin that enforces context management at the hook level — injecting STATE.md project state, git status, session info, and obligations into the system prompt on every API call. Provides three structured tools for state management (`context_checkpoint`, `context_load`, `context_discover`) and handles session lifecycle events: pre-compaction state preservation, idle auto-log-entry, and inter-session resumption warnings.

## Architecture

Three source files. `index.ts` is the plugin entry point — it resolves config and wires everything together. `context-guard.ts` owns the hooks, tools, git integration, and per-session state tracking. `state-reader.ts` is a focused module for STATE.md parsing, caching, reading, and writing — plus artifact scanning. No side effects beyond filesystem I/O.

Entry point: `src/index.ts` exports `ContextGuardPlugin`, a plugin function registered with OpenCode.

## Source Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.ts` | ~30 | Plugin entry point — resolves config, warms STATE.md cache, wires hooks/tools/events |
| `src/context-guard.ts` | ~860 | Hooks, tools, git integration, session tracking, obligation detection, system prompt builder |
| `src/state-reader.ts` | ~300 | STATE.md parse/cache/read/write, artifact scanning, config types and defaults |

## Plugin Hooks

| Hook | Purpose |
|------|---------|
| `experimental.chat.system.transform` | Inject project context block into system prompt every turn. Handles external change detection (STATE.md, AGENTS.md mtime) and first-turn reminders (inter-session resumption warning if last log entry is `[auto]`; AGENTS.md read reminder). |
| `experimental.session.compacting` | Pre-compaction: auto-append log entry if files were modified without a checkpoint; inject full STATE.md into compaction context to survive summarization. |
| `tool.execute.after` | Track tool calls and file modifications per session. Detects `edit` and `write` tool use to set `filesModified = true`. |

### Custom Tools

| Tool | Purpose |
|------|---------|
| `context_checkpoint` | Overwrite the Current section of STATE.md. Preserves Decisions + Log. Appends a checkpoint log entry. Invalidates the STATE.md cache. Clears the checkpoint obligation. |
| `context_load` | Scan a task folder and return names, sizes, mtimes, and first 10 lines of each `.md` artifact. Pure read — no side effects. |
| `context_discover` | Append a finding, decision, or note to STATE.md's Log section (default) or Decisions section (`target: "decisions"`). Only writes to STATE.md — use `edit`/`write` for other files. |

### Event Handler

Listens for `session.idle`. When the session had file modifications but no explicit checkpoint (STATE.md mtime unchanged since session start), appends: `[auto] [timestamp] Session ended. N tool calls. No explicit checkpoint.` Cleans up the session entry from the Map on every idle event.

## STATE.md Format

The plugin introduces a structured three-section format:

```markdown
# State

## Current
focus: Building context-guard plugin
phase: implementing
task: ~/.config/opencode/plans/260411-context-guard-plugin/
blockers: none
next: Switch to /execute, build steps 1-3
handoff: Execute should read all 3 artifacts. Start with step 1.

## Decisions
- Pure JS only, no native deps [2026-04-11]
- [REJECTED] js-tiktoken — WASM dep, replaced with custom BPE [2026-04-11]

## Log
- [2026-04-11 14:00] Plan complete with 9 build steps
- [auto] [2026-04-11 14:23] Session ended. 14 tool calls. No explicit checkpoint.
- [auto] [2026-04-11 14:55] Committed: "add CI/CD and upgrade all dependencies"
```

### Section rules

| Section | Mutability | Who writes | Plugin behavior |
|---------|------------|------------|-----------------|
| **Current** | Overwritten on each checkpoint | Model via `context_checkpoint` | Injected verbatim into system prompt every turn |
| **Decisions** | Append-only | Model via `context_discover --target decisions` | Plugin never modifies. Injects count into system prompt. |
| **Log** | Append-only (oldest entries trimmed when exceeding maxLogEntries) | Model (via `context_discover`) + plugin auto-entries | Auto-appended: session end, commits detected, compaction. NOT injected into system prompt. |

### Current section fields

| Field | Required | Plugin behavior |
|-------|----------|-----------------|
| `focus` | Yes | Always injected. If missing: "No focus set." |
| `phase` | No | Injected if present. Values: planning, implementing, testing, reviewing, shipping. |
| `task` | No | Plugin reads task folder path from this field for artifact scanning. |
| `blockers` | No | Injected if present and not "none". |
| `next` | No | Injected if present. |
| `handoff` | No | Injected if present. Tells the next session who should continue and where to start. |

### Decisions tags

- No tag = active locked decision
- `[REJECTED]` = tried and failed — tells agents not to retry this approach. Include the reason inline.

## Conventions

- **Pure JS only** — no native dependencies. Runtime dep is `@opencode-ai/plugin` only. Uses Node.js built-ins (`fs`, `path`, `os`, `child_process`) and `execSync` for git.
- **Source ships as `.ts`** — Bun transpiles natively. No build step.
- **STATE.md cache is mtime-based**, not TTL. Re-reads when `fs.statSync` shows mtime changed. Git and artifact caches are TTL-based (30s default).
- **Git cache is 30s TTL.** Commit detection compares `lastCommitHash` across cache refreshes — if the hash changes, appends an `[auto]` log entry. Skips the first cache fill to avoid false positives. A `lastLoggedCommitHash` dedup guard prevents repeated logging of the same commit.
- **External change detection** tracks STATE.md and AGENTS.md mtime between turns. On mtime change (not first turn), pushes a ⚠ warning into the system prompt before the context block.
- **`[auto]` log entries** are plugin-generated. Never written by the model. Signals to the next session that no explicit checkpoint was made.
- **Use `context_checkpoint` for STATE.md updates** (not raw Write tool) — it preserves Decisions/Log sections and invalidates the cache. Direct Write would clobber Decisions and Log.
- **Per-session state** is tracked in a `Map<string, SessionState>`. Session-level: tool count, files modified, first-turn flag, start time, last-seen mtimes. Git cache is closure-scoped inside `createContextGuard` (shared across sessions within one plugin instance). STATE.md and artifact caches are module-scoped in `state-reader.ts`.
- **Commit detection dedup** — a `lastLoggedCommitHash` variable in the closure prevents duplicate `[auto] Committed:` entries even if the git cache resets (process restart, multiple processes).
- **Session sweep** at Map > 50 entries: removes entries inactive for 5+ minutes. Primary cleanup is `session.idle`.

## Testing

Manual testing with `--print-logs --log-level DEBUG`:

```
opencode --print-logs --log-level DEBUG
```

What to look for:

1. **System prompt injection** — Open the debug log. Each turn should show the `## Context Guard` block with focus, git status, session info.
2. **STATE.md obligation** — Edit or write a file, then check the next turn's injection. Should show: `Obligations: STATE.md needs checkpoint (files changed since last update)`.
3. **`context_checkpoint` tool** — Call it with a focus string. Verify STATE.md Current section is updated, log entry appended, obligation clears on the next turn.
4. **Git line** — Run in a git repo with uncommitted changes. Verify `Git: <branch>, N uncommitted, N ahead` appears.
5. **`context_load` tool** — Pass a task folder path. Verify it returns file names, sizes, mtimes, and previews.
6. **`context_discover` tool** — Call with `target: "decisions"`. Verify the Decisions section in STATE.md has a new entry.
7. **Idle auto-log** — Modify files without checkpointing, let the session go idle. Check STATE.md Log section for `[auto]` entry.
8. **Inter-session warning** — If last log entry is `[auto]`, verify the next session's first turn includes the ⚠ resumption warning.
9. **Compaction injection** — Trigger compaction. Verify the STATE.md content is included in the compaction context.

## Git Conventions

- **Always confirm with the user before pushing to remote.** No autonomous pushes.
- **Squash related commits before pushing** when possible — keep the history clean and meaningful.
- **Force push is allowed** for the repo admin but should be used deliberately (e.g., squashing before push, not after).
- **CI:** `tsc --noEmit` runs on every push to main and on PRs. Auto-publish to npm on version tags (`v*`).
- **Dependabot:** Patch/minor PRs can be merged if CI passes. Major version bumps should be tested locally first.
- **Releasing:** See `RELEASING.md` (local, gitignored) for the full tag-and-publish workflow.

## Known Platform Limitations

- **`experimental.chat.system.transform`** — undocumented but confirmed working. Mutations (pushing to `output.system`) are applied by OpenCode.
- **`experimental.session.compacting`** — available but behavior under concurrent compactions is not fully characterized.
- **`experimental.chat.messages.transform`** — fires but mutations are NOT applied by OpenCode. Not used by this plugin (learned from media-guard).
- **Plugin hooks fire for all sessions** — primary AND subagents. One plugin instance per OpenCode server. Session scoping is via the `sessions` Map keyed by `sessionID`.
- **`sessionID` availability** — present in `tool.execute.after` and `system.transform`. The `system.transform` input has `sessionID` as potentially undefined (guarded in code).
- **No `parentSessionID`** — determining primary vs subagent requires a `session.get()` API call. The plugin does not currently distinguish primary from subagent sessions.
- **Working directory** comes from `PluginInput` at init time (`ctx.directory`), not from hooks directly.
- **Bash file writes not tracked** — only `edit` and `write` tool calls set `filesModified`. Bash commands that write files via shell are not detected. Accepted tradeoff — covers 95%+ of real file changes.

## Security

### Mitigated

- **Path containment** — `context_load` directory reads are restricted to within `repoRoot` or `config.plansDir`. `context_discover` only writes to STATE.md (arbitrary file path support was removed). Prevents model-driven reads/writes to sensitive filesystem locations.
- **Field length caps** — `context_checkpoint` fields capped at 1000 chars, `context_discover` content capped at 2000 chars. Prevents system prompt token exhaustion from unbounded field values.

### Accepted (documented tradeoffs)

- **System prompt feedback loop** — STATE.md fields are injected verbatim into the system prompt. The model writes these fields and reads them back. A confused model could write adversarial content that gets re-injected. Mitigated by the structured `## Context Guard` block framing and the single-user threat model.
- **TOCTOU race in read-modify-write** — `writeCurrentSection` and `appendToSection` read STATE.md, modify in memory, and write back. A concurrent write between read and write would be silently overwritten. The window is microseconds (synchronous fs). Acceptable for single-user use.
- **`execSync` blocks event loop** — Git operations block for up to 10s worst case (two 5s timeouts). Mitigated by 30s TTL cache — git is fetched at most once per 30 seconds. On reasonable local repos, actual blocking is <100ms.
- **Non-atomic writes** — `writeFileSync` is not atomic. A process kill during write could corrupt STATE.md. The write completes in microseconds for typical file sizes. Acceptable risk.
- **Absolute path in system prompt** — `repoRoot` is exposed to the model in the `## Context Guard` block. Acceptable for single-user installations. Would need to be masked in a multi-tenant deployment.
