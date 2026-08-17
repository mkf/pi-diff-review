import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  getDiff,
  getDiffSmart,
  parseDiffSource,
} from "../../src/diff/source.ts";

// git error texts are locale-dependent; keep assertions on the C locale.
process.env.LC_ALL = "C";

function initRepoWithChange(dir: string, file = "example.txt"): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  writeFileSync(join(dir, file), "before\n");
  execFileSync("git", ["add", file], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial"], {
    cwd: dir,
    stdio: "ignore",
  });
  writeFileSync(join(dir, file), "after\n");
}

describe("parseDiffSource", () => {
  it("defaults to the unstaged git diff", () => {
    assert.deepEqual(parseDiffSource(""), {
      label: "unstaged git diff",
      promptLabel: "the current unstaged git diff",
      args: [],
    });
  });

  it("tokenizes git diff args with whitespace and quotes", () => {
    assert.deepEqual(
      parseDiffSource("--cached -- src/'file name.ts' \"other file.ts\""),
      {
        label: "git diff --cached -- src/'file name.ts' \"other file.ts\"",
        promptLabel:
          "`git diff --cached -- src/'file name.ts' \"other file.ts\"`",
        args: ["--cached", "--", "src/file name.ts", "other file.ts"],
      },
    );
  });

  it("supports escaped spaces outside single quotes", () => {
    assert.deepEqual(parseDiffSource("-- path\\ with\\ spaces.ts").args, [
      "--",
      "path with spaces.ts",
    ]);
  });

  it("strips pi @ path prefixes after --", () => {
    assert.deepEqual(
      parseDiffSource("main...HEAD -- @src/index.ts @'file name.ts'").args,
      ["main...HEAD", "--", "src/index.ts", "file name.ts"],
    );
  });

  it("extracts turn-based mode without passing it to git diff", () => {
    assert.deepEqual(parseDiffSource("--cached --turn-based -- @src/a.ts"), {
      label: "git diff --cached -- src/a.ts with turn-based review overlay",
      promptLabel: "`git diff --cached -- src/a.ts`",
      args: ["--cached", "--", "src/a.ts"],
      turnBased: true,
    });
  });

  it("preserves git revision syntax outside --", () => {
    assert.deepEqual(parseDiffSource("@~1").args, ["@~1"]);
    assert.deepEqual(parseDiffSource("@{upstream}").args, ["@{upstream}"]);
  });

  it("throws for unterminated quotes", () => {
    assert.throws(
      () => parseDiffSource("-- 'unterminated"),
      /Unterminated ' quote/,
    );
  });
});

describe("getDiff", () => {
  it("returns git diff output", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
    try {
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd,
      });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd });
      writeFileSync(join(cwd, "example.txt"), "before\n");
      execFileSync("git", ["add", "example.txt"], { cwd });
      execFileSync("git", ["commit", "-m", "initial"], {
        cwd,
        stdio: "ignore",
      });
      writeFileSync(join(cwd, "example.txt"), "after\n");

      const diff = getDiff(cwd, parseDiffSource(""));

      assert.match(diff, /diff --git a\/example\.txt b\/example\.txt/);
      assert.match(diff, /-before/);
      assert.match(diff, /\+after/);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("throws a friendly git error", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
    try {
      assert.throws(
        () => getDiff(cwd, parseDiffSource("")),
        /not a git repository/i,
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe("getDiffSmart", () => {
  it("reads the diff from the session cwd when it is a repository", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
    try {
      initRepoWithChange(cwd);
      const resolved = getDiffSmart(cwd, parseDiffSource(""));
      assert.match(resolved.text, /diff --git a\/example\.txt/);
      assert.equal(resolved.repoCwd, cwd);
      assert.equal(resolved.notice, undefined);
      assert.equal(resolved.titleSuffix, undefined);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("falls back to a single subdirectory repository with changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
    try {
      initRepoWithChange(join(cwd, "inner"));
      const resolved = getDiffSmart(cwd, parseDiffSource(""));
      assert.equal(resolved.repoCwd, join(cwd, "inner"));
      assert.match(resolved.text, /diff --git a\/example\.txt/);
      assert.equal(resolved.titleSuffix, " (inner/)");
      assert.match(resolved.notice ?? "", /No \.git in/);
      assert.match(resolved.notice ?? "", /inner/);
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("refuses to guess when several subdirectory repositories have changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
    try {
      initRepoWithChange(join(cwd, "one"));
      initRepoWithChange(join(cwd, "two"));
      assert.throws(
        () => getDiffSmart(cwd, parseDiffSource("")),
        /multiple subdirectory repositories: one, two/,
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("keeps git's own error when nothing at all is a repository", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
    try {
      assert.throws(
        () => getDiffSmart(cwd, parseDiffSource("")),
        /not a git repository/i,
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("reports subdirectory repositories without matching changes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-diff-review-"));
    try {
      const clean = join(cwd, "clean");
      initRepoWithChange(clean);
      execFileSync("git", ["checkout", "--", "example.txt"], { cwd: clean });
      assert.throws(
        () => getDiffSmart(cwd, parseDiffSource("")),
        /no matching changes in subdirectory repositories \(clean\)/,
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
