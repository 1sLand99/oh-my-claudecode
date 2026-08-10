/**
 * Worktree dirty-evidence collection for abnormal agent termination (issue #3663).
 *
 * When a background agent terminates abnormally (API error / stalled mid-stream
 * / failed task-notification), its isolated git worktree can be left holding
 * uncommitted work with no checkpoint and no warning to the coordinator. This
 * module records bounded, READ-ONLY evidence about that dirty state at
 * SubagentStop time so a coordinator can see the work exists BEFORE running
 * destructive cleanup (`git reset --hard`, worktree removal, campaign clean,
 * ...).
 *
 * Safety contract:
 *  - READ-ONLY: never stages, commits, stashes, resets, or removes anything.
 *  - BOUNDED: path lists are capped and file CONTENT is never read or emitted.
 *  - FAIL-CLOSED: any git failure degrades to a structured non-dirty kind and
 *    never throws out of the hook boundary.
 *  - NO AUTO-COMMIT: checkpointing agent work is deliberately left to the
 *    coordinator. Authorship, secrets, hooks, ignored files, and partially
 *    written content are not safely boundable from this hook surface, so a
 *    silent WIP commit is never created here.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const MAX_EVIDENCE_ENTRIES = 20;
export const GIT_TIMEOUT_MS = 2500;
export const MAX_EVIDENCE_PATH_LENGTH = 200;

/** Kinds of evidence a stop hook can produce (never throws). */
export type WorktreeEvidenceKind =
  | "dirty"
  | "clean"
  | "not_git"
  | "cwd_missing"
  | "git_unavailable";

export interface WorktreeDirtyEvidence {
  kind: WorktreeEvidenceKind;
  /** Git toplevel (worktree root) when resolvable. */
  worktreeRoot?: string;
  /** True when the toplevel is a linked git worktree (`.git` is a file). */
  isLinkedWorktree: boolean;
  /** Number of changed tracked files. */
  trackedCount: number;
  /** Number of untracked files (`??`). */
  untrackedCount: number;
  /** Number of ignored files (`!!`) — informational, NOT at-risk work. */
  ignoredCount: number;
  /** Bounded relative paths (redacted: paths only, never content). */
  entries: string[];
  /** True when entries were capped at MAX_EVIDENCE_ENTRIES. */
  truncated: boolean;
  /** Bounded reason when git could not be queried. */
  error?: string;
}

export interface WorktreeEvidenceOptions {
  /** Git binary path (test seam). Defaults to "git". */
  gitCommand?: string;
  /** Per-call git timeout in ms (test seam). Defaults to GIT_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Markers of abnormal agent termination inside a stop `output` summary. */
export const ABNORMAL_TERMINATION_MARKERS =
  /(<status>failed<\/status>|Agent terminated early due to an API error|Response stalled mid-stream|API error: Response)/i;

/**
 * Whether a SubagentStop input represents an abnormal termination.
 *
 * The Claude Code SDK does not reliably set `success` on SubagentStop (it
 * defaults to "completed" when undefined), so abnormal termination is inferred
 * from an explicit failure flag OR from the failure markers Claude Code emits
 * in the stop output summary for API-error terminations (issue #3663).
 * User-initiated cancels / interrupts are NOT treated as abnormal.
 */
export function isAbnormalTermination(input: {
  success?: boolean;
  output?: string;
}): boolean {
  if (input.success === false) return true;
  if (typeof input.output !== "string" || input.output.trim() === "") {
    return false;
  }
  return ABNORMAL_TERMINATION_MARKERS.test(input.output);
}

function runGit(
  cwd: string,
  args: string[],
  opts: WorktreeEvidenceOptions,
): string {
  const git = opts.gitCommand || "git";
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  // GIT_TERMINAL_PROMPT=0 prevents credential prompts from hanging the hook;
  // GIT_OPTIONAL_LOCKS=0 keeps `git status` from taking optional index locks
  // (read-only, no contention with a concurrent coordinator).
  return execFileSync(git, args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    timeout: timeoutMs,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
}

function isLinkedWorktree(toplevel: string): boolean {
  try {
    // A linked worktree's toplevel has a `.git` FILE (gitdir: ...); the main
    // repo has a `.git` directory.
    return statSync(join(toplevel, ".git")).isFile();
  } catch {
    return false;
  }
}

function sanitizePathPart(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "?")
    .trim()
    .substring(0, MAX_EVIDENCE_PATH_LENGTH);
}

/** Extract the path from a `git status --porcelain` line (rename-aware). */
function statusEntryPath(line: string): string {
  const payload = line.slice(3);
  const renameSeparator = " -> ";
  const renameIndex = payload.indexOf(renameSeparator);
  const raw = renameIndex >= 0
    ? payload.slice(renameIndex + renameSeparator.length)
    : payload;
  return sanitizePathPart(raw);
}

const empty = (): WorktreeDirtyEvidence => ({
  kind: "clean",
  isLinkedWorktree: false,
  trackedCount: 0,
  untrackedCount: 0,
  ignoredCount: 0,
  entries: [],
  truncated: false,
});

/**
 * Collect bounded dirty-worktree evidence for a directory. READ-ONLY and
 * fail-closed: never throws, never mutates the repository.
 */
export function collectWorktreeDirtyEvidence(
  cwd: string,
  opts: WorktreeEvidenceOptions = {},
): WorktreeDirtyEvidence {
  try {
    if (!existsSync(cwd)) {
      return { ...empty(), kind: "cwd_missing", error: "cwd_missing" };
    }

    let toplevel: string;
    try {
      toplevel = runGit(cwd, ["rev-parse", "--show-toplevel"], opts).trim();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return {
          ...empty(),
          kind: "git_unavailable",
          error: `git_unavailable:${String(code)}`,
        };
      }
      return { ...empty(), kind: "not_git", error: "not_git" };
    }
    if (!toplevel) return { ...empty(), kind: "not_git", error: "not_git" };

    const linked = isLinkedWorktree(toplevel);

    // Two bounded read-only calls: regular status (tracked+untracked) and
    // ignored status (informational — ignored files are not at-risk work).
    const status = runGit(toplevel, ["status", "--porcelain"], opts);
    const ignoredStatus = runGit(
      toplevel,
      ["status", "--porcelain", "--ignored=matching"],
      opts,
    );

    const tracked: string[] = [];
    const untracked: string[] = [];
    const ignored: string[] = [];
    for (const line of status.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("??")) {
        untracked.push(statusEntryPath(line));
      } else {
        tracked.push(statusEntryPath(line));
      }
    }
    for (const line of ignoredStatus.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("!!")) {
        ignored.push(statusEntryPath(line));
      }
    }

    const all = [...tracked, ...untracked, ...ignored];
    const truncated = all.length > MAX_EVIDENCE_ENTRIES;
    const entries = all.slice(0, MAX_EVIDENCE_ENTRIES);

    return {
      kind: tracked.length + untracked.length > 0 ? "dirty" : "clean",
      worktreeRoot: sanitizePathPart(toplevel),
      isLinkedWorktree: linked,
      trackedCount: tracked.length,
      untrackedCount: untracked.length,
      ignoredCount: ignored.length,
      entries,
      truncated,
    };
  } catch {
    // Fail-closed: any unexpected git/filesystem failure must not break the
    // stop hook and must not claim the worktree is dirty.
    return { ...empty(), kind: "git_unavailable", error: "evidence_failed" };
  }
}

/**
 * Build a bounded, redacted coordinator-facing notice for dirty-worktree
 * evidence. Returns null when there is nothing to warn about (clean, non-git,
 * missing cwd, git unavailable).
 */
export function buildDirtyWorktreeNotice(
  evidence: WorktreeDirtyEvidence,
  agentId: string,
  agentType: string,
): string | null {
  if (evidence.kind !== "dirty" || !evidence.worktreeRoot) return null;
  const total = evidence.trackedCount + evidence.untrackedCount;
  const shortId = sanitizePathPart(agentId).substring(0, 7) || "agent";
  const type = sanitizePathPart(agentType).substring(0, 40) || "subagent";
  return (
    `[OMC] Agent ${shortId} (${type}) terminated with ${total} uncommitted file(s) ` +
    `(${evidence.trackedCount} tracked, ${evidence.untrackedCount} untracked) in ` +
    `${evidence.worktreeRoot}. Preserve this worktree before destructive cleanup; ` +
    `OMC does not auto-commit agent work.`
  );
}
