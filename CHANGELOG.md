# Changelog

All notable changes to this project will be documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

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
