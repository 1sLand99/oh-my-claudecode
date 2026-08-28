/**
 * Run-directory containment for graph runtime persistence (P1-3).
 *
 * Every persisted artifact lives under `<runsRoot>/<run_id>/`. A run_id is
 * descriptor-supplied and therefore untrusted: resolving it must never let a
 * traversal-shaped id or a symlinked run directory redirect writes outside
 * the runs root. resolveRunDir validates, creates, and containment-checks
 * the directory with a Linux directory FD, failing closed on any escape or
 * on platforms without that primitive.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "fs";
import { join, sep } from "path";

import { ensureDirSync } from "../../lib/atomic-write.js";

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface RunDirHandle {
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

/**
 * Resolve (and create) the contained run directory for one run.
 *
 * Returns the plain `join(runsRoot, runId)` path so existing relative
 * behaviors stay stable; containment is enforced against an open directory
 * FD before returning. Throws RangeError("invalid run_id") on malformed ids
 * and Error on symlinked or escaping directories.
 */
export function resolveRunDir(runsRoot: string, runId: string): string {
  return resolveRunDirHandle(runsRoot, runId).path;
}

/** Resolve a run directory and capture the directory identity for safe I/O. */
export function resolveRunDirHandle(
  runsRoot: string,
  runId: string,
): RunDirHandle {
  // Charset check plus defense-in-depth separators/dot segments: the regex
  // already excludes them, but reject explicitly so traversal can never ride
  // on a future pattern relaxation.
  if (
    typeof runId !== "string" ||
    !RUN_ID_PATTERN.test(runId) ||
    runId.includes("/") ||
    runId.includes("\\") ||
    runId === "." ||
    runId === ".."
  ) {
    throw new RangeError("invalid run_id");
  }

  if (process.platform !== "linux") {
    throw new Error(
      `contained directory-FD traversal is unavailable on ${process.platform}; refusing pathname fallback`,
    );
  }

  ensureDirSync(runsRoot);
  const runsRootReal = realpathSync(runsRoot);

  const target = join(runsRoot, runId);
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    // Absent (ENOENT or stat failure): nothing to reject yet; created below.
  }
  if (stats !== undefined && stats.isSymbolicLink()) {
    // Fail closed: a symlinked run dir could redirect every write below it.
    throw new Error("run directory must not be a symbolic link");
  }
  mkdirSync(target, { recursive: true });

  // Keep the directory open while both containment and identity are checked.
  // Resolving the path and then statting `target` separately permits a rename
  // or replacement between those operations; fstatSync binds the identity to
  // the same directory object that was containment-checked.
  const directoryFd = openSync(
    target,
    fsConstants.O_RDONLY |
      (fsConstants.O_DIRECTORY ?? 0) |
      (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const resolved = realpathSync(`/proc/self/fd/${directoryFd}`);
    const prefixCmp = `${runsRootReal}${sep}`;
    if (!resolved.startsWith(prefixCmp)) {
      throw new Error(
        `run directory ${resolved} escapes the persistence root ${runsRootReal}`,
      );
    }

    const identity = fstatSync(directoryFd);
    return { path: target, device: identity.dev, inode: identity.ino };
  } finally {
    closeSync(directoryFd);
  }
}
