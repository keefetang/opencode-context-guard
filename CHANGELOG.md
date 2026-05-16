# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

## [0.3.1] — 2026-05-16

### Changed
- Updated devDeps: bun-types ^1.3.14, typescript ^6.0.3
- CI and publish workflows now run `bun test`
- Standardized .gitignore, switched lockfile from package-lock.json to bun.lock
- AGENTS.md references shared plugin SDK doc

## [0.3.0] - 2026-05-16

### Changed
- Updated `softprops/action-gh-release` from v2 to v3 (Node 24 runtime)
- Updated `typescript` from 6.0.2 to 6.0.3 (patch bug fixes)
- Updated `bun-types` from 1.3.12 to 1.3.13 (matches local Bun runtime)
- Removed dead `os` import from `context-guard.ts` (moved to `state-reader.ts` with `resolveTilde`)

### Fixed
- README: session line example showed "5 files modified" but code outputs a boolean, not a count
- README: Log section described as "Append-only" — now notes the 30-entry cap from v0.2.1
- AGENTS.md: Security section said "three 5s timeouts" (15s) — corrected to two (10s) after git log merge

## [0.2.2] - 2026-05-16

### Security
- **Removed arbitrary file write from `context_discover`** — the tool previously accepted any filesystem path as `target`, allowing model-driven writes to sensitive locations (e.g., `~/.bashrc`, `~/.ssh/`). Now only accepts `"log"` or `"decisions"` as targets. Use `edit`/`write` tools for other files.
- **Path containment for `context_load`** — directory reads restricted to within `repoRoot` or `config.plansDir`. Prevents model-driven reads of arbitrary filesystem locations.
- **Field length caps** — `context_checkpoint` fields capped at 1000 chars, `context_discover` content capped at 2000 chars. Prevents system prompt token exhaustion from unbounded field values.

### Changed
- **`resolveTilde` deduplicated** — moved to `state-reader.ts` as a single exported function. `scanArtifacts` and `context_load` now share the same implementation instead of having an inline copy.
- **Git log merged into single call** — `fetchGitStatus` now runs one `git log -1` instead of two, splitting hash from display string. Saves one process spawn per 30-second cache refresh.
- **Removed unused `_ctx` parameter** from `createContextGuard` — the `PluginInput` was passed through but never used inside the closure.

### Added
- Extracted `isPathContained` as an exported helper for path containment validation
- 31 security-focused unit tests covering path containment, tilde resolution, length cap constants, and integration scenarios
- AGENTS.md Security section documenting mitigated and accepted security considerations

## [0.2.1] - 2026-05-16

### Added
- **Log rotation** — STATE.md Log section now trims to `maxLogEntries` (default: 30) on each append, keeping the most recent entries and discarding oldest. Prevents unbounded growth over weeks of use. Decisions section is never trimmed.

## [0.2.0] - 2026-05-15

### Added
- **Automated unit tests** — 44 tests (132 assertions) covering `parseStateFile`, `writeCurrentSection`, `appendToSection`, `formatRelativeTime`, and `extractCommitMessage` pattern. Uses Bun's built-in test runner.
- **Commit detection dedup guard** — `lastLoggedCommitHash` variable prevents duplicate `[auto] Committed:` log entries across cache resets and process restarts

### Changed
- Updated `@opencode-ai/plugin` from ^1.4.3 to ^1.15.0
- AGENTS.md line counts changed to approximate ranges (~30, ~860, ~300) to avoid constant maintenance
- AGENTS.md corrected: git cache is closure-scoped (not module-scoped as previously documented)

### Fixed
- MIGRATION.md referenced stale plugin name `opencode-notify` → `opencode-alert`
- STATE.md log cleaned up — removed 100+ duplicate `[auto] Committed:` entries caused by pre-v0.1.2 `%cr` relative time bug running on an unrestarted process
- TODO.md updated to reflect confirmed-working features and remaining work

## [0.1.3] - 2026-04-12

### Fixed
- **False "needs checkpoint" obligation after checkpointing** — `filesModified` was never reset after `context_checkpoint` ran, causing the obligation to re-fire on every subsequent turn even though the state was already saved. Also caused incorrect `[auto] No explicit checkpoint` log entries at session end after a checkpoint was made.
- **`context_discover` permanently suppressed checkpoint obligations** — calling `context_discover` updated `lastSeenStateMtime` but not `stateAtSessionStart`, which permanently disabled the "STATE.md needs checkpoint" obligation reminder for the rest of the session regardless of further file changes.
- **False "STATE.md updated externally" warning after compaction** — when the plugin appended its auto-log entry during compaction, it changed STATE.md's mtime without updating `lastSeenStateMtime`. The next turn incorrectly warned that STATE.md had been edited by an external actor.

## [0.1.2] - 2026-04-10

### Fixed
- Commit detection now uses the commit hash instead of the commit message to detect new commits, preventing duplicate `[auto] Committed:` log entries when the same commit message is reused
- Removed dead `isSubagent` field from session state

## [0.1.1] - 2026-04-05

### Fixed
- Commit detection false positives on first cache fill — the plugin no longer fires an `[auto] Committed:` log entry on session start when no new commit has actually been made
- Added CI/CD workflow and upgraded dependencies

## [0.1.0] - 2026-04-01

### Added
- Initial release
- STATE.md project state injected into system prompt every turn (focus, phase, blockers, next, git status, obligations)
- Three tools: `context_checkpoint` (update project state), `context_load` (summarize planning artifacts), `context_discover` (append findings or decisions)
- Git awareness: branch, uncommitted files, ahead/behind remote, last commit — refreshed every 30 seconds
- Obligation tracking: surfaces uncommitted files, stale STATE.md, unpushed commits as facts the agent sees every turn
- Session lifecycle: pre-compaction state injection, idle auto-log, inter-session resumption warning
- External change detection: warns when STATE.md or AGENTS.md is modified between turns
