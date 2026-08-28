import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, statSync, } from "fs";
import { join } from "path";
const NO_FOLLOW = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
/** Open a runtime artifact without following a symlink at the final path. */
export function openNoFollow(filePath, flags, mode = 0o600) {
    if (process.platform === "win32") {
        try {
            if (lstatSync(filePath).isSymbolicLink()) {
                const error = new Error(`symbolic link refused: ${filePath}`);
                error.code = "ELOOP";
                throw error;
            }
        }
        catch (error) {
            if (error.code === "ELOOP")
                throw error;
            // Let openSync report ordinary permission and path errors.
        }
    }
    return openSync(filePath, flags | NO_FOLLOW, mode);
}
/** Read a runtime artifact without following a symlink at the final path. */
export function readFileNoFollow(filePath) {
    const fd = openNoFollow(filePath, fsConstants.O_RDONLY);
    try {
        return readFileSync(fd, "utf8");
    }
    finally {
        closeSync(fd);
    }
}
/**
 * Resolve a path for an already-open run directory without changing the
 * process-wide platform state. Linux exposes directory FDs as traversable
 * procfs directories. macOS (and other non-Linux POSIX platforms) does not,
 * so use the validated run-directory path and retain the final-component
 * no-follow guard in openNoFollow.
 */
export function containedPathForPlatform(directoryFd, runDirPath, fileName, platform = process.platform) {
    if (platform === "linux") {
        return join(`/proc/self/fd/${directoryFd}`, fileName);
    }
    return join(runDirPath, fileName);
}
/**
 * Run a synchronous operation against a directory FD on POSIX. If the
 * directory is renamed or its parent path is replaced while the operation is
 * in flight, the FD still refers to the originally validated directory.
 * Windows falls back to the final-component no-follow guard.
 */
export function withContainedPath(runDir, fileName, operation) {
    return withContainedPathForPlatform(runDir, fileName, operation, process.platform);
}
export function withContainedPathForPlatform(runDir, fileName, operation, platform) {
    if (platform !== "linux") {
        // Non-Linux POSIX systems cannot traverse a directory FD via /dev/fd.
        // The identity check immediately before operation plus O_NOFOLLOW on the
        // final artifact preserves the available portable guarantees, but cannot
        // eliminate a parent-directory swap racing this synchronous call.
        const stats = statSync(runDir.path);
        if (stats.dev !== runDir.device || stats.ino !== runDir.inode) {
            throw new Error("run directory identity changed");
        }
        return operation(join(runDir.path, fileName));
    }
    const directoryFd = openNoFollow(runDir.path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    try {
        const stats = fstatSync(directoryFd);
        if (stats.dev !== runDir.device || stats.ino !== runDir.inode) {
            throw new Error("run directory identity changed");
        }
        return operation(containedPathForPlatform(directoryFd, runDir.path, fileName, platform));
    }
    finally {
        closeSync(directoryFd);
    }
}
/** Read a named artifact through a validated run-directory handle. */
export function readContainedFileNoFollow(runDir, fileName) {
    return withContainedPath(runDir, fileName, readFileNoFollow);
}
//# sourceMappingURL=safe-fs.js.map