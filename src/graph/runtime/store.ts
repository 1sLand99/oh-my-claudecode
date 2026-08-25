/**
 * File-backed projection snapshot store (graph runtime v2).
 *
 * Implements ProjectionStore over `<runsRoot>/<run_id>/projection.json`.
 * The journal is the source of truth; this snapshot only accelerates resume
 * and serves status. Every persist goes through temp+rename
 * (atomicWriteJsonSync); every read fails closed on corruption (AC-3).
 */

import { readFileSync } from "fs";
import { join } from "path";

import { atomicWriteJsonSync } from "../../lib/atomic-write.js";

import { resolveRunDir } from "./run-dir.js";
import type {
  ProjectionSnapshotEnvelope,
  ProjectionStore,
} from "./types.js";

const DESCRIPTOR_HASH_PATTERN = /^[a-f0-9]{64}$/;
const PROJECTION_FILE_NAME = "projection.json";

/** Closed error surface for projection snapshot failures. */
export class ProjectionStoreError extends Error {
  readonly code: "descriptor_mismatch" | "corrupt";

  constructor(code: "descriptor_mismatch" | "corrupt", message: string) {
    super(message);
    this.name = "ProjectionStoreError";
    this.code = code;
  }
}

/**
 * Validates an untrusted parsed envelope; returns it typed or throws corrupt.
 * Fail-closed: never returns partial data (AC-3).
 */
function parseStoredEnvelope(raw: unknown): ProjectionSnapshotEnvelope {
  if (typeof raw !== "object" || raw === null) {
    throw new ProjectionStoreError(
      "corrupt",
      "projection snapshot is not a JSON object",
    );
  }
  const candidate = raw as ProjectionSnapshotEnvelope;
  if (candidate.schema_version !== 1) {
    throw new ProjectionStoreError(
      "corrupt",
      `unsupported projection schema_version: ${String(candidate.schema_version)}`,
    );
  }
  if (
    typeof candidate.descriptor_hash !== "string" ||
    !DESCRIPTOR_HASH_PATTERN.test(candidate.descriptor_hash)
  ) {
    throw new ProjectionStoreError(
      "corrupt",
      "descriptor_hash is not a lowercase sha256 hex digest",
    );
  }
  return candidate;
}

/** Load/save surface over one run's `<run_id>/projection.json`. */
export class FileProjectionStore implements ProjectionStore {
  private readonly filePath: string;

  constructor(runsRoot: string, runId: string) {
    this.filePath = join(resolveRunDir(runsRoot, runId), PROJECTION_FILE_NAME);
  }

  async save(envelope: ProjectionSnapshotEnvelope): Promise<void> {
    if (envelope.schema_version !== 1) {
      throw new ProjectionStoreError(
        "corrupt",
        "envelope schema_version must be 1",
      );
    }

    // Binding check first (AC-3): the path is bound to one descriptor/run/revision.
    // A corrupt snapshot is a cache-miss here, not run-fatal: the journal is
    // the source of truth, so treat it as absent and proceed with the overwrite.
    let stored: ProjectionSnapshotEnvelope | null;
    try {
      stored = await this.load();
    } catch (err) {
      if (!(err instanceof ProjectionStoreError) || err.code !== "corrupt") {
        throw err;
      }
      stored = null;
    }
    if (
      stored !== null &&
      (envelope.descriptor_hash !== stored.descriptor_hash ||
        envelope.run_id !== stored.run_id ||
        envelope.revision_id !== stored.revision_id)
    ) {
      throw new ProjectionStoreError(
        "descriptor_mismatch",
        `snapshot path bound to descriptor ${stored.descriptor_hash}, run ${stored.run_id}, revision ${stored.revision_id}`,
      );
    }

    atomicWriteJsonSync(this.filePath, envelope);
  }

  async load(): Promise<ProjectionSnapshotEnvelope | null> {
    let content: string;
    try {
      content = readFileSync(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }

    try {
      return parseStoredEnvelope(JSON.parse(content));
    } catch (err) {
      if (err instanceof ProjectionStoreError) {
        throw err;
      }
      throw new ProjectionStoreError(
        "corrupt",
        "projection.json is not valid JSON",
      );
    }
  }
}
