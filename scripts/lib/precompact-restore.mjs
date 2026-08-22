// PreCompact checkpoint restore helper (issue #3730).
//
// Self-contained: no dist dependency. This is imported by session-start.mjs
// so it must work in a clean checkout without a build step. The TypeScript
// module at src/hooks/pre-compact/restore.ts mirrors this logic for library
// consumers and unit tests.
// Checkpoint discovery is fail-closed: canonical OMC/state/checkpoints
// ancestors are trusted only when they are stable non-symlink directories,
// and checkpoint bytes are read through an O_NOFOLLOW descriptor.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, writeSync, mkdirSync } from 'fs';
import { basename, isAbsolute, join, relative, sep } from 'path';

const CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CHECKPOINT_MAX_BYTES = 256 * 1024;
const RESTORE_CONTEXT_MAX_CHARS = 1200;
const RESTORE_MARKER_MAX_BYTES = 16 * 1024;
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

function canonicalChildDirectory(parent, name, create) {
  const childPath = join(parent.path, name);
  try {
    let stat;
    try {
      stat = lstatSync(childPath);
    } catch (error) {
      if (!create || error?.code !== 'ENOENT') return null;
      mkdirSync(childPath, { recursive: false, mode: 0o700 });
      stat = lstatSync(childPath);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const canonicalPath = realpathSync(childPath);
    if (!isPathWithinOrEqual(parent.path, canonicalPath)) return null;
    const after = lstatSync(childPath);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      realpathSync(childPath) !== canonicalPath
    ) return null;
    return { path: canonicalPath, dev: after.dev, ino: after.ino };
  } catch {
    return null;
  }
}

function getRestoreMarkerTarget(omcRoot, sessionId, create) {
  if (!isValidSessionId(sessionId)) return null;
  const context = getCanonicalCheckpointContext(omcRoot);
  if (!context || !isStableCheckpointContext(omcRoot, context)) return null;
  const markerRoot = canonicalChildDirectory(context.state, 'checkpoints-restored', create);
  if (!markerRoot || !isPathWithin(context.omcRoot.path, markerRoot.path)) return null;
  const parent = canonicalChildDirectory(markerRoot, sessionId, create);
  if (
    !parent ||
    !isPathWithin(context.omcRoot.path, parent.path) ||
    !isPathWithinOrEqual(context.state.path, parent.path) ||
    !isStableCheckpointContext(omcRoot, context)
  ) return null;
  return { context, markerRoot, parent, path: join(parent.path, 'restored.json') };
}

function isStableRestoreMarkerTarget(target, parentFd) {
  try {
    if (
      !isStableCheckpointContext(target.context.omcRoot.path, target.context) ||
      !isStableCanonicalDirectory(
        join(target.context.state.path, 'checkpoints-restored'),
        target.markerRoot,
      ) ||
      !isStableCanonicalDirectory(
        join(target.context.state.path, 'checkpoints-restored', basename(target.parent.path)),
        target.parent,
      )
    ) return false;
    if (parentFd !== undefined) {
      const stat = fstatSync(parentFd);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== target.parent.dev ||
        stat.ino !== target.parent.ino
      ) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function openBoundedDirectory(directory) {
  const readOnly = constants.O_RDONLY;
  const directoryFlag = constants.O_DIRECTORY;
  const noFollow = constants.O_NOFOLLOW;
  if (
    typeof readOnly !== 'number' ||
    typeof directoryFlag !== 'number' ||
    typeof noFollow !== 'number' ||
    noFollow === 0
  ) return null;
  let fd = null;
  try {
    fd = openSync(directory.path, readOnly | directoryFlag | noFollow);
    const stat = fstatSync(fd);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== directory.dev ||
      stat.ino !== directory.ino ||
      realpathSync(directory.path) !== directory.path
    ) {
      closeSync(fd);
      return null;
    }
    return fd;
  } catch {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    return null;
  }
}

function descriptorChildPath(parentFd, name) {
  if (process.platform === 'win32') return null;
  return `/proc/self/fd/${parentFd}/${name}`;
}

function readBoundedFile(path, expected, maxBytes) {
  const noFollow = constants.O_NOFOLLOW;
  const readOnly = constants.O_RDONLY;
  if (typeof readOnly !== 'number') return null;

  let fd = null;
  try {
    const beforePath = lstatSync(path);
    if (
      !beforePath.isFile() ||
      beforePath.isSymbolicLink() ||
      beforePath.nlink > 1 ||
      beforePath.dev !== expected.dev ||
      beforePath.ino !== expected.ino ||
      realpathSync(path) !== expected.path
    ) return null;

    const flags = typeof noFollow === 'number' && noFollow !== 0 ? readOnly | noFollow : readOnly;
    fd = openSync(path, flags);
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink > 1 ||
      before.dev !== expected.dev ||
      before.ino !== expected.ino ||
      !Number.isFinite(before.size) ||
      before.size > maxBytes ||
      realpathSync(path) !== expected.path
    ) return null;

    const openedPath = lstatSync(path);
    if (
      !openedPath.isFile() ||
      openedPath.isSymbolicLink() ||
      openedPath.nlink > 1 ||
      openedPath.dev !== before.dev ||
      openedPath.ino !== before.ino
    ) return null;

    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (count === 0) return null;
      offset += count;
    }

    const after = fstatSync(fd);
    const afterPath = lstatSync(path);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink > 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      afterPath.dev !== before.dev ||
      afterPath.ino !== before.ino ||
      afterPath.isSymbolicLink() ||
      afterPath.nlink > 1 ||
      realpathSync(path) !== expected.path
    ) return null;

    const raw = buffer.toString('utf-8');
    return raw.length <= maxBytes ? raw : null;
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

function readBoundedCheckpoint(path, expected) {
  return readBoundedFile(path, expected, CHECKPOINT_MAX_BYTES);
}

// Resolve a checkpoint candidate without following a symlinked entry. The
// repeated lstat/realpath checks fail closed on an obvious replacement race.
function resolveContainedRegularPath(context, omcRoot, candidatePath) {
  try {
    if (!isStableCheckpointContext(omcRoot, context)) return null;
    const before = lstatSync(candidatePath);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) return null;

    const resolvedPath = realpathSync(candidatePath);
    if (!isPathWithin(context.checkpoints.path, resolvedPath)) return null;
    if (!isStableCheckpointContext(omcRoot, context)) return null;

    const after = lstatSync(candidatePath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink > 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) return null;

    const resolvedAgain = realpathSync(candidatePath);
    if (resolvedAgain !== resolvedPath || !isPathWithin(context.checkpoints.path, resolvedAgain)) return null;

    const resolvedStat = lstatSync(resolvedPath);
    if (
      !resolvedStat.isFile() ||
      resolvedStat.isSymbolicLink() ||
      resolvedStat.nlink > 1 ||
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
    if (!isValidSessionId(sessionId)) return false;
    const target = getRestoreMarkerTarget(omcRoot, sessionId, false);
    if (!target) return false;
    const stat = lstatSync(target.path);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const markerPath = realpathSync(target.path);
    if (
      markerPath !== target.path ||
      !isPathWithin(target.context.omcRoot.path, markerPath)
    ) return false;
    const raw = readBoundedFile(
      target.path,
      { path: markerPath, dev: stat.dev, ino: stat.ino },
      RESTORE_MARKER_MAX_BYTES,
    );
    if (raw === null || !isStableRestoreMarkerTarget(target)) return false;
    const marker = JSON.parse(raw);
    return marker?.checkpoint === checkpointPath;
  } catch {
    return false;
  }
}

function markCheckpointRestored(omcRoot, sessionId, checkpointPath) {
  if (!isValidSessionId(sessionId)) return 'invalid_session_id';
  let parentFd = null;
  let markerFd = null;
  try {
    const target = getRestoreMarkerTarget(omcRoot, sessionId, true);
    if (!target) return 'unsupported';
    parentFd = openBoundedDirectory(target.parent);
    if (parentFd === null) return process.platform === 'win32' ? 'unsupported' : 'failed';

    const create = constants.O_CREAT;
    const exclusive = constants.O_EXCL;
    const writeOnly = constants.O_WRONLY;
    if (
      typeof create !== 'number' ||
      typeof exclusive !== 'number' ||
      typeof writeOnly !== 'number'
    ) return 'unsupported';
    const noFollow = constants.O_NOFOLLOW;
    const flags =
      create |
      exclusive |
      writeOnly |
      (typeof noFollow === 'number' && noFollow !== 0 ? noFollow : 0);
    const markerPath = descriptorChildPath(parentFd, basename(target.path));
    if (markerPath === null) return 'unsupported';
    markerFd = openSync(markerPath, flags, 0o600);
    const before = fstatSync(markerFd);
    const openedPath = realpathSync(markerPath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink > 1 ||
      before.size !== 0 ||
      !isPathWithin(target.context.omcRoot.path, openedPath) ||
      openedPath !== target.path ||
      !isStableRestoreMarkerTarget(target, parentFd)
    ) return 'failed';
    const bytes = Buffer.from(
      JSON.stringify({ restored_at: new Date().toISOString(), checkpoint: checkpointPath }),
      'utf-8',
    );
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(markerFd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(count) || count <= 0) return 'failed';
      offset += count;
    }
    const after = fstatSync(markerFd);
    const afterPath = realpathSync(markerPath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink > 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== bytes.length ||
      afterPath !== target.path ||
      !isStableRestoreMarkerTarget(target, parentFd)
    ) return 'failed';
    return 'written';
  } catch (error) {
    return error?.code === 'EEXIST' ? 'existing' : 'failed';
  } finally {
    if (markerFd !== null) {
      try { closeSync(markerFd); } catch { /* ignore */ }
    }
    if (parentFd !== null) {
      try { closeSync(parentFd); } catch { /* ignore */ }
    }
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
 * @returns {{ text: string, marker_status: string } | null}
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
      const marker_status = sessionId
        ? markCheckpointRestored(omcRoot, sessionId, candidate.path)
        : 'unsupported';
      return { text, marker_status };
    }

    return null;
  } catch {
    // Restore is advisory: never break session start.
    return null;
  }
}
