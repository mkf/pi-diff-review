import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { DiffSource } from "../review/types.ts";
import { tokenizeShellArgs } from "../shared/args.ts";

export function parseDiffSource(args: string): DiffSource {
  const trimmed = args.trim();
  if (!trimmed) {
    return {
      label: "unstaged git diff",
      promptLabel: "the current unstaged git diff",
      args: [],
    };
  }

  const { gitArgs, turnBased } = parseDiffArgs(trimmed);
  if (!turnBased) {
    return {
      label: `git diff ${trimmed}`,
      promptLabel: `\`git diff ${trimmed}\``,
      args: gitArgs,
    };
  }

  const gitDiffLabel =
    gitArgs.length > 0 ? `git diff ${gitArgs.join(" ")}` : "unstaged git diff";
  const promptLabel =
    gitArgs.length > 0
      ? `\`git diff ${gitArgs.join(" ")}\``
      : "the current unstaged git diff";

  return {
    label: `${gitDiffLabel} with turn-based review overlay`,
    promptLabel,
    args: gitArgs,
    turnBased: true,
  };
}

function parseDiffArgs(input: string): {
  gitArgs: string[];
  turnBased: boolean;
} {
  try {
    const tokens = tokenizeShellArgs(input);
    const { args, turnBased } = extractDiffReviewFlags(tokens);
    return {
      gitArgs: normalizeDiffPathspecs(args),
      turnBased,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/in arguments$/, "in git diff args"));
  }
}

function extractDiffReviewFlags(tokens: string[]): {
  args: string[];
  turnBased: boolean;
} {
  const args: string[] = [];
  let turnBased = false;
  let passthrough = false;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "--") {
      passthrough = true;
      args.push(token);
      continue;
    }

    if (!passthrough && token === "--turn-based") {
      if (turnBased) {
        throw new Error("--turn-based can only be provided once");
      }
      turnBased = true;
      continue;
    }

    args.push(token);
  }

  return { args, turnBased };
}

function normalizeDiffPathspecs(args: string[]): string[] {
  const separatorIndex = args.indexOf("--");
  if (separatorIndex < 0) return args;

  return args.map((arg, index) =>
    index > separatorIndex && arg.startsWith("@") ? arg.slice(1) : arg,
  );
}

export const DIFF_MAX_BUFFER_BYTES = 128 * 1024 * 1024;

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", LANG: "C" };
}

export function getDiff(cwd: string, source: DiffSource): string {
  const args = ["diff", "--no-color", "--unified=3", ...source.args];
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
    maxBuffer: DIFF_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(formatSpawnError(result.error));
  }

  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      stderr || `git ${args.join(" ")} exited with status ${result.status}.`,
    );
  }

  return result.stdout;
}

/**
 * A diff that got a working tree, possibly after falling back to a
 * subdirectory repository when `cwd` itself is not inside one.
 */
export type ResolvedDiff = {
  /** Diff text (git output for the repository at `repoCwd`). */
  text: string;
  /** Directory the diff was actually taken from (cwd or a subdirectory). */
  repoCwd: string;
  /** Title suffix distinguishing the subdirectory (e.g. " (src/)"). */
  titleSuffix?: string;
  /** User-facing notice when the fallback was used. */
  notice?: string;
};

function isGitWorkTree(cwd: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

function subdirectoryRepos(cwd: string): string[] {
  let entries;
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        !entry.name.startsWith(".") &&
        (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map((entry) => join(cwd, entry.name))
    .filter((dir) => isGitWorkTree(dir))
    .sort((a, b) => basename(a).localeCompare(basename(b)));
}

export function getDiffSmart(cwd: string, source: DiffSource): ResolvedDiff {
  if (isGitWorkTree(cwd)) {
    return { text: getDiff(cwd, source), repoCwd: cwd };
  }

  const repos = subdirectoryRepos(cwd);
  if (repos.length === 0) {
    // Surface git's own "not a git repository" error for `cwd`.
    return { text: getDiff(cwd, source), repoCwd: cwd };
  }

  const changed: ResolvedDiff[] = [];
  const errors: Error[] = [];
  for (const repo of repos) {
    try {
      const text = getDiff(repo, source);
      if (text.trim()) {
        changed.push({
          text,
          repoCwd: repo,
          titleSuffix: ` (${basename(repo)}/)`,
        });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (changed.length === 1) {
    const only = changed[0]!;
    return {
      ...only,
      notice: `No .git in ${cwd}; reviewing changes in ${basename(only.repoCwd)}/.`,
    };
  }

  if (changed.length > 1) {
    const names = changed.map(({ repoCwd }) => basename(repoCwd)).join(", ");
    throw new Error(
      `No .git in ${cwd}; changes found in multiple subdirectory repositories: ` +
        `${names}. Run /diff from inside one of them.`,
    );
  }

  if (errors.length > 0) {
    const details = errors.map((error) => error.message).join("\n");
    throw new Error(
      `No .git in ${cwd}; git failed in subdirectory repositories:\n${details}`,
    );
  }

  return { text: "", repoCwd: repos[0]! };
}

function formatSpawnError(error: Error & { code?: string }): string {
  if (error.code === "ENOBUFS") {
    return `Diff output exceeded the ${formatBytes(DIFF_MAX_BUFFER_BYTES)} safety limit. Try reviewing a smaller diff or narrowing with git diff pathspecs.`;
  }

  return error.message;
}

function formatBytes(bytes: number): string {
  const mib = bytes / 1024 / 1024;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}
