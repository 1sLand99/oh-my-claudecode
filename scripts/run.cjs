#!/usr/bin/env node
'use strict';
/**
 * OMC Cross-platform hook runner (run.cjs).
 *
 * Uses process.execPath (the Node binary already running this script) to spawn
 * ordinary hooks. The two trusted UserPromptSubmit hooks run in a Worker so the
 * runner retains ownership of their synchronous timeout boundary.
 */

const { spawn, spawnSync } = require('child_process');
const { PassThrough } = require('stream');
const { existsSync, readFileSync, realpathSync, writeSync } = require('fs');
const path = require('path');
const { join, basename, dirname } = path;
const { pathToFileURL } = require('url');
const { Worker } = require('worker_threads');


function isPluginRoot(pluginRoot) {
  return existsSync(join(pluginRoot, 'hooks', 'hooks.json')) &&
    existsSync(join(pluginRoot, 'scripts', 'run.cjs')) &&
    existsSync(join(pluginRoot, 'scripts'));
}

function canonicalPluginRoot(pluginRoot) {
  try {
    const canonicalRoot = path.resolve(realpathSync(pluginRoot));
    return isPluginRoot(canonicalRoot) ? canonicalRoot : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the hook script target path, handling stale CLAUDE_PLUGIN_ROOT.
 *
 * A direct target remains valid for the generic child path even without a
 * trusted plugin root. Worker eligibility receives only independently proven
 * configured-root or selected-cache-version provenance.
 */
function resolveTarget(targetPath) {
  const configuredRoot = canonicalPluginRoot(process.env.CLAUDE_PLUGIN_ROOT);

  try {
    if (existsSync(targetPath)) {
      return {
        targetPath: path.resolve(realpathSync(targetPath)),
        trustedPluginRoot: configuredRoot,
      };
    }
  } catch {
    // Continue to stale-cache recovery.
  }

  try {
    const configuredPath = process.env.CLAUDE_PLUGIN_ROOT;
    if (!configuredPath) return null;

    const cacheBase = dirname(configuredPath);
    const scriptRelative = targetPath.slice(configuredPath.length);
    if (!scriptRelative || !existsSync(cacheBase)) return null;

    const { readdirSync } = require('fs');
    const entries = readdirSync(cacheBase).filter(version => /^\d+\.\d+\.\d+/.test(version));
    entries.sort((a, b) => {
      const pa = a.split('.').map(Number);
      const pb = b.split('.').map(Number);
      for (let index = 0; index < 3; index++) {
        if ((pa[index] || 0) !== (pb[index] || 0)) return (pb[index] || 0) - (pa[index] || 0);
      }
      return 0;
    });

    for (const version of entries) {
      const selectedRoot = join(cacheBase, version);
      const candidate = selectedRoot + scriptRelative;
      if (!existsSync(candidate)) continue;
      const trustedPluginRoot = canonicalPluginRoot(selectedRoot);
      return {
        targetPath: path.resolve(realpathSync(candidate)),
        trustedPluginRoot,
      };

    }
  } catch {
    // Any stale-cache recovery error remains fail-open.
  }

  return null;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flattenHookEntries(rawHooks) {
  if (!rawHooks || typeof rawHooks !== 'object') return [];
  return Object.entries(rawHooks).flatMap(([event, entries]) => {
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => ({ event, entry }));
  });
}

function isDebugHooksEnabled() {
  return process.env.OMC_DEBUG_HOOKS === '1' ||
    process.env.OMC_DEBUG === '1' ||
    process.env.OMC_DEBUG === 'true';
}

const POSIX_TIMEOUT_CUSHION_MS = 500;
const WINDOWS_TIMEOUT_CUSHION_MS = 1500;
const MAX_DECLARED_GENERIC_TIMEOUT_MS = 60000;
const WINDOWS_REAP_TIMEOUT_MS = 400;
const PROTOCOL_STDIO_SETTLE_MS = 150;
const MIN_HOOK_INNER_FRACTION = 0.5;
const MIN_HOOK_INNER_MS = 400;
// Observed Windows supervisor→hook→grandchild cold start in hosted CI (361–559ms).
const WINDOWS_GENERIC_STARTUP_MS = 600;
// Must match scripts/lib/bounded-git-timeout.mjs.
const NESTED_OPERATION_TIMEOUT_MS = 2000;
const NESTED_OPERATION_MARGIN_MS = 200;
const NESTED_INNER_FLOOR_MS = NESTED_OPERATION_TIMEOUT_MS + NESTED_OPERATION_MARGIN_MS + WINDOWS_GENERIC_STARTUP_MS;
const TIMEOUT_CUSHION_MS = POSIX_TIMEOUT_CUSHION_MS;
const DEFAULT_GENERIC_TIMEOUT_MS = MAX_DECLARED_GENERIC_TIMEOUT_MS - POSIX_TIMEOUT_CUSHION_MS;

function platformTimeoutCushionMs(platform = process.platform) {
  return platform === 'win32' ? WINDOWS_TIMEOUT_CUSHION_MS : POSIX_TIMEOUT_CUSHION_MS;
}

function desiredTimeoutCushionMs(manifestTimeoutMs, hookEvent, platform = process.platform) {
  const base = platformTimeoutCushionMs(platform);
  if (hookEvent !== 'UserPromptSubmit') return base;
  const promptCushion = Math.floor(manifestTimeoutMs * 0.2);
  return Math.min(3000, Math.max(base, 1000, promptCushion));
}

function resolveTimeoutCushionMs(manifestTimeoutMs, hookEvent, platform = process.platform) {
  const desired = desiredTimeoutCushionMs(manifestTimeoutMs, hookEvent, platform);
  const fractionalInner = Math.max(MIN_HOOK_INNER_MS, Math.floor(manifestTimeoutMs * MIN_HOOK_INNER_FRACTION));
  const canFitNestedFloor = manifestTimeoutMs - POSIX_TIMEOUT_CUSHION_MS >= NESTED_INNER_FLOOR_MS;
  const minInner = Math.min(
    Math.max(1, manifestTimeoutMs - 1),
    canFitNestedFloor ? Math.max(fractionalInner, NESTED_INNER_FLOOR_MS) : fractionalInner,
  );
  const maxCushion = Math.max(1, manifestTimeoutMs - minInner);
  return Math.min(desired, maxCushion);
}

function resolveInnerTimeoutMs(manifestHook, platform = process.platform) {
  if (!manifestHook) return null;
  return Math.max(1, manifestHook.timeoutMs - resolveTimeoutCushionMs(manifestHook.timeoutMs, manifestHook.event, platform));
}

// Call only after resolveWorkerTarget has verified an exact canonical trusted prompt target.
function resolveTrustedPromptWorkerTimeoutMs(targetPath, manifestHook, trustedPluginRoot) {
  const calculatedTimeoutMs = resolveInnerTimeoutMs(manifestHook);
  const canonicalTarget = normalizedComparisonPath(targetPath);
  const capsByCanonicalTarget = new Map([
    [normalizedComparisonPath(join(trustedPluginRoot, 'scripts', 'keyword-detector.mjs')), 8000],
    [normalizedComparisonPath(join(trustedPluginRoot, 'scripts', 'skill-injector.mjs')), 12000],
  ]);
  const capMs = capsByCanonicalTarget.get(canonicalTarget);
  return capMs ? Math.min(calculatedTimeoutMs, capMs) : calculatedTimeoutMs;
}

function resolveGenericTimeoutMs(manifestHook, platform = process.platform) {
  return manifestHook
    ? resolveInnerTimeoutMs(manifestHook, platform)
    : MAX_DECLARED_GENERIC_TIMEOUT_MS - platformTimeoutCushionMs(platform);
}

function resolveHookTimeoutMsFromRoot(pluginRoot, targetPath, extraArgs) {
  const hooksJsonPath = join(pluginRoot, 'hooks', 'hooks.json');
  if (!existsSync(hooksJsonPath)) return null;

  try {
    const hooksJson = JSON.parse(readFileSync(hooksJsonPath, 'utf-8'));
    const scriptName = basename(targetPath);
    const scriptPattern = new RegExp(`[/\\\\]scripts[/\\\\]${escapeRegex(scriptName)}(?:\\s|$)`);
    const argNeedles = extraArgs.filter(arg => typeof arg === 'string' && arg.length > 0);

    for (const { event, entry } of flattenHookEntries(hooksJson?.hooks)) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      for (const hook of hooks) {
        const command = typeof hook?.command === 'string' ? hook.command : '';
        const timeout = Number(hook?.timeout);
        if (!scriptPattern.test(command)) continue;
        if (!Number.isFinite(timeout) || timeout <= 0) continue;
        if (!argNeedles.every(arg => command.includes(` ${arg}`) || command.endsWith(` ${arg}`))) continue;
        return { event, timeoutMs: Math.floor(timeout * 1000) };
      }
    }
  } catch {
    return null;
  }

  return null;
}

function resolveHookTimeoutMs(targetPath, extraArgs) {
  return resolveHookTimeoutMsFromRoot(dirname(dirname(targetPath)), targetPath, extraArgs);
}

function normalizedComparisonPath(value) {
  const canonical = path.resolve(realpathSync(value));
  return process.platform === 'win32'
    ? path.win32.normalize(canonical).toLowerCase()
    : path.normalize(canonical);
}

function isContainedBy(root, targetPath) {
  const pathApi = process.platform === 'win32' ? path.win32 : path;
  const relative = pathApi.relative(root, targetPath);
  return relative !== '' && !pathApi.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`);
}

function resolveWorkerTarget(resolution, extraArgs) {
  const trustedRoot = resolution.trustedPluginRoot;
  if (!trustedRoot || extraArgs.length !== 0) return null;

  try {
    const canonicalRoot = normalizedComparisonPath(trustedRoot);
    const canonicalTarget = normalizedComparisonPath(resolution.targetPath);
    if (!isContainedBy(canonicalRoot, canonicalTarget)) return null;

    const expectedTargets = ['keyword-detector.mjs', 'skill-injector.mjs']
      .map(script => normalizedComparisonPath(join(trustedRoot, 'scripts', script)));
    if (!expectedTargets.includes(canonicalTarget)) return null;

    const manifestHook = resolveHookTimeoutMsFromRoot(trustedRoot, resolution.targetPath, []);
    if (manifestHook?.event !== 'UserPromptSubmit') return null;
    return manifestHook;
  } catch {
    return null;
  }
}

function resolveTrustedSessionEndTarget(resolution, extraArgs) {
  const trustedRoot = resolution.trustedPluginRoot;
  if (!trustedRoot || extraArgs.length !== 0) return null;
  try {
    const canonicalTarget = normalizedComparisonPath(resolution.targetPath);
    const canonicalRoot = normalizedComparisonPath(trustedRoot);
    if (!isContainedBy(canonicalRoot, canonicalTarget)) return null;
    const expectedTargets = ['session-end.mjs', 'wiki-session-end.mjs']
      .map(script => normalizedComparisonPath(join(trustedRoot, 'scripts', script)));
    if (!expectedTargets.includes(canonicalTarget)) return null;
    const manifestHook = resolveHookTimeoutMsFromRoot(trustedRoot, resolution.targetPath, []);
    return manifestHook?.event === 'SessionEnd' ? manifestHook : null;
  } catch {
    return null;
  }
}


function writeTimeoutDiagnostic(targetPath, manifestHook, timeoutMs, sink) {
  const message = `[run.cjs] Hook ${basename(targetPath)} timed out after ${timeoutMs}ms; exiting fail-open.\n`;
  if (manifestHook?.event !== 'UserPromptSubmit' || isDebugHooksEnabled()) {
    if (sink) return sink.write(process.stderr, Buffer.from(message));
    try { process.stderr.write(message); } catch { /* protocol dest may already be closed */ }
  }
  return Promise.resolve();
}

function captureProcessStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      if (closeParen === -1) return null;
      const fields = stat.substring(closeParen + 2).split(' ');
      const startTime = parseInt(fields[19], 10);
      return isNaN(startTime) ? null : String(startTime);
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { status, stdout } = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='],
        { env: { ...process.env, LC_ALL: 'C' }, timeout: 2000, windowsHide: true });
      if (status !== 0) return null;
      const time = new Date(stdout.trim()).getTime();
      return isNaN(time) ? null : `mac:${time}`;
    } catch {
      return null;
    }
  }
  return null;
}

function processIdentityMatches(pid, expectedIdentity) {
  if (!expectedIdentity) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return captureProcessStartIdentity(pid) === expectedIdentity;
}

function leaderPresence(pid, expectedIdentity) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error && error.code === 'ESRCH' ? 'absent' : 'unknown';
  }
  if (!expectedIdentity) return 'alive';
  return captureProcessStartIdentity(pid) === expectedIdentity ? 'alive' : 'mismatch';
}

function reapTree(child, childIdentity) {
  // Identity-safe reap: only signal a live PID we spawned, or a confirmed-dead
  // detached leader's leftover process group. A live identity mismatch is PID
  // reuse — fail closed. Unknown (EPERM/identity-read failure) also fail closed.
  if (!Number.isInteger(child.pid) || child.pid <= 0) return;
  const presence = leaderPresence(child.pid, childIdentity);
  if (presence === 'mismatch' || presence === 'unknown') return;
  if (presence === 'absent') {
    if (process.platform === 'win32') return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already empty */ }
    return;
  }
  if (process.platform === 'win32') {
    // Protocol stdout/stderr are owned by run.cjs pipes, so a descendant that
    // outlives this process cannot retain Claude Code's handles (#3920).
    // Do not spawnSync here: Node waits for the killer even after its timeout,
    // which can hold the runner past the declared host fuse. Fire-and-forget
    // taskkill with stdio ignored after protocol detach is the fail-open path.
    try {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
      killer.unref();
    } catch {
      // best-effort; child.unref() still guarantees the runner exits
    }
    return;
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // best-effort; child.unref() still guarantees the runner exits
    }
  }
}

const RUNNER_TERMINATION_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
function resolveGenericChildCommand(targetPath, extraArgs, platform = process.platform) {
  return platform === 'win32'
    ? [__filename, '--generic-child-supervisor', targetPath, ...extraArgs]
    : [targetPath, ...extraArgs];
}

function resolveGenericChildStdio(platform = process.platform) {
  // stdin inherit: hook JSON payload from Claude Code.
  // stdout/stderr pipe: run.cjs owns the protocol handles so a descendant that
  // outlives the runner cannot keep Claude Code blocked on EOF (#3920).
  // ipc: Windows supervisor parent-death reap.
  return platform === 'win32'
    ? ['inherit', 'pipe', 'pipe', 'ipc']
    : ['inherit', 'pipe', 'pipe'];
}

function isClosedDestinationError(error) {
  const code = error && error.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END';
}

function abandonProtocolSource(source, dest) {
  if (!source) return;
  try { source.unpipe(dest); } catch { /* already detached */ }
  try {
    if (typeof source.resume === 'function') source.resume();
  } catch { /* already flowing or destroyed */ }
}

let processDestGuardsInstalled = false;
function ensureProcessDestGuards() {
  if (processDestGuardsInstalled) return;
  processDestGuardsInstalled = true;
  const guard = (error) => {
    if (isClosedDestinationError(error)) return;
    try {
      writeSync(2, `[run.cjs] protocol stream error: ${error.code || error.message}\n`);
    } catch { /* both destinations dead */ }
  };
  process.stdout.on('error', guard);
  process.stderr.on('error', guard);
}

function createProtocolSink() {
  const discarded = { stdout: false, stderr: false };
  const sources = { stdout: new Set(), stderr: new Set() };
  const taps = { stdout: new Set(), stderr: new Set() };
  let installed = false;
  let pendingWrites = 0;
  let uninstallRequested = false;
  const onStdoutError = (error) => handleDestError('stdout', process.stdout, error);
  const onStderrError = (error) => handleDestError('stderr', process.stderr, error);

  function handleDestError(name, dest, error) {
    if (discarded[name]) return;
    discarded[name] = true;
    for (const source of sources[name]) abandonProtocolSource(source, dest);
    sources[name].clear();
    if (!isClosedDestinationError(error) && name === 'stdout') {
      void write(process.stderr, Buffer.from(`[run.cjs] protocol stream error: ${error.code || error.message}\n`));
    }
  }

  function install() {
    ensureProcessDestGuards();
    if (installed) return;
    installed = true;
    process.stdout.on('error', onStdoutError);
    process.stderr.on('error', onStderrError);
  }

  function flushUninstall() {
    if (!uninstallRequested || pendingWrites > 0 || !installed) return;
    installed = false;
    process.stdout.removeListener('error', onStdoutError);
    process.stderr.removeListener('error', onStderrError);
    // Process-lifetime closed-dest guards remain so a late write callback
    // EPIPE after finish() cannot crash the runner.
  }

  function uninstall() {
    uninstallRequested = true;
    flushUninstall();
  }

  function abandonOutputs() {
    discarded.stdout = true;
    discarded.stderr = true;
    for (const name of ['stdout', 'stderr']) {
      for (const tap of taps[name]) {
        try { tap.unpipe(); } catch { /* already unpiped */ }
        try { tap.destroy(); } catch { /* already destroyed */ }
      }
      taps[name].clear();
      for (const source of sources[name]) abandonProtocolSource(source);
      sources[name].clear();
    }
  }

  function write(dest, data) {
    install();
    const name = dest === process.stderr ? 'stderr' : 'stdout';
    if (discarded[name] || !dest || dest.destroyed || !dest.writable) return Promise.resolve();
    if (dest.writableNeedDrain) {
      discarded[name] = true;
      return Promise.resolve();
    }
    pendingWrites += 1;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const completeWrite = (error) => {
        if (writeCompleted) {
          if (error) handleDestError(name, dest, error);
          return;
        }
        writeCompleted = true;
        pendingWrites = Math.max(0, pendingWrites - 1);
        if (error) handleDestError(name, dest, error);
        clearTimeout(timer);
        done();
        flushUninstall();
      };
      let writeCompleted = false;
      const timer = setTimeout(done, PROTOCOL_STDIO_SETTLE_MS);
      try {
        const ok = dest.write(data, (error) => completeWrite(error));
        if (!ok) completeWrite();
      } catch (error) {
        completeWrite(error);
      }
    });
  }

  function attachChild(child) {
    install();
    const bind = (source, dest, name) => {
      if (!source) return;
      const tap = new PassThrough();
      sources[name].add(source);
      taps[name].add(tap);
      source.pipe(tap);
      tap.pipe(dest, { end: false });
      const drop = () => {
        sources[name].delete(source);
        taps[name].delete(tap);
      };
      source.once('end', drop);
      source.once('close', drop);
    };
    bind(child.stdout, process.stdout, 'stdout');
    bind(child.stderr, process.stderr, 'stderr');
  }

  return { install, uninstall, write, attachChild, abandonOutputs };
}

function detachProtocolStdio(child) {
  if (!child) return;
  for (const [stream, dest] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    if (!stream) continue;
    try { stream.unpipe(dest); } catch { /* already detached */ }
    try {
      if (typeof stream.pause === 'function') stream.pause();
      const destWritable = dest && !dest.destroyed && dest.writable && !dest.writableNeedDrain;
      if (typeof stream.read === 'function' && destWritable) {
        let chunk;
        while ((chunk = stream.read()) !== null) dest.write(chunk);
      }
    } catch { /* remaining buffered bytes are best-effort */ }
    try { stream.destroy(); } catch { /* already destroyed */ }
  }
}

function settleProtocolStdio(child, timeoutMs = PROTOCOL_STDIO_SETTLE_MS) {
  return new Promise(resolve => {
    let pending = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const track = (stream) => {
      if (!stream || stream.readableEnded || stream.destroyed) return;
      pending += 1;
      stream.once('end', () => {
        pending -= 1;
        if (pending === 0) {
          clearTimeout(timer);
          finish();
        }
      });
    };
    track(child.stdout);
    track(child.stderr);
    if (pending === 0) {
      clearTimeout(timer);
      finish();
    }
  });
}

function releaseGenericChild(child) {
  detachProtocolStdio(child);
  try {
    if (child.connected) child.disconnect();
  } catch {
    // The child may already have exited or closed its IPC channel.
  }
  try { child.unref(); } catch { /* handle already released */ }
}

function superviseGenericChild(targetPath, extraArgs) {
  let terminal = false;
  const child = spawn(process.execPath, [targetPath, ...extraArgs], {
    stdio: 'inherit',
    env: {
      ...process.env,
      OMC_SESSION_OWNER_PID: process.env.OMC_SESSION_OWNER_PID || String(process.ppid),
    },
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  const childIdentity = child.pid ? captureProcessStartIdentity(child.pid) : null;
  const finish = (status) => {
    if (terminal) return;
    terminal = true;
    process.exitCode = status;
    if (process.connected) process.disconnect();
  };

  // The supervisor is a detached Windows child of run.cjs. Its IPC channel is
  // closed by the OS even when run.cjs is externally terminated without JS
  // cleanup, so it can reap only the hook tree that it created.
  process.once('disconnect', () => {
    if (terminal) return;
    terminal = true;
    reapTree(child, childIdentity);
    try { child.unref(); } catch { /* handle already released */ }
  });
  child.once('exit', code => finish(typeof code === 'number' ? code : 0));
  child.once('error', () => finish(0));
}

function runGenericChild(targetPath, extraArgs, timeoutMs, manifestHook) {
  const sink = createProtocolSink();
  sink.install();
  return new Promise(resolve => {
    let terminal = false;
    let timer;
    const finish = (status) => {
      sink.uninstall();
      resolve(status);
    };
    const child = spawn(process.execPath, resolveGenericChildCommand(targetPath, extraArgs), {
      stdio: resolveGenericChildStdio(),
      env: {
        ...process.env,
        OMC_SESSION_OWNER_PID: process.env.OMC_SESSION_OWNER_PID || String(process.ppid),
      },
      windowsHide: true,
      detached: true,
    });
    sink.attachChild(child);
    // Capture the durable start identity immediately so reapTree can reject
    // a PID that was reused after the child exited.
    const childIdentity = child.pid ? captureProcessStartIdentity(child.pid) : null;

    // The generic child is detached into its own process group (POSIX). If the
    // runner is terminated or cancelled BEFORE the inner timer fires (outer
    // hooks.json timeout, Ctrl-C, parent kill), reap the tree so the detached
    // hook cannot be orphaned — the exact failure class #3493 must not leave open.
    const detachHandlers = () => {
      clearTimeout(timer);
      for (const signal of RUNNER_TERMINATION_SIGNALS) process.off(signal, onRunnerSignal);
      process.off('exit', onRunnerExit);
    };
    function onRunnerSignal() {
      if (terminal) return;
      terminal = true;
      detachHandlers();
      reapTree(child, childIdentity);
      sink.abandonOutputs();
      detachProtocolStdio(child);
      sink.uninstall();
      process.exit(0);
    }
    function onRunnerExit() {
      if (terminal) return;
      terminal = true;
      reapTree(child, childIdentity);
      sink.abandonOutputs();
      detachProtocolStdio(child);
    }

    timer = setTimeout(() => {
      if (terminal) return;
      terminal = true;
      detachHandlers();
      reapTree(child, childIdentity);
      void writeTimeoutDiagnostic(targetPath, manifestHook, timeoutMs, sink).finally(() => {
        sink.abandonOutputs();
        detachProtocolStdio(child);
        releaseGenericChild(child);
        if (require.main === module) {
          try { process.stdout.destroy(); } catch { /* already closed */ }
          try { process.stderr.destroy(); } catch { /* already closed */ }
        }
        finish(0);
      });
    }, timeoutMs);

    child.once('exit', (code) => {
      if (terminal) return;
      terminal = true;
      detachHandlers();
      // Drain then close even on a clean hook exit. A detached descendant that
      // inherited the child's stdout/stderr keeps the pipe readableEnded=false;
      // leaving the forwarders attached would pin process.stdout and wedge EOF
      // (#3920 success-path hang, outer harness timeout 124).
      void settleProtocolStdio(child).then(() => {
        releaseGenericChild(child);
        finish(typeof code === 'number' ? code : 0);
      });
    });
    child.once('error', () => {
      if (terminal) return;
      terminal = true;
      detachHandlers();
      detachProtocolStdio(child);
      finish(0);
    });

    for (const signal of RUNNER_TERMINATION_SIGNALS) process.on(signal, onRunnerSignal);
    process.on('exit', onRunnerExit);
  });
}

async function runWorker(targetPath, manifestHook, timeoutMs) {
  let worker;
  let terminal = false;
  let timer;
  let discardOutput = false;
  const stdout = [];
  const stderr = [];
  const sink = createProtocolSink();
  sink.install();

  const cleanupInput = () => {
    if (!worker) return;
    process.stdin.unpipe(worker.stdin);
    worker.stdin.destroy();
  };
  const waitForOutputEnd = stream => stream.readableEnded
    ? Promise.resolve()
    : new Promise(resolve => stream.once('end', resolve));
  const forwardBuffers = async (workerError) => {
    if (stdout.length) await sink.write(process.stdout, Buffer.concat(stdout));
    if (stderr.length) await sink.write(process.stderr, Buffer.concat(stderr));
    if (workerError) {
      const diagnostic = workerError.stack || workerError.message || String(workerError);
      await sink.write(process.stderr, Buffer.from(`${diagnostic}\n`));
    }
  };
  const waitForWorkerOutput = () => Promise.all([
    waitForOutputEnd(worker.stdout),
    waitForOutputEnd(worker.stderr),
  ]);

  try {
    return await new Promise((resolve) => {
      const finish = async (status, workerError) => {
        if (terminal) return;
        terminal = true;
        clearTimeout(timer);
        cleanupInput();
        if (worker) await waitForWorkerOutput();
        await forwardBuffers(workerError);
        sink.uninstall();
        resolve(status);
      };

      timer = setTimeout(async () => {
        if (terminal) return;
        discardOutput = true;
        terminal = true;
        cleanupInput();
        try {
          await worker.terminate();
        } catch {
          // Termination is best-effort; the hook must still fail open.
        }
        await writeTimeoutDiagnostic(targetPath, manifestHook, timeoutMs, sink);
        sink.uninstall();
        resolve(0);
      }, timeoutMs);

      try {
        worker = new Worker(pathToFileURL(targetPath), {
          stdin: true,
          stdout: true,
          stderr: true,
          env: process.env,
        });
        if (process.stdin.readableEnded) worker.stdin.end();
        else process.stdin.pipe(worker.stdin);
        worker.stdout.on('data', chunk => { if (!discardOutput) stdout.push(chunk); });
        worker.stderr.on('data', chunk => { if (!discardOutput) stderr.push(chunk); });
        worker.once('error', error => {
          void finish(1, error);
        });
        worker.once('exit', code => {
          void finish(code ?? 0);
        });
      } catch (error) {
        void finish(1, error);
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

if (require.main === module) {
  ensureProcessDestGuards();
  const target = process.argv[2];
  if (target === '--generic-child-supervisor') {
    const supervisedTarget = process.argv[3];
    if (supervisedTarget) superviseGenericChild(supervisedTarget, process.argv.slice(4));
    else process.exitCode = 0;
  } else if (!target) {
    process.exit(0);
  } else {
    const resolution = resolveTarget(target);
    if (!resolution) {
      process.exitCode = 0;
    } else {
      const extraArgs = process.argv.slice(3);
      const workerManifestHook = resolveWorkerTarget(resolution, extraArgs);
      if (workerManifestHook) {
        const workerTimeoutMs = resolveTrustedPromptWorkerTimeoutMs(resolution.targetPath, workerManifestHook, resolution.trustedPluginRoot);
        runWorker(resolution.targetPath, workerManifestHook, workerTimeoutMs).then(status => {
          process.exitCode = status;
        });
      } else {
        const sessionEndManifestHook = resolveTrustedSessionEndTarget(resolution, extraArgs);
        if (sessionEndManifestHook) {
          const timeoutMs = Math.min(resolveGenericTimeoutMs(sessionEndManifestHook), 300);
          runWorker(resolution.targetPath, sessionEndManifestHook, timeoutMs).then(status => {
            process.exitCode = status;
          });
        } else {
          const manifestHook = resolveHookTimeoutMs(resolution.targetPath, extraArgs);
          const timeoutMs = resolveGenericTimeoutMs(manifestHook);
          runGenericChild(resolution.targetPath, extraArgs, timeoutMs, manifestHook).then(status => {
            process.exitCode = status;
          });
        }
      }
    }
  }
}

module.exports = {
  resolveInnerTimeoutMs,
  resolveTrustedPromptWorkerTimeoutMs,
  resolveWorkerTarget,
  resolveHookTimeoutMs,
  resolveGenericTimeoutMs,
  resolveTimeoutCushionMs,
  desiredTimeoutCushionMs,
  platformTimeoutCushionMs,
  runGenericChild,
  resolveGenericChildCommand,
  resolveGenericChildStdio,
  releaseGenericChild,
  isClosedDestinationError,
  DEFAULT_GENERIC_TIMEOUT_MS,
  TIMEOUT_CUSHION_MS,
  WINDOWS_TIMEOUT_CUSHION_MS,
  WINDOWS_REAP_TIMEOUT_MS,
  MIN_HOOK_INNER_MS,
  MIN_HOOK_INNER_FRACTION,
  WINDOWS_GENERIC_STARTUP_MS,
  NESTED_OPERATION_TIMEOUT_MS,
  NESTED_OPERATION_MARGIN_MS,
  NESTED_INNER_FLOOR_MS,
  MAX_DECLARED_GENERIC_TIMEOUT_MS,
  resolveTrustedSessionEndTarget,
};
