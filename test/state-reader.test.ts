/**
 * Tests for STATE.md parsing, writing, and section manipulation.
 *
 * Tests exercise the public API of state-reader.ts:
 * - parseStateFile: pure parsing of STATE.md content → structured data
 * - writeCurrentSection: overwrite Current, preserve Decisions + Log
 * - appendToSection: append entries to Decisions or Log
 */

import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  parseStateFile,
  writeCurrentSection,
  appendToSection,
  invalidateStateCache,
  resolveConfig,
} from "../src/state-reader.js";
import type { CurrentSection, PluginConfig } from "../src/state-reader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp directory for filesystem tests. Cleaned up in afterAll. */
const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-guard-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
});

/** Build a config pointing STATE.md at a temp directory. */
function configFor(stateFileName = "STATE.md"): PluginConfig {
  return resolveConfig({ stateFileName });
}

/** Read STATE.md from a temp dir, returning the raw content. */
function readStateFile(dir: string, fileName = "STATE.md"): string {
  return fs.readFileSync(path.join(dir, fileName), "utf-8");
}

// ---------------------------------------------------------------------------
// parseStateFile
// ---------------------------------------------------------------------------

describe("parseStateFile", () => {
  test("parses a full 3-section STATE.md", () => {
    const content = `# State

## Current
focus: Building context-guard plugin
phase: implementing
task: ~/.config/opencode/plans/260411-context-guard-plugin/
blockers: none
next: Switch to /execute, build steps 1-3
handoff: Execute should read all 3 artifacts.

## Decisions
- Pure JS only, no native deps [2026-04-11]
- [REJECTED] js-tiktoken — WASM dep [2026-04-11]

## Log
- [2026-04-11 14:00] Plan complete with 9 build steps
- [auto] [2026-04-11 14:23] Session ended.
`;

    const result = parseStateFile(content);

    expect(result.current.focus).toBe("Building context-guard plugin");
    expect(result.current.phase).toBe("implementing");
    expect(result.current.task).toBe(
      "~/.config/opencode/plans/260411-context-guard-plugin/",
    );
    expect(result.current.blockers).toBe("none");
    expect(result.current.next).toBe("Switch to /execute, build steps 1-3");
    expect(result.current.handoff).toBe(
      "Execute should read all 3 artifacts.",
    );

    expect(result.decisions).toHaveLength(2);
    expect(result.decisions[0]).toBe(
      "- Pure JS only, no native deps [2026-04-11]",
    );
    expect(result.decisions[1]).toBe(
      "- [REJECTED] js-tiktoken — WASM dep [2026-04-11]",
    );

    expect(result.log).toHaveLength(2);
    expect(result.log[0]).toBe(
      "- [2026-04-11 14:00] Plan complete with 9 build steps",
    );
    expect(result.log[1]).toBe(
      "- [auto] [2026-04-11 14:23] Session ended.",
    );

    expect(result.raw).toBe(content);
  });

  test("handles missing Decisions section", () => {
    const content = `# State

## Current
focus: Quick fix

## Log
- [2026-04-11 14:00] Fixed the bug
`;

    const result = parseStateFile(content);
    expect(result.current.focus).toBe("Quick fix");
    expect(result.decisions).toHaveLength(0);
    expect(result.log).toHaveLength(1);
  });

  test("handles missing Log section", () => {
    const content = `# State

## Current
focus: Quick fix

## Decisions
- Use TypeScript [2026-04-11]
`;

    const result = parseStateFile(content);
    expect(result.current.focus).toBe("Quick fix");
    expect(result.decisions).toHaveLength(1);
    expect(result.log).toHaveLength(0);
  });

  test("handles only Current section", () => {
    const content = `# State

## Current
focus: Just started
`;

    const result = parseStateFile(content);
    expect(result.current.focus).toBe("Just started");
    expect(result.decisions).toHaveLength(0);
    expect(result.log).toHaveLength(0);
  });

  test("returns empty focus for empty file", () => {
    const result = parseStateFile("");
    expect(result.current.focus).toBe("");
    expect(result.decisions).toHaveLength(0);
    expect(result.log).toHaveLength(0);
  });

  test("ignores unknown H2 sections (future-proofing)", () => {
    const content = `# State

## Current
focus: Testing sections

## Future Section
some: data
other: values

## Decisions
- Real decision [2026-04-11]

## Another Unknown
blah blah

## Log
- [2026-04-11] Real log
`;

    const result = parseStateFile(content);
    expect(result.current.focus).toBe("Testing sections");
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]).toBe("- Real decision [2026-04-11]");
    expect(result.log).toHaveLength(1);
    expect(result.log[0]).toBe("- [2026-04-11] Real log");
  });

  test("skips lines without '- ' prefix in Decisions and Log", () => {
    const content = `# State

## Current
focus: Testing prefixes

## Decisions
- Valid decision [2026-04-11]
This line has no dash prefix
Also no prefix here

## Log
- [2026-04-11] Valid log entry
Not a log entry
`;

    const result = parseStateFile(content);
    expect(result.decisions).toHaveLength(1);
    expect(result.log).toHaveLength(1);
  });

  test("extracts optional fields only when present", () => {
    const content = `# State

## Current
focus: Minimal state
`;

    const result = parseStateFile(content);
    expect(result.current.focus).toBe("Minimal state");
    expect(result.current.phase).toBeUndefined();
    expect(result.current.task).toBeUndefined();
    expect(result.current.blockers).toBeUndefined();
    expect(result.current.next).toBeUndefined();
    expect(result.current.handoff).toBeUndefined();
  });

  test("handles focus with colons in the value", () => {
    const content = `# State

## Current
focus: Fix bug: parser fails on colons in values
`;

    const result = parseStateFile(content);
    expect(result.current.focus).toBe(
      "Fix bug: parser fails on colons in values",
    );
  });

  test("identifies [REJECTED] decisions", () => {
    const content = `# State

## Current
focus: Testing

## Decisions
- Use Bun runtime [2026-04-11]
- [REJECTED] Use Deno — too experimental [2026-04-11]
- [REJECTED] Ship as CJS — ESM only [2026-04-12]
- Another valid decision [2026-04-12]
`;

    const result = parseStateFile(content);
    expect(result.decisions).toHaveLength(4);

    // Verify the raw lines preserve [REJECTED] tag for downstream consumers
    const rejected = result.decisions.filter((d) =>
      d.includes("[REJECTED]"),
    );
    expect(rejected).toHaveLength(2);
  });

  test("handles Current field keys case-insensitively", () => {
    const content = `# State

## Current
Focus: Mixed case focus
Phase: implementing
TASK: /some/path
Blockers: API rate limits
Next: Deploy to staging
Handoff: Run tests first
`;

    const result = parseStateFile(content);
    expect(result.current.focus).toBe("Mixed case focus");
    expect(result.current.phase).toBe("implementing");
    expect(result.current.task).toBe("/some/path");
    expect(result.current.blockers).toBe("API rate limits");
    expect(result.current.next).toBe("Deploy to staging");
    expect(result.current.handoff).toBe("Run tests first");
  });

  test("ignores lines without colon in Current section", () => {
    const content = `# State

## Current
focus: Testing
This line has no colon
phase: implementing
`;

    const result = parseStateFile(content);
    expect(result.current.focus).toBe("Testing");
    expect(result.current.phase).toBe("implementing");
  });
});

// ---------------------------------------------------------------------------
// writeCurrentSection
// ---------------------------------------------------------------------------

describe("writeCurrentSection", () => {
  beforeEach(() => {
    invalidateStateCache();
  });

  test("creates STATE.md from scratch with proper structure", () => {
    const dir = makeTmpDir();
    const config = configFor();
    const current: CurrentSection = {
      focus: "Brand new project",
      phase: "planning",
    };

    writeCurrentSection(dir, config, current);

    const content = readStateFile(dir);
    expect(content).toContain("# State");
    expect(content).toContain("## Current");
    expect(content).toContain("focus: Brand new project");
    expect(content).toContain("phase: planning");
    expect(content).toContain("## Decisions");
    expect(content).toContain("## Log");
  });

  test("preserves existing Decisions and Log when overwriting Current", () => {
    const dir = makeTmpDir();
    const config = configFor();

    // Write initial state with all three sections
    const initial = `# State

## Current
focus: Old focus
phase: implementing

## Decisions
- Use TypeScript [2026-04-11]
- [REJECTED] Use Flow [2026-04-11]

## Log
- [2026-04-11 14:00] Initial setup complete
- [2026-04-11 15:00] Added tests
`;
    fs.writeFileSync(path.join(dir, "STATE.md"), initial, "utf-8");
    invalidateStateCache();

    // Overwrite Current section
    const newCurrent: CurrentSection = {
      focus: "New focus after refactor",
      phase: "testing",
      next: "Run CI",
    };
    writeCurrentSection(dir, config, newCurrent);

    const content = readStateFile(dir);

    // New Current values
    expect(content).toContain("focus: New focus after refactor");
    expect(content).toContain("phase: testing");
    expect(content).toContain("next: Run CI");
    // Old Current values are gone
    expect(content).not.toContain("focus: Old focus");

    // Decisions preserved
    expect(content).toContain("- Use TypeScript [2026-04-11]");
    expect(content).toContain("- [REJECTED] Use Flow [2026-04-11]");

    // Log preserved
    expect(content).toContain("- [2026-04-11 14:00] Initial setup complete");
    expect(content).toContain("- [2026-04-11 15:00] Added tests");
  });

  test("writes only focus when optional fields are omitted", () => {
    const dir = makeTmpDir();
    const config = configFor();
    const current: CurrentSection = { focus: "Minimal" };

    writeCurrentSection(dir, config, current);

    const content = readStateFile(dir);
    expect(content).toContain("focus: Minimal");
    expect(content).not.toContain("phase:");
    expect(content).not.toContain("task:");
    expect(content).not.toContain("blockers:");
    expect(content).not.toContain("next:");
    expect(content).not.toContain("handoff:");
  });

  test("writes all optional fields when provided", () => {
    const dir = makeTmpDir();
    const config = configFor();
    const current: CurrentSection = {
      focus: "Full state",
      phase: "implementing",
      task: "/some/task/folder",
      blockers: "Waiting on API access",
      next: "Integrate the API",
      handoff: "Backend team should continue",
    };

    writeCurrentSection(dir, config, current);

    const content = readStateFile(dir);
    expect(content).toContain("focus: Full state");
    expect(content).toContain("phase: implementing");
    expect(content).toContain("task: /some/task/folder");
    expect(content).toContain("blockers: Waiting on API access");
    expect(content).toContain("next: Integrate the API");
    expect(content).toContain("handoff: Backend team should continue");
  });

  test("ends file with trailing newline", () => {
    const dir = makeTmpDir();
    const config = configFor();
    writeCurrentSection(dir, config, { focus: "Trailing newline check" });

    const content = readStateFile(dir);
    expect(content.endsWith("\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// appendToSection
// ---------------------------------------------------------------------------

describe("appendToSection", () => {
  beforeEach(() => {
    invalidateStateCache();
  });

  test("appends to Log section of existing file", () => {
    const dir = makeTmpDir();
    const config = configFor();

    // Create initial STATE.md
    writeCurrentSection(dir, config, { focus: "Testing appends" });
    invalidateStateCache();

    appendToSection(dir, config, "log", "- [2026-04-11 14:00] First entry");

    const content = readStateFile(dir);
    expect(content).toContain("- [2026-04-11 14:00] First entry");
  });

  test("appends to Decisions section of existing file", () => {
    const dir = makeTmpDir();
    const config = configFor();

    writeCurrentSection(dir, config, { focus: "Testing decisions" });
    invalidateStateCache();

    appendToSection(
      dir,
      config,
      "decisions",
      "- Use Bun for testing [2026-04-11]",
    );

    const content = readStateFile(dir);
    expect(content).toContain("- Use Bun for testing [2026-04-11]");
  });

  test("adds '- ' prefix when missing", () => {
    const dir = makeTmpDir();
    const config = configFor();

    writeCurrentSection(dir, config, { focus: "Testing prefix" });
    invalidateStateCache();

    appendToSection(dir, config, "log", "No prefix here");

    const content = readStateFile(dir);
    expect(content).toContain("- No prefix here");
  });

  test("does not double '- ' prefix when already present", () => {
    const dir = makeTmpDir();
    const config = configFor();

    writeCurrentSection(dir, config, { focus: "Testing prefix" });
    invalidateStateCache();

    appendToSection(dir, config, "log", "- Already has prefix");

    const content = readStateFile(dir);
    expect(content).toContain("- Already has prefix");
    // Should NOT contain "- - Already has prefix"
    expect(content).not.toContain("- - Already has prefix");
  });

  test("creates STATE.md from scratch when file doesn't exist", () => {
    const dir = makeTmpDir();
    const config = configFor();

    // No STATE.md exists — appendToSection should create it
    appendToSection(dir, config, "log", "- First entry ever");

    const content = readStateFile(dir);
    expect(content).toContain("# State");
    expect(content).toContain("## Current");
    expect(content).toContain("focus: No focus set");
    expect(content).toContain("## Log");
    expect(content).toContain("- First entry ever");
  });

  test("preserves Current section when appending", () => {
    const dir = makeTmpDir();
    const config = configFor();

    writeCurrentSection(dir, config, {
      focus: "Important focus",
      phase: "shipping",
    });
    invalidateStateCache();

    appendToSection(dir, config, "log", "- New log entry");

    const content = readStateFile(dir);
    expect(content).toContain("focus: Important focus");
    expect(content).toContain("phase: shipping");
    expect(content).toContain("- New log entry");
  });

  test("multiple appends accumulate correctly", () => {
    const dir = makeTmpDir();
    const config = configFor();

    writeCurrentSection(dir, config, { focus: "Multi-append test" });
    invalidateStateCache();

    appendToSection(dir, config, "log", "- Entry 1");
    invalidateStateCache();
    appendToSection(dir, config, "log", "- Entry 2");
    invalidateStateCache();
    appendToSection(dir, config, "decisions", "- Decision A [2026-04-11]");
    invalidateStateCache();
    appendToSection(dir, config, "log", "- Entry 3");

    const content = readStateFile(dir);
    expect(content).toContain("- Entry 1");
    expect(content).toContain("- Entry 2");
    expect(content).toContain("- Entry 3");
    expect(content).toContain("- Decision A [2026-04-11]");
  });
});
