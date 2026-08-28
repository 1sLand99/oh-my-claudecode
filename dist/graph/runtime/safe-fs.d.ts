import type { RunDirHandle } from "./run-dir.js";
/** Open a runtime artifact without following a symlink at the final path. */
export declare function openNoFollow(filePath: string, flags: number, mode?: number): number;
/** Read a runtime artifact without following a symlink at the final path. */
export declare function readFileNoFollow(filePath: string): string;
/**
 * Resolve a path for an already-open run directory without changing the
 * process-wide platform state. Linux exposes directory FDs as traversable
 * procfs directories. macOS (and other non-Linux POSIX platforms) does not,
 * so use the validated run-directory path and retain the final-component
 * no-follow guard in openNoFollow.
 */
export declare function containedPathForPlatform(directoryFd: number, runDirPath: string, fileName: string, platform?: NodeJS.Platform): string;
/**
 * Run a synchronous operation against a directory FD on POSIX. If the
 * directory is renamed or its parent path is replaced while the operation is
 * in flight, the FD still refers to the originally validated directory.
 * Windows falls back to the final-component no-follow guard.
 */
export declare function withContainedPath<T>(runDir: RunDirHandle, fileName: string, operation: (filePath: string) => T): T;
export declare function withContainedPathForPlatform<T>(runDir: RunDirHandle, fileName: string, operation: (filePath: string) => T, platform: NodeJS.Platform): T;
/** Read a named artifact through a validated run-directory handle. */
export declare function readContainedFileNoFollow(runDir: RunDirHandle, fileName: string): string;
//# sourceMappingURL=safe-fs.d.ts.map