/**
 * Epoch ownership single-writer fence over `<runsRoot>/<run_id>/owner.lock`.
 *
 * Protocol (normative; implements frozen OwnershipFence):
 * - Creation is always O_CREAT|O_EXCL; every removal/move is an atomic
 *   rename to a unique tombstone. There is no read-then-unlink anywhere
 *   against the live lock path (#3555 defect class).
 * - Stale = PID dead OR unparseable content, AND older than the grace
 *   period. A live healthy holder yields busy — fail-closed (AC-7).
 * - Takeover: rename(lock -> tombstone) — exactly one racer wins (the rest
 *   observe ENOENT/EEXIST/EPERM and retry); the winner reads the old epoch
 *   from the tombstone it now exclusively owns and re-creates the lock at
 *   old_epoch + 1 (AC-4).
 * - Epoch continuity: `<run_dir>/owner.epoch` sidecar records the highest
 *   epoch ever issued (plain integer text, atomically persisted while we
 *   exclusively hold the lock). New creations never reissue an epoch the
 *   sidecar has seen, so resume after release keeps advancing past journal
 *   history instead of restarting at 1.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { randomBytes } from "crypto";
import { dirname, join } from "path";
import { atomicWriteFileSync } from "../../lib/atomic-write.js";
import { isProcessAlive } from "../../platform/index.js";
import { resolveRunDir } from "./run-dir.js";
import { FenceError } from "./types.js";
import type { FenceAcquireResult, FenceLockPayload, OwnershipFence } from "./types.js";

const DEFAULT_STALE_GRACE_MS = 30_000;
const LOCK_FILE_NAME = "owner.lock";
const EPOCH_FILE_NAME = "owner.epoch";

/**
 * Highest epoch ever issued for this run, parsed from the sidecar; null when
 * the sidecar is missing or unreadable (fresh run / lost continuity).
 */
function readSidecarCeiling(filePath: string): number | null {
  try {
    const value = Number.parseInt(readFileSync(filePath, "utf8").trim(), 10);
    return Number.isInteger(value) && value >= 1 ? value : null;
  } catch {
    return null;
  }
}

export interface FileOwnershipFenceOptions {
  /** Age (ms) after which a dead/unparseable lock may be taken over. Default: 30000 */
  readonly staleGraceMs?: number;
}

export class FileOwnershipFence implements OwnershipFence {
  private readonly runsRoot: string;
  private readonly runId?: string;
  private readonly staleGraceMs: number;
  /** fd of the held lock file while we own the run; null otherwise. */
  private fd: number | null = null;
  private heldEpoch: number | null = null;

  /**
   * The frozen `OwnershipFence` interface is run-scoped but carries no run
   * id, so an instance must be bound to one run. `runId` is optional only to
   * keep the brief's `new FileOwnershipFence(runsRoot)` signature
   * constructible; unbound instances fail closed on use.
   */
  constructor(
    runsRoot: string,
    runId?: string,
    options?: FileOwnershipFenceOptions,
  ) {
    this.runsRoot = runsRoot;
    this.runId = runId;
    this.staleGraceMs = options?.staleGraceMs ?? DEFAULT_STALE_GRACE_MS;
  }

  private lockPath(): string {
    if (this.runId === undefined) {
      throw new Error(
        "FileOwnershipFence is not bound to a run; pass runId to the constructor",
      );
    }
    return join(resolveRunDir(this.runsRoot, this.runId), LOCK_FILE_NAME);
  }

  async acquire(): Promise<FenceAcquireResult> {
    const lockPath = this.lockPath();
    const epochFilePath = join(dirname(lockPath), EPOCH_FILE_NAME);
    let candidateEpoch = 1;
    // Each iteration makes progress toward either acquisition or a
    // live-holder busy. The sidecar ceiling is re-read every iteration
    // because a concurrent racer may have persisted a higher epoch between
    // our attempts.
    for (;;) {
      const ceiling = readSidecarCeiling(epochFilePath);
      // Never reissue an epoch the sidecar has seen; a missing/corrupt
      // sidecar imposes no floor (fresh runs still start at epoch 1).
      const candidate = Math.max(candidateEpoch, (ceiling ?? 0) + 1);
      const fd = this.tryCreate(lockPath, epochFilePath, candidate);
      if (fd !== null) {
        this.fd = fd;
        this.heldEpoch = candidate;
        return { outcome: "acquired", epoch: candidate };
      }

      // EEXIST — inspect the existing lock best-effort.
      const existing = this.readPayload(lockPath);
      if (existing !== null && isProcessAlive(existing.pid)) {
        // Live healthy holder: fail closed, never assume multi-writer (AC-7).
        return { outcome: "busy" };
      }

      // Dead pid or unparseable content: takeover only past the grace period.
      let ageMs: number;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // Lock vanished under us; retry exclusive creation.
      }
      if (ageMs <= this.staleGraceMs) {
        return { outcome: "busy" };
      }

      // Takeover step: atomic rename to a unique tombstone. Exactly one
      // racer wins; losers observe ENOENT/EEXIST/EPERM here and retry (AC-6).
      const tombstone = `${lockPath}.tomb.${randomBytes(6).toString("hex")}`;
      try {
        renameSync(lockPath, tombstone);
      } catch {
        continue; // Another racer won the move; restart from step 1.
      }

      // We exclusively own the tombstone now: read the old epoch from it.
      // ponytail: best-effort — an unparseable tombstone falls back to
      // old_epoch 1; continuity then rests on the owner.epoch sidecar, and
      // only if BOTH are lost can an epoch value repeat. Ownership safety
      // comes from O_EXCL create + atomic rename, not from the epoch value.
      let oldEpoch = 1; // fallback per protocol when unreadable
      try {
        const parsed: unknown = JSON.parse(readFileSync(tombstone, "utf8"));
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          typeof (parsed as Record<string, unknown>).epoch === "number"
        ) {
          oldEpoch = (parsed as Record<string, unknown>).epoch as number;
        }
      } catch {
        // Unparseable tombstone: keep fallback old_epoch = 1.
      }
      try {
        unlinkSync(tombstone); // safe: unique name we exclusively own
      } catch {
        // Best-effort cleanup of our own tombstone.
      }
      candidateEpoch = oldEpoch + 1;
    }
  }

  assertEpoch(epoch: number): void {
    if (
      this.fd === null ||
      this.heldEpoch === null ||
      epoch !== this.heldEpoch ||
      !this.holdsLiveLockFile(this.lockPath())
    ) {
      throw new FenceError(
        "fenced_out",
        `epoch ${epoch} is not owned by this process (held: ${String(this.heldEpoch)})`,
      );
    }
  }

  async release(epoch: number): Promise<boolean> {
    if (this.fd === null || this.heldEpoch === null || epoch !== this.heldEpoch) {
      return false;
    }
    const lockPath = this.lockPath();
    // Identity check before any mutation: the file at the lock path must
    // still be OUR held file. A stale holder must never rename away a
    // replacement owner's lock planted at the same path.
    if (!this.holdsLiveLockFile(lockPath)) {
      // We no longer own the run; leave whatever is there untouched.
      this.clearHeld();
      return false;
    }
    const tombstone = `${lockPath}.tomb.${randomBytes(6).toString("hex")}`;
    try {
      renameSync(lockPath, tombstone);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Another process already moved the lock; we no longer own the run.
        this.clearHeld();
        return false;
      }
      throw error;
    }
    this.clearHeld();
    try {
      unlinkSync(tombstone); // safe: unique name we exclusively own
    } catch {
      // Best-effort cleanup of our own tombstone.
    }
    return true;
  }

  /**
   * Single O_EXCL creation attempt. Returns the open fd on success, null on
   * EEXIST; any other error propagates. On success the epoch sidecar is
   * atomically updated BEFORE ownership is handed out — a sidecar write
   * failure cleans up our just-created lock and propagates rather than
   * silently issuing an epoch that a later resume could reissue.
   */
  private tryCreate(
    lockPath: string,
    epochFilePath: string,
    epoch: number,
  ): number | null {
    mkdirSync(dirname(lockPath), { recursive: true });
    let fd: number;
    try {
      fd = openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return null;
      }
      throw error;
    }
    try {
      const payload: FenceLockPayload = {
        pid: process.pid,
        epoch,
        timestamp: Date.now(),
      };
      writeSync(fd, JSON.stringify(payload), null, "utf8");
      // Persist epoch continuity while we still hold exclusive ownership of
      // the just-created lock (temp+rename inside; failure cleans up below).
      atomicWriteFileSync(epochFilePath, String(epoch));
    } catch (error) {
      closeSync(fd);
      // We exclusively created this file moments ago; removing our own
      // partial write is not a read-then-unlink of a foreign lock.
      try {
        unlinkSync(lockPath);
      } catch {
        // Best effort.
      }
      throw error;
    }
    return fd;
  }

  /** Best-effort parse of the lock payload; null when absent/unparseable. */
  private readPayload(lockPath: string): FenceLockPayload | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
      if (parsed === null || typeof parsed !== "object") {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.pid !== "number" ||
        !Number.isInteger(record.pid) ||
        typeof record.epoch !== "number" ||
        typeof record.timestamp !== "number"
      ) {
        return null;
      }
      return {
        pid: record.pid,
        epoch: record.epoch,
        timestamp: record.timestamp,
      };
    } catch {
      return null;
    }
  }

  /**
   * Verify the file currently at lockPath is still the exact file we hold an
   * fd for: same inode and size (fstatSync on our held fd vs statSync on the
   * path) AND payload epoch matching heldEpoch. Any stat failure or mismatch
   * fails closed — the caller must not mutate the path.
   */
  private holdsLiveLockFile(lockPath: string): boolean {
    if (this.fd === null || this.heldEpoch === null) {
      return false;
    }
    try {
      const ours = fstatSync(this.fd);
      const theirs = statSync(lockPath);
      if (ours.ino !== theirs.ino || ours.size !== theirs.size) {
        return false;
      }
    } catch {
      // Lock path vanished or is unreadable: we do not own what is there.
      return false;
    }
    const payload = this.readPayload(lockPath);
    return payload !== null && payload.epoch === this.heldEpoch;
  }

  private clearHeld(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // Already closed.
      }
      this.fd = null;
    }
    this.heldEpoch = null;
  }
}
