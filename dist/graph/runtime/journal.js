/**
 * Append-only OCC journal over `<runsRoot>/<run_id>/journal.jsonl`.
 *
 * The journal persists committed records with an envelope fingerprint that
 * includes seq/epoch/descriptor_hash/transition. It validates envelope shape
 * and the fingerprint format on read (fail-closed). Deep transition
 * validation happens at the scheduler replay fold; epoch ownership fencing is
 * a runner-level concern (OwnershipFence).
 */
import { closeSync, constants as fsConstants, fsyncSync, writeSync, } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { canonicalJson } from "../descriptor.js";
import { resolveRunDirHandle } from "./run-dir.js";
import { openNoFollow, readContainedFileNoFollow, withContainedPath, } from "./safe-fs.js";
import { JournalCorruptionError } from "./types.js";
const DESCRIPTOR_HASH_PATTERN = /^[a-f0-9]{64}$/;
const JOURNAL_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
/**
 * Authenticates the runtime envelope binding, including the writer epoch.
 * Scheduler request fingerprints intentionally remain Graph Core concerns;
 * this digest binds the runtime-only epoch to the exact committed record.
 */
export function computeJournalFingerprint(record) {
    const unsignedRecord = { ...record };
    delete unsignedRecord.journal_fingerprint;
    return createHash("sha256")
        .update(canonicalJson(unsignedRecord))
        .digest("hex");
}
/** Envelope validation for one parsed record; returns an error message or null. */
function envelopeError(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return "record is not an object";
    }
    const record = value;
    if (typeof record.seq !== "number" ||
        !Number.isInteger(record.seq) ||
        record.seq < 0) {
        return "seq must be an integer >= 0";
    }
    if (typeof record.epoch !== "number" ||
        !Number.isInteger(record.epoch) ||
        record.epoch < 1) {
        return "epoch must be an integer >= 1";
    }
    if (typeof record.descriptor_hash !== "string" ||
        !DESCRIPTOR_HASH_PATTERN.test(record.descriptor_hash)) {
        return "descriptor_hash must match /^[a-f0-9]{64}$/";
    }
    if (record.transition === null ||
        typeof record.transition !== "object" ||
        Array.isArray(record.transition)) {
        return "transition must be present as an object";
    }
    if (typeof record.journal_fingerprint !== "string" ||
        !JOURNAL_FINGERPRINT_PATTERN.test(record.journal_fingerprint)) {
        return "journal_fingerprint must be a lowercase sha256 hex digest";
    }
    return null;
}
export class FileJournal {
    runsRoot;
    runId;
    /**
     * The frozen `Journal` interface is run-scoped but carries no run id, so an
     * instance must be bound to one run. `runId` is optional only to keep the
     * brief's `new FileJournal(runsRoot)` signature constructible; unbound
     * instances fail closed on use.
     */
    constructor(runsRoot, runId) {
        this.runsRoot = runsRoot;
        this.runId = runId;
    }
    async append(record) {
        const runDir = this.runDir();
        const unsignedRecord = { ...record };
        delete unsignedRecord.journal_fingerprint;
        const committed = {
            ...unsignedRecord,
            journal_fingerprint: computeJournalFingerprint(unsignedRecord),
        };
        const line = `${canonicalJson(committed)}\n`;
        // O_APPEND single writeSync + fsync: one complete line per append by contract.
        withContainedPath(runDir, "journal.jsonl", (filePath) => {
            let fd;
            try {
                fd = openNoFollow(filePath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY);
            }
            catch (error) {
                if (error.code === "ELOOP") {
                    throw new JournalCorruptionError(`journal ${filePath} is a symbolic link`, 1);
                }
                throw error;
            }
            try {
                writeSync(fd, line);
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
        });
    }
    runDir() {
        if (this.runId === undefined) {
            throw new Error("FileJournal is not bound to a run; pass runId to the constructor");
        }
        return resolveRunDirHandle(this.runsRoot, this.runId);
    }
    async readAll() {
        const runDir = this.runDir();
        const filePath = join(runDir.path, "journal.jsonl");
        let content;
        try {
            content = readContainedFileNoFollow(runDir, "journal.jsonl");
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return [];
            }
            if (error.code === "ELOOP") {
                throw new JournalCorruptionError(`journal ${filePath} is a symbolic link`, 1);
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
        const records = [];
        let prevSeq = -1;
        for (const line of bodyLines) {
            let failure = null;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                failure = "line is not valid JSON";
            }
            if (failure === null) {
                failure = envelopeError(parsed);
            }
            if (failure === null) {
                const record = parsed;
                const expectedSeq = prevSeq + 1;
                if (record.seq !== expectedSeq) {
                    failure = `seq ${record.seq} does not continue from ${prevSeq}`;
                }
                else {
                    prevSeq = record.seq;
                    records.push(record);
                }
            }
            if (failure !== null) {
                badCount += 1;
            }
        }
        if (badCount > 0) {
            throw new JournalCorruptionError(`journal ${filePath} has ${badCount} corrupt or incomplete record(s)`, badCount);
        }
        return records;
    }
}
//# sourceMappingURL=journal.js.map