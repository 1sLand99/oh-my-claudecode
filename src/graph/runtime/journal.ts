/**
 * Append-only OCC journal over `<runsRoot>/<run_id>/journal.jsonl`.
 *
 * The journal stays deliberately dumb: it persists records verbatim and
 * validates envelope shape on read (seq/epoch/descriptor_hash/transition
 * presence, fail-closed). Deep transition validation happens at the
 * scheduler replay fold; epoch ownership fencing is a runner-level concern
 * (OwnershipFence) — the binding lives inside each record.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "fs";
import { dirname, join } from "path";
import { canonicalJson } from "../descriptor.js";
import { JournalCorruptionError } from "./types.js";
import type { Journal, JournalRecord } from "./types.js";

const DESCRIPTOR_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** Envelope validation for one parsed record; returns an error message or null. */
function envelopeError(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "record is not an object";
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.seq !== "number" ||
    !Number.isInteger(record.seq) ||
    record.seq < 0
  ) {
    return "seq must be an integer >= 0";
  }
  if (
    typeof record.epoch !== "number" ||
    !Number.isInteger(record.epoch) ||
    record.epoch < 1
  ) {
    return "epoch must be an integer >= 1";
  }
  if (
    typeof record.descriptor_hash !== "string" ||
    !DESCRIPTOR_HASH_PATTERN.test(record.descriptor_hash)
  ) {
    return "descriptor_hash must match /^[a-f0-9]{64}$/";
  }
  if (
    record.transition === null ||
    typeof record.transition !== "object" ||
    Array.isArray(record.transition)
  ) {
    return "transition must be present as an object";
  }
  return null;
}

export class FileJournal implements Journal {
  private readonly runsRoot: string;
  private readonly runId?: string;

  /**
   * The frozen `Journal` interface is run-scoped but carries no run id, so an
   * instance must be bound to one run. `runId` is optional only to keep the
   * brief's `new FileJournal(runsRoot)` signature constructible; unbound
   * instances fail closed on use.
   */
  constructor(runsRoot: string, runId?: string) {
    this.runsRoot = runsRoot;
    this.runId = runId;
  }

  private journalPath(): string {
    if (this.runId === undefined) {
      throw new Error(
        "FileJournal is not bound to a run; pass runId to the constructor",
      );
    }
    return join(this.runsRoot, this.runId, "journal.jsonl");
  }

  async append(record: JournalRecord): Promise<void> {
    const filePath = this.journalPath();
    const line = `${canonicalJson(record)}\n`;
    // O_APPEND single writeSync + fsync: one complete line per append by contract.
    mkdirSync(dirname(filePath), { recursive: true });
    const fd = openSync(filePath, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  async readAll(): Promise<readonly JournalRecord[]> {
    const filePath = this.journalPath();
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    if (content.length === 0) {
      return [];
    }

    const lines = content.split("\n");
    const tailIsIncomplete = lines[lines.length - 1] !== "";
    // Complete lines are everything before the final split element (which is
    // "" for a well-formed file, or the partial tail being dropped).
    const bodyLines = lines.slice(0, -1);

    // Count ALL bad lines (interior + incomplete tail) before throwing once.
    let badCount = tailIsIncomplete ? 1 : 0;
    const records: JournalRecord[] = [];
    let prevSeq = -1;

    for (const line of bodyLines) {
      let failure: string | null = null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        failure = "line is not valid JSON";
      }
      if (failure === null) {
        failure = envelopeError(parsed);
      }
      if (failure === null) {
        const record = parsed as JournalRecord;
        const expectedSeq = prevSeq + 1;
        if (record.seq !== expectedSeq) {
          failure = `seq ${record.seq} does not continue from ${prevSeq}`;
        } else {
          prevSeq = record.seq;
          records.push(record);
        }
      }
      if (failure !== null) {
        badCount += 1;
      }
    }

    if (badCount > 0) {
      throw new JournalCorruptionError(
        `journal ${filePath} has ${badCount} corrupt or incomplete record(s)`,
        badCount,
      );
    }
    return records;
  }
}
