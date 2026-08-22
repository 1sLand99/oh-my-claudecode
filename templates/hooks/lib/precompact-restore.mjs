// PreCompact checkpoint restore helper (issue #3730).
//
// Self-contained: no dist dependency. This is imported by session-start.mjs
// so it must work in a clean checkout without a build step. The TypeScript
// module at src/hooks/pre-compact/restore.ts mirrors this logic for library
// consumers and unit tests.
// Checkpoint discovery is fail-closed: canonical OMC/state/checkpoints
// ancestors are trusted only when they are stable non-symlink directories,
// and checkpoint bytes are read through an O_NOFOLLOW descriptor.

import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from 'fs';
import { isAbsolute, join, relative, sep } from 'path';

const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_MAX_BYTES = 256 * 1024;
const RESTORE_CONTEXT_MAX_CHARS = 1200;
const CHECKPOINT_FILE_PATTERN = /^checkpoint-.+\.json$/;

// Mirrors SESSION_ID_REGEX from src/lib/worktree-paths.ts::validateSessionId.
// A valid session ID is alphanumeric (first char) followed by alphanumeric /
// hyphen / underscore, max 256 chars. This blocks path-traversal attempts
// (`../`, absolute paths, separators) before they reach path join.
const SESSION_ID_ALLOWLIST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_ALLOWLIST.test(sessionId);
}

function getCheckpointDir(omcRoot) {
  return join(omcRoot, 'state', 'checkpoints');
}

function getRestoreMarkerPath(omcRoot, sessionId) {
  return join(omcRoot, 'state', 'checkpoints-restored', sessionId, 'restored.json');
}

function isPathWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isPathWithinOrEqual(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function inspectCanonicalDirectory(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return { path: realpathSync(path), dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function getCanonicalCheckpointContext(omcRoot) {
  const root = inspectCanonicalDirectory(omcRoot);
  const statePath = join(omcRoot, 'state');
  const state = inspectCanonicalDirectory(statePath);
  const checkpointsPath = join(statePath, 'checkpoints');
  const checkpoints = inspectCanonicalDirectory(checkpointsPath);
  if (!root || !state || !checkpoints) return null;
  if (
    !isPathWithinOrEqual(root.path, state.path) ||
    !isPathWithinOrEqual(root.path, checkpoints.path) ||
    !isPathWithinOrEqual(state.path, checkpoints.path)
  ) return null;
  return { omcRoot: root, state, checkpoints };
}

function candidateIdentity(path, dev, ino) {
  return { path, dev, ino };
}

function isStableCanonicalDirectory(path, expected) {
  try {
    const stat = lstatSync(path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.dev === expected.dev &&
      stat.ino === expected.ino &&
      realpathSync(path) === expected.path
    );
  } catch {
    return false;
  }
}

function isStableCheckpointContext(omcRoot, context) {
  return (
    isStableCanonicalDirectory(omcRoot, context.omcRoot) &&
    isStableCanonicalDirectory(join(omcRoot, 'state'), context.state) &&
    isStableCanonicalDirectory(join(omcRoot, 'state', 'checkpoints'), context.checkpoints)
  );
}

function readBoundedCheckpoint(path, expected) {
  const noFollow = constants.O_NOFOLLOW;
  const readOnly = constants.O_RDONLY;
  if (typeof noFollow !== 'number' || noFollow === 0 || typeof readOnly !== 'number') return null;

  let fd = null;
  try {
    fd = openSync(path, readOnly | noFollow);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      !Number.isFinite(before.size) ||
      before.size > CHECKPOINT_MAX_BYTES
    ) return null;

    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) return null;
      offset += count;
    }

    const after = fstatSync(fd);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) return null;

    const raw = buffer.toString('utf-8');
    return raw.length <= CHECKPOINT_MAX_BYTES ? raw : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures; the read has already failed open.
      }
    }
  }
}

// Resolve a checkpoint candidate without following a symlinked entry. The
// repeated lstat/realpath checks fail closed on an obvious replacement race.
function resolveContainedRegularPath(context, omcRoot, candidatePath) {
  try {
    if (!isStableCheckpointContext(omcRoot, context)) return null;
    const before = lstatSync(candidatePath);
    if (!before.isFile() || before.isSymbolicLink()) return null;

    const resolvedPath = realpathSync(candidatePath);
    if (!isPathWithin(context.checkpoints.path, resolvedPath)) return null;

    if (!isStableCheckpointContext(omcRoot, context)) return null;

    const after = lstatSync(candidatePath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) return null;

    const resolvedAgain = realpathSync(candidatePath);
    if (resolvedAgain !== resolvedPath || !isPathWithin(context.checkpoints.path, resolvedAgain)) return null;

    const resolvedStat = lstatSync(resolvedPath);
    if (
      !resolvedStat.isFile() ||
      resolvedStat.isSymbolicLink() ||
      resolvedStat.dev !== after.dev ||
      resolvedStat.ino !== after.ino
    ) return null;

    return isStableCheckpointContext(omcRoot, context)
      ? candidateIdentity(resolvedPath, after.dev, after.ino)
      : null;
  } catch {
    return null;
  }
}

function isCheckpointRestored(omcRoot, sessionId, checkpointPath) {
  try {
    const markerPath = getRestoreMarkerPath(omcRoot, sessionId);
    if (!existsSync(markerPath)) return false;
    const marker = JSON.parse(readFileSync(markerPath, 'utf-8'));
    return marker?.checkpoint === checkpointPath;
  } catch {
    return false;
  }
}

function markCheckpointRestored(omcRoot, sessionId, checkpointPath) {
  try {
    const context = getCanonicalCheckpointContext(omcRoot);
    if (!context || !isStableCheckpointContext(omcRoot, context)) return;
    const markerPath = getRestoreMarkerPath(omcRoot, sessionId);
    mkdirSync(join(markerPath, '..'), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({ restored_at: new Date().toISOString(), checkpoint: checkpointPath }),
      'utf-8',
    );
  } catch {
    // Fail-open: replay protection must not break restore.
  }
}

function parseCheckpoint(omcRoot, candidate, context) {
  try {
    const raw = readBoundedCheckpoint(candidate.path, candidate.verified);
    if (raw === null || !isStableCheckpointContext(omcRoot, context)) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.created_at !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function isWithinAgeBound(createdAt) {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  const age = Date.now() - created;
  return age >= 0 && age <= CHECKPOINT_MAX_AGE_MS;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function formatRestoreContext(checkpoint, path) {
  const lines = [
    '[PRECOMPACT CHECKPOINT RESTORED]',
    '',
    `Checkpoint: ${checkpoint.created_at} (trigger: ${checkpoint.trigger})`,
    'Source: PreCompact checkpoint written before the last compaction.',
  ];

  const modes = checkpoint.active_modes || {};
  const entries = Object.entries(modes).filter(([, v]) => v != null);
  if (entries.length > 0) {
    lines.push('', 'Active modes at compaction time:');
    for (const [name, mode] of entries) {
      if ('iteration' in mode && typeof mode.iteration === 'number') {
        lines.push(`- ${name} (iteration ${mode.iteration})`);
      } else if ('cycle' in mode && typeof mode.cycle === 'number') {
        lines.push(`- ${name} (cycle ${mode.cycle})`);
      } else if ('phase' in mode && typeof mode.phase === 'string') {
        lines.push(`- ${name} (phase ${mode.phase})`);
      } else {
        lines.push(`- ${name}`);
      }
    }
  }

  const todos = checkpoint.todo_summary || {};
  const todoTotal = (todos.pending || 0) + (todos.in_progress || 0) + (todos.completed || 0);
  if (todoTotal > 0) {
    lines.push('', `TODOs at compaction time: ${todos.pending} pending, ${todos.in_progress} in progress, ${todos.completed} completed.`);
  }

  const refs = checkpoint.plan_refs;
  if (refs?.prd) {
    const prd = refs.prd;
    lines.push('', `Active PRD: ${prd.title || 'untitled'} (status: ${prd.status || 'unknown'}, stories: ${prd.stories_completed || 0}/${prd.stories_total || 0})`);
    lines.push(`PRD file: ${prd.path}`);
  }
  if (refs?.boulder) {
    const boulder = refs.boulder;
    lines.push('', `Active plan (boulder): ${boulder.plan_name || 'unnamed'} — ${(boulder.progress?.completed) || 0}/${(boulder.progress?.total) || 0} steps done.`);
    lines.push(`Plan file: ${boulder.active_plan}`);
  }

  if (checkpoint.wisdom_exported) {
    lines.push('', 'Plan wisdom was exported before compaction (see .omc/state/checkpoints/wisdom-*.md).');
  }

  lines.push('', 'Treat this as prior-session context only. Prioritize the current user request; consult the plan/PRD files above before resuming long-running work.', `Raw checkpoint: ${path}`);

  return truncate(lines.join('\n'), RESTORE_CONTEXT_MAX_CHARS);
}

/**
 * Find and restore the newest PreCompact checkpoint for a session.
 * Returns null if no restore happened (fail-open).
 *
 * @param {string} omcRoot - resolved .omc root directory
 * @param {string} sessionId - session ID for replay guard
 * @returns {{ text: string } | null}
 */
export function restorePreCompactCheckpoint(omcRoot, sessionId) {
  try {
    // Session ID is used to build the replay-marker path. Reject anything the
    // canonical session-ID contract rejects so a malicious ID cannot traverse
    // out of .omc/state/checkpoints-restored/.
    if (!isValidSessionId(sessionId)) return null;

    const checkpointDir = getCheckpointDir(omcRoot);
    const context = getCanonicalCheckpointContext(omcRoot);
    if (!context || !isStableCheckpointContext(omcRoot, context)) return null;

    let entries;
    try {
      entries = readdirSync(checkpointDir);
    } catch {
      return null;
    }

    // Collect and parse candidates
    const candidates = [];
    for (const name of entries) {
      if (!CHECKPOINT_FILE_PATTERN.test(name)) continue;
      const path = join(checkpointDir, name);
      try {
        const resolvedPath = resolveContainedRegularPath(context, omcRoot, path);
        if (!resolvedPath) continue;
        const stat = lstatSync(resolvedPath.path);
        const candidate = { name, path, mtimeMs: stat.mtimeMs, verified: resolvedPath };
        const checkpoint = parseCheckpoint(omcRoot, candidate, context);
        if (checkpoint) {
          candidates.push({ ...candidate, checkpoint });
        }
      } catch {
        // skip unreadable
      }
    }

    if (candidates.length === 0) return null;

    // Sort newest-first by created_at, then mtime
    candidates.sort((a, b) => {
      const ta = Date.parse(a.checkpoint.created_at);
      const tb = Date.parse(b.checkpoint.created_at);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
      return b.mtimeMs - a.mtimeMs;
    });

    // Walk newest-to-oldest, skipping already-restored
    for (const candidate of candidates) {
      if (sessionId && isCheckpointRestored(omcRoot, sessionId, candidate.path)) continue;
      if (!isWithinAgeBound(candidate.checkpoint.created_at)) continue;
      // First non-restored, within-age candidate
      const text = formatRestoreContext(candidate.checkpoint, candidate.path);
      if (sessionId) markCheckpointRestored(omcRoot, sessionId, candidate.path);
      return { text };
    }

    return null;
  } catch {
    // Restore is advisory: never break session start.
    return null;
  }
}
