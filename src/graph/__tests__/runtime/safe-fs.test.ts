import {
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRunDirHandle } from "../../runtime/run-dir.js";
import {
  containedPathForPlatform,
  openNoFollow,
  readContainedFileNoFollow,
  withContainedPathForPlatform,
} from "../../runtime/safe-fs.js";

describe("graph runtime safe filesystem", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true });
    }
  });

  function makeRunDir(runId = "run-safe-fs") {
    const root = mkdtempSync(join(tmpdir(), "omc-safe-fs-test-"));
    tempDirs.push(root);
    const handle = resolveRunDirHandle(root, runId);
    return { root, handle };
  }

  it("uses traversable procfs only for Linux and does not mutate platform state", () => {
    const before = process.platform;

    expect(
      containedPathForPlatform(7, "/runs/example", "artifact", "linux"),
    ).toBe("/proc/self/fd/7/artifact");
    expect(
      containedPathForPlatform(7, "/runs/example", "artifact", "darwin"),
    ).toBe("/runs/example/artifact");
    expect(
      containedPathForPlatform(7, "C:/runs/example", "artifact", "win32"),
    ).toBe("C:/runs/example/artifact");

    expect(process.platform).toBe(before);
  });

  it("reads, writes, renames, and deletes artifacts through a validated Linux directory FD", () => {
    const { handle } = makeRunDir();
    const artifact = join(handle.path, "artifact.txt");
    writeFileSync(artifact, "before");

    expect(readContainedFileNoFollow(handle, "artifact.txt")).toBe("before");
    withContainedPathForPlatform(
      handle,
      "artifact.txt",
      (path) => {
        writeFileSync(path, "after");
        renameSync(path, join(handle.path, "renamed.txt"));
      },
      "linux",
    );
    expect(readFileSync(join(handle.path, "renamed.txt"), "utf8")).toBe(
      "after",
    );

    withContainedPathForPlatform(
      handle,
      "renamed.txt",
      (path) => rmSync(path),
      "linux",
    );
    expect(existsSync(join(handle.path, "renamed.txt"))).toBe(false);
  });

  it("rejects a final artifact symlink on Linux and darwin path fallback", () => {
    const { root, handle } = makeRunDir();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(handle.path, "artifact.txt"));

    expect(() => readContainedFileNoFollow(handle, "artifact.txt")).toThrow();
    expect(() =>
      withContainedPathForPlatform(
        handle,
        "artifact.txt",
        (path) => openNoFollow(path, constants.O_RDONLY),
        "darwin",
      ),
    ).toThrow();
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  it("rejects an identity change before a darwin fallback operation", () => {
    const { root, handle } = makeRunDir();
    const replacement = join(root, "replacement");
    mkdirSync(replacement);
    renameSync(handle.path, join(root, "old-run"));
    renameSync(replacement, handle.path);

    expect(() =>
      withContainedPathForPlatform(
        handle,
        "artifact.txt",
        () => undefined,
        "darwin",
      ),
    ).toThrow("run directory identity changed");
  });

  it("keeps the Windows path fallback and identity guard unchanged", () => {
    const { handle } = makeRunDir();
    const artifact = join(handle.path, "artifact.txt");
    writeFileSync(artifact, "windows-compatible");

    expect(
      withContainedPathForPlatform(
        handle,
        "artifact.txt",
        (path) => readFileSync(path, "utf8"),
        "win32",
      ),
    ).toBe("windows-compatible");
  });

  it("preserves ordinary ENOENT behavior for missing artifacts", () => {
    const { handle } = makeRunDir();

    expect(() => readContainedFileNoFollow(handle, "missing.txt")).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});
