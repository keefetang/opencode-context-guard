/**
 * Tests for context-guard.ts pure functions.
 *
 * - formatRelativeTime: human-readable relative time strings
 * - extractCommitMessage pattern: regex that strips trailing "(relative time)"
 *   from git log output. The function is closure-scoped inside createContextGuard,
 *   so we test the regex pattern directly.
 */

import { describe, expect, test } from "bun:test";

import { formatRelativeTime } from "../src/context-guard.js";

// ---------------------------------------------------------------------------
// Time constants (matching context-guard.ts)
// ---------------------------------------------------------------------------

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------

describe("formatRelativeTime", () => {
  // formatRelativeTime calls Date.now() internally, so we pass epoch-ms
  // values computed as Date.now() - offset. Keep test offsets well inside
  // each time bucket (not at transition boundaries) to avoid flakes from
  // the small elapsed time between the test's Date.now() and the function's.

  test("returns 'just now' for times less than a minute ago", () => {
    expect(formatRelativeTime(Date.now())).toBe("just now");
    expect(formatRelativeTime(Date.now() - 30 * SECOND)).toBe("just now");
    expect(formatRelativeTime(Date.now() - 59 * SECOND)).toBe("just now");
  });

  test("returns singular '1 minute ago'", () => {
    expect(formatRelativeTime(Date.now() - 1 * MINUTE)).toBe("1 minute ago");
    // Just past 1 minute, not yet 2
    expect(formatRelativeTime(Date.now() - 1 * MINUTE - 30 * SECOND)).toBe(
      "1 minute ago",
    );
  });

  test("returns plural minutes", () => {
    expect(formatRelativeTime(Date.now() - 2 * MINUTE)).toBe("2 minutes ago");
    expect(formatRelativeTime(Date.now() - 15 * MINUTE)).toBe(
      "15 minutes ago",
    );
    expect(formatRelativeTime(Date.now() - 59 * MINUTE)).toBe(
      "59 minutes ago",
    );
  });

  test("returns singular '1 hour ago'", () => {
    expect(formatRelativeTime(Date.now() - 1 * HOUR)).toBe("1 hour ago");
    expect(formatRelativeTime(Date.now() - 1 * HOUR - 30 * MINUTE)).toBe(
      "1 hour ago",
    );
  });

  test("returns plural hours", () => {
    expect(formatRelativeTime(Date.now() - 2 * HOUR)).toBe("2 hours ago");
    expect(formatRelativeTime(Date.now() - 12 * HOUR)).toBe("12 hours ago");
    expect(formatRelativeTime(Date.now() - 23 * HOUR)).toBe("23 hours ago");
  });

  test("returns singular '1 day ago'", () => {
    expect(formatRelativeTime(Date.now() - 1 * DAY)).toBe("1 day ago");
    expect(formatRelativeTime(Date.now() - 1 * DAY - 12 * HOUR)).toBe(
      "1 day ago",
    );
  });

  test("returns plural days", () => {
    expect(formatRelativeTime(Date.now() - 2 * DAY)).toBe("2 days ago");
    expect(formatRelativeTime(Date.now() - 6 * DAY)).toBe("6 days ago");
  });

  test("returns singular '1 week ago'", () => {
    expect(formatRelativeTime(Date.now() - 1 * WEEK)).toBe("1 week ago");
    expect(formatRelativeTime(Date.now() - 1 * WEEK - 3 * DAY)).toBe(
      "1 week ago",
    );
  });

  test("returns plural weeks", () => {
    expect(formatRelativeTime(Date.now() - 2 * WEEK)).toBe("2 weeks ago");
    expect(formatRelativeTime(Date.now() - 3 * WEEK)).toBe("3 weeks ago");
  });

  test("returns singular '1 month ago'", () => {
    expect(formatRelativeTime(Date.now() - 1 * MONTH)).toBe("1 month ago");
    expect(formatRelativeTime(Date.now() - 1 * MONTH - 2 * WEEK)).toBe(
      "1 month ago",
    );
  });

  test("returns plural months", () => {
    expect(formatRelativeTime(Date.now() - 2 * MONTH)).toBe("2 months ago");
    expect(formatRelativeTime(Date.now() - 11 * MONTH)).toBe("11 months ago");
  });

  test("returns singular '1 year ago'", () => {
    expect(formatRelativeTime(Date.now() - 1 * YEAR)).toBe("1 year ago");
  });

  test("returns plural years", () => {
    expect(formatRelativeTime(Date.now() - 2 * YEAR)).toBe("2 years ago");
    expect(formatRelativeTime(Date.now() - 5 * YEAR)).toBe("5 years ago");
  });

  test("accepts Date objects", () => {
    const oneHourAgo = new Date(Date.now() - 1 * HOUR);
    expect(formatRelativeTime(oneHourAgo)).toBe("1 hour ago");
  });

  test("accepts epoch milliseconds", () => {
    const twoMinutesAgo = Date.now() - 2 * MINUTE;
    expect(formatRelativeTime(twoMinutesAgo)).toBe("2 minutes ago");
  });
});

// ---------------------------------------------------------------------------
// extractCommitMessage regex pattern
// ---------------------------------------------------------------------------

describe("extractCommitMessage pattern", () => {
  // The actual function is closure-scoped inside createContextGuard (line 315
  // of context-guard.ts). It uses this regex: /^(.+)\s+\([^)]+\)$/
  // We test the pattern directly since we can't import the function.
  const extractCommitMessage = (logLine: string): string => {
    const match = /^(.+)\s+\([^)]+\)$/.exec(logLine);
    return match?.[1] ?? logLine;
  };

  test("extracts message from standard git log format", () => {
    expect(extractCommitMessage('fix: resolve parsing bug (2 hours ago)')).toBe(
      "fix: resolve parsing bug",
    );
  });

  test("handles various relative time formats from git", () => {
    expect(extractCommitMessage("initial commit (5 minutes ago)")).toBe(
      "initial commit",
    );
    expect(extractCommitMessage("add tests (3 days ago)")).toBe("add tests");
    expect(extractCommitMessage("release v1.0.0 (2 weeks ago)")).toBe(
      "release v1.0.0",
    );
    expect(extractCommitMessage("big refactor (6 months ago)")).toBe(
      "big refactor",
    );
  });

  test("returns input unchanged when no trailing parenthetical", () => {
    expect(extractCommitMessage("just a message")).toBe("just a message");
    expect(extractCommitMessage("")).toBe("");
  });

  test("handles commit messages that contain parentheses", () => {
    // The regex is greedy — it captures everything up to the last "(...)".
    // A message like "fix(parser): handle edge case (3 hours ago)"
    // should extract "fix(parser): handle edge case".
    expect(
      extractCommitMessage("fix(parser): handle edge case (3 hours ago)"),
    ).toBe("fix(parser): handle edge case");
  });

  test("handles quoted format from git log", () => {
    // git log -1 --format="%s (%cr)" may include surrounding quotes
    // The extractCommitMessage function gets called after .trim() so no
    // surrounding whitespace, but the content itself may have quotes.
    expect(
      extractCommitMessage('"add CI/CD and upgrade deps" (5 weeks ago)'),
    ).toBe('"add CI/CD and upgrade deps"');
  });
});
