/**
 * Run-directory containment for graph runtime persistence (P1-3).
 *
 * Every persisted artifact lives under `<runsRoot>/<run_id>/`. A run_id is
 * descriptor-supplied and therefore untrusted: resolving it must never let a
 * traversal-shaped id or a symlinked run directory redirect writes outside
 * the runs root. resolveRunDir validates, creates, and containment-checks
 * the directory, failing closed on any escape.
 */
import { lstatSync, mkdirSync, realpathSync, statSync } from "fs";
import { join, sep } from "path";
import { ensureDirSync } from "../../lib/atomic-write.js";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/**
 * Resolve (and create) the contained run directory for one run.
 *
 * Returns the plain `join(runsRoot, runId)` path so existing relative
 * behaviors stay stable; containment is enforced against realpaths before
 * returning. Throws RangeError("invalid run_id") on malformed ids and Error
 * on symlinked or escaping directories.
 */
export function resolveRunDir(runsRoot, runId) {
    return resolveRunDirHandle(runsRoot, runId).path;
}
/** Resolve a run directory and capture the directory identity for safe I/O. */
export function resolveRunDirHandle(runsRoot, runId) {
    // Charset check plus defense-in-depth separators/dot segments: the regex
    // already excludes them, but reject explicitly so traversal can never ride
    // on a future pattern relaxation.
    if (typeof runId !== "string" ||
        !RUN_ID_PATTERN.test(runId) ||
        runId.includes("/") ||
        runId.includes("\\") ||
        runId === "." ||
        runId === "..") {
        throw new RangeError("invalid run_id");
    }
    ensureDirSync(runsRoot);
    const runsRootReal = realpathSync(runsRoot);
    const target = join(runsRoot, runId);
    let stats;
    try {
        stats = lstatSync(target);
    }
    catch {
        // Absent (ENOENT or stat failure): nothing to reject yet; created below.
    }
    if (stats !== undefined && stats.isSymbolicLink()) {
        // Fail closed: a symlinked run dir could redirect every write below it.
        throw new Error("run directory must not be a symbolic link");
    }
    mkdirSync(target, { recursive: true });
    const resolved = realpathSync(target);
    const isWin32 = process.platform === "win32";
    const resolvedCmp = isWin32 ? resolved.toLowerCase() : resolved;
    const prefixCmp = isWin32
        ? `${runsRootReal}${sep}`.toLowerCase()
        : `${runsRootReal}${sep}`;
    if (!resolvedCmp.startsWith(prefixCmp)) {
        throw new Error(`run directory ${resolved} escapes the persistence root ${runsRootReal}`);
    }
    const identity = statSync(target);
    return { path: target, device: identity.dev, inode: identity.ino };
}
//# sourceMappingURL=run-dir.js.map