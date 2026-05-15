/**
 * Tests for security validation helpers.
 *
 * - isPathContained: path containment check preventing traversal outside allowed roots
 * - resolveTilde: tilde expansion (part of the security boundary for path resolution)
 * - MAX_FIELD_LEN / MAX_CONTENT_LEN: length cap constants
 */

import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

import {
  isPathContained,
  MAX_FIELD_LEN,
  MAX_CONTENT_LEN,
} from "../src/context-guard.js";
import { resolveTilde } from "../src/state-reader.js";

// ---------------------------------------------------------------------------
// isPathContained
// ---------------------------------------------------------------------------

describe("isPathContained", () => {
  const root = "/repo/root";

  test("returns true for path equal to root", () => {
    expect(isPathContained("/repo/root", root)).toBe(true);
  });

  test("returns true for direct child of root", () => {
    expect(isPathContained("/repo/root/file.txt", root)).toBe(true);
  });

  test("returns true for deeply nested path within root", () => {
    expect(isPathContained("/repo/root/src/lib/deep/file.ts", root)).toBe(true);
  });

  test("returns false for path outside root", () => {
    expect(isPathContained("/other/directory", root)).toBe(false);
  });

  test("returns false for path traversal above root", () => {
    // path.resolve would normalize this, but the resolved result would be
    // outside root — test the final resolved path
    const resolved = path.resolve(root, "../../etc/passwd");
    expect(isPathContained(resolved, root)).toBe(false);
  });

  test("returns false for sibling directory", () => {
    expect(isPathContained("/repo/other", root)).toBe(false);
  });

  test("returns false for path with similar prefix but different directory", () => {
    // /repo/root-extra is NOT inside /repo/root — this is the key case
    // that a naive startsWith check without path.sep would get wrong
    expect(isPathContained("/repo/root-extra", root)).toBe(false);
    expect(isPathContained("/repo/root-extra/file.txt", root)).toBe(false);
    expect(isPathContained("/repo/rooting", root)).toBe(false);
  });

  test("returns false for absolute path completely outside", () => {
    expect(isPathContained("/etc/passwd", root)).toBe(false);
    expect(isPathContained("/home/user/.ssh/id_rsa", root)).toBe(false);
    expect(isPathContained("/tmp/evil", root)).toBe(false);
  });

  test("returns false for parent of root", () => {
    expect(isPathContained("/repo", root)).toBe(false);
    expect(isPathContained("/", root)).toBe(false);
  });

  test("handles root at filesystem root", () => {
    expect(isPathContained("/", "/")).toBe(true);
    expect(isPathContained("/anything", "/")).toBe(true);
    expect(isPathContained("/etc/passwd", "/")).toBe(true);
  });

  test("handles paths with trailing separators consistently", () => {
    // path.resolve strips trailing slashes, so callers should resolve first.
    // With a trailing slash, the path still starts with root + sep.
    expect(isPathContained("/repo/root/subdir/", root)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveTilde
// ---------------------------------------------------------------------------

describe("resolveTilde", () => {
  const home = os.homedir();

  test("expands bare tilde to home directory", () => {
    expect(resolveTilde("~")).toBe(home);
  });

  test("expands ~/path to home directory + path", () => {
    expect(resolveTilde("~/Documents")).toBe(path.join(home, "Documents"));
    expect(resolveTilde("~/.config/opencode")).toBe(
      path.join(home, ".config/opencode"),
    );
  });

  test("expands deeply nested tilde path", () => {
    expect(resolveTilde("~/a/b/c/d.txt")).toBe(
      path.join(home, "a/b/c/d.txt"),
    );
  });

  test("does not expand tilde in the middle of a path", () => {
    expect(resolveTilde("/some/~/path")).toBe("/some/~/path");
  });

  test("does not expand tilde-prefixed usernames (e.g., ~user/)", () => {
    // Unix convention: ~user expands to that user's home directory.
    // This function only handles bare ~ and ~/, not ~user.
    expect(resolveTilde("~user/dir")).toBe("~user/dir");
  });

  test("returns absolute paths unchanged", () => {
    expect(resolveTilde("/absolute/path")).toBe("/absolute/path");
    expect(resolveTilde("/usr/local/bin")).toBe("/usr/local/bin");
  });

  test("returns relative paths unchanged", () => {
    expect(resolveTilde("relative/path")).toBe("relative/path");
    expect(resolveTilde("./local")).toBe("./local");
    expect(resolveTilde("../parent")).toBe("../parent");
  });

  test("returns empty string unchanged", () => {
    expect(resolveTilde("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Length cap constants
// ---------------------------------------------------------------------------

describe("security constants", () => {
  test("MAX_FIELD_LEN is 1000", () => {
    expect(MAX_FIELD_LEN).toBe(1000);
  });

  test("MAX_CONTENT_LEN is 2000", () => {
    expect(MAX_CONTENT_LEN).toBe(2000);
  });

  test("MAX_FIELD_LEN is a positive integer", () => {
    expect(MAX_FIELD_LEN).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_FIELD_LEN)).toBe(true);
  });

  test("MAX_CONTENT_LEN is a positive integer", () => {
    expect(MAX_CONTENT_LEN).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_CONTENT_LEN)).toBe(true);
  });

  test("MAX_CONTENT_LEN >= MAX_FIELD_LEN", () => {
    // Content can carry more than a single field — sanity check the relationship
    expect(MAX_CONTENT_LEN).toBeGreaterThanOrEqual(MAX_FIELD_LEN);
  });
});

// ---------------------------------------------------------------------------
// Path containment integration — simulating tool-level validation
// ---------------------------------------------------------------------------

describe("path containment integration", () => {
  const repoRoot = "/projects/my-repo";

  test("context_discover-style: resolved relative path inside repo is allowed", () => {
    const target = "notes.md";
    const resolved = path.resolve(repoRoot, target);
    expect(isPathContained(resolved, repoRoot)).toBe(true);
  });

  test("context_discover-style: resolved traversal path is rejected", () => {
    const target = "../../etc/passwd";
    const resolved = path.resolve(repoRoot, target);
    expect(isPathContained(resolved, repoRoot)).toBe(false);
  });

  test("context_discover-style: absolute path outside repo is rejected", () => {
    const target = "/etc/passwd";
    const resolved = path.resolve(repoRoot, target);
    expect(isPathContained(resolved, repoRoot)).toBe(false);
  });

  test("context_discover-style: tilde path outside repo is rejected", () => {
    const target = "~/.bashrc";
    const resolved = path.resolve(repoRoot, resolveTilde(target));
    expect(isPathContained(resolved, repoRoot)).toBe(false);
  });

  test("context_discover-style: tilde path to .ssh is rejected", () => {
    const target = "~/.ssh/id_rsa";
    const resolved = path.resolve(repoRoot, resolveTilde(target));
    expect(isPathContained(resolved, repoRoot)).toBe(false);
  });

  test("context_load-style: path within plansDir is allowed", () => {
    const plansDir = path.join(os.homedir(), ".config/opencode/plans");
    const taskFolder = path.join(plansDir, "260411-my-task");
    const resolved = resolveTilde(taskFolder);
    expect(
      isPathContained(resolved, repoRoot) || isPathContained(resolved, plansDir),
    ).toBe(true);
  });

  test("context_load-style: path outside both repo and plansDir is rejected", () => {
    const plansDir = path.join(os.homedir(), ".config/opencode/plans");
    const taskFolder = "/tmp/evil-plans";
    const resolved = resolveTilde(taskFolder);
    expect(
      isPathContained(resolved, repoRoot) || isPathContained(resolved, plansDir),
    ).toBe(false);
  });
});
