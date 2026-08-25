import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
} from "fs";
import { join } from "path";
import type { RunDirHandle } from "./run-dir.js";

const NO_FOLLOW = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;

/** Open a runtime artifact without following a symlink at the final path. */
export function openNoFollow(
  filePath: string,
  flags: number,
  mode = 0o600,
): number {
  if (process.platform === "win32") {
    try {
      if (lstatSync(filePath).isSymbolicLink()) {
        const error = new Error(`symbolic link refused: ${filePath}`) as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") throw error;
      // Let openSync report ordinary permission and path errors.
    }
  }
  return openSync(filePath, flags | NO_FOLLOW, mode);
}

/** Read a runtime artifact without following a symlink at the final path. */
export function readFileNoFollow(filePath: string): string {
  const fd = openNoFollow(filePath, fsConstants.O_RDONLY);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function descriptorPath(directoryFd: number): string {
  if (process.platform === "linux") return `/proc/self/fd/${directoryFd}`;
  return `/dev/fd/${directoryFd}`;
}

/**
 * Run a synchronous operation against a directory FD on POSIX. If the
 * directory is renamed or its parent path is replaced while the operation is
 * in flight, the FD still refers to the originally validated directory.
 * Windows falls back to the final-component no-follow guard.
 */
export function withContainedPath<T>(
  runDir: RunDirHandle,
  fileName: string,
  operation: (filePath: string) => T,
): T {
  if (process.platform === "win32") {
    const stats = statSync(runDir.path);
    if (stats.dev !== runDir.device || stats.ino !== runDir.inode) {
      throw new Error("run directory identity changed");
    }
    return operation(join(runDir.path, fileName));
  }
  const directoryFd = openNoFollow(
    runDir.path,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
  );
  try {
    const stats = fstatSync(directoryFd);
    if (stats.dev !== runDir.device || stats.ino !== runDir.inode) {
      throw new Error("run directory identity changed");
    }
    return operation(join(descriptorPath(directoryFd), fileName));
  } finally {
    closeSync(directoryFd);
  }
}

/** Read a named artifact through a validated run-directory handle. */
export function readContainedFileNoFollow(
  runDir: RunDirHandle,
  fileName: string,
): string {
  return withContainedPath(runDir, fileName, readFileNoFollow);
}

