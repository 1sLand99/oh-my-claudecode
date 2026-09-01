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
const { existsSync, readFileSync, realpathSync } = require('fs');
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
// POSIX default = max declared manifest budget (60000ms, setup-maintenance) minus
// the 500ms cushion; applied ONLY when manifest resolution is null so long legit
// hooks are not prematurely reaped. Windows uses a larger cushion so fail-open
// plus tree reap still finish inside the declared hooks.json budget.
const TIMEOUT_CUSHION_MS = POSIX_TIMEOUT_CUSHION_MS;
const DEFAULT_GENERIC_TIMEOUT_MS = MAX_DECLARED_GENERIC_TIMEOUT_MS - POSIX_TIMEOUT_CUSHION_MS;

function platformTimeoutCushionMs(platform = process.platform) {
  return platform === 'win32' ? WINDOWS_TIMEOUT_CUSHION_MS : POSIX_TIMEOUT_CUSHION_MS;
}

function resolveTimeoutCushionMs(manifestTimeoutMs, hookEvent, platform = process.platform) {
  const base = platformTimeoutCushionMs(platform);
  if (hookEvent !== 'UserPromptSubmit') return base;
  const promptCushion = Math.floor(manifestTimeoutMs * 0.2);
  return Math.min(3000, Math.max(base, 1000, promptCushion));
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


function writeTimeoutDiagnostic(targetPath, manifestHook, timeoutMs) {
  const message = `[run.cjs] Hook ${basename(targetPath)} timed out after ${timeoutMs}ms; exiting fail-open.\n`;
  if (manifestHook?.event !== 'UserPromptSubmit' || isDebugHooksEnabled()) {
    process.stderr.write(message);
  }
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

function reapTree(child, childIdentity) {
  // Identity-safe reap: verify the PID still belongs to the child we spawned
  // before killing its process group. If the PID was reused by the OS after
  // the child exited, processIdentityMatches returns false and we skip the
  // kill entirely, relying on child.unref() for fail-open exit.
  if (childIdentity && !processIdentityMatches(child.pid, childIdentity)) return;
  if (process.platform === 'win32') {
    // Synchronous and bounded: a leaked descendant holding protocol stdio is
    // #3920. taskkill must not be fire-and-forget, but it also must not stall
    // past the remaining hooks.json cushion. Protocol handles are already
    // isolated in run.cjs, so a timed-out taskkill still fail-opens with EOF.
    if (!Number.isInteger(child.pid) || child.pid <= 0) return;
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
        windowsHide: true,
        timeout: WINDOWS_REAP_TIMEOUT_MS,
        stdio: 'ignore',
      });
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

function attachProtocolForwarders(child) {
  if (child.stdout) child.stdout.pipe(process.stdout, { end: false });
  if (child.stderr) child.stderr.pipe(process.stderr, { end: false });
}

function detachProtocolStdio(child) {
  if (!child) return;
  for (const [stream, dest] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    if (!stream) continue;
    try { stream.unpipe(dest); } catch { /* already detached */ }
    try {
      if (typeof stream.pause === 'function') stream.pause();
      if (typeof stream.read === 'function' && dest && !dest.destroyed) {
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
  return new Promise(resolve => {
    let terminal = false;
    let timer;
    const child = spawn(process.execPath, resolveGenericChildCommand(targetPath, extraArgs), {
      stdio: resolveGenericChildStdio(),
      env: {
        ...process.env,
        OMC_SESSION_OWNER_PID: process.env.OMC_SESSION_OWNER_PID || String(process.ppid),
      },
      windowsHide: true,
      detached: true,
    });
    attachProtocolForwarders(child);
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
      detachProtocolStdio(child);
      reapTree(child, childIdentity);
      process.exit(0);
    }
    function onRunnerExit() {
      if (terminal) return;
      terminal = true;
      detachProtocolStdio(child);
      reapTree(child, childIdentity);
    }

    timer = setTimeout(() => {
      if (terminal) return;
      terminal = true;
      detachHandlers();
      detachProtocolStdio(child);
      reapTree(child, childIdentity);
      // The runner MUST exit fail-open even if the tree reap did not (or could
      // not) complete — the core #3493 symptom is run.cjs parents living for
      // tens of minutes. Closing the Windows IPC channel also tells the
      // supervisor to reap the hook tree if taskkill did not complete.
      // Destroying the piped stdio handles first guarantees protocol EOF when
      // this process exits, even if a descendant survives (#3920).
      releaseGenericChild(child);
      writeTimeoutDiagnostic(targetPath, manifestHook, timeoutMs);
      resolve(0);
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
        resolve(typeof code === 'number' ? code : 0);
      });
    });
    child.once('error', () => {
      if (terminal) return;
      terminal = true;
      detachHandlers();
      detachProtocolStdio(child);
      resolve(0);
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

  const cleanupInput = () => {
    if (!worker) return;
    process.stdin.unpipe(worker.stdin);
    worker.stdin.destroy();
  };
  const waitForOutputEnd = stream => stream.readableEnded
    ? Promise.resolve()
    : new Promise(resolve => stream.once('end', resolve));
  const writeBuffer = (stream, buffer) => new Promise(resolve => {
    stream.write(buffer, () => resolve());
  });
  const forwardBuffers = async (workerError) => {
    if (stdout.length) await writeBuffer(process.stdout, Buffer.concat(stdout));
    if (stderr.length) await writeBuffer(process.stderr, Buffer.concat(stderr));
    if (workerError) {
      const diagnostic = workerError.stack || workerError.message || String(workerError);
      await writeBuffer(process.stderr, Buffer.from(`${diagnostic}\n`));
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
        writeTimeoutDiagnostic(targetPath, manifestHook, timeoutMs);
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
  platformTimeoutCushionMs,
  runGenericChild,
  resolveGenericChildCommand,
  resolveGenericChildStdio,
  releaseGenericChild,
  DEFAULT_GENERIC_TIMEOUT_MS,
  TIMEOUT_CUSHION_MS,
  WINDOWS_TIMEOUT_CUSHION_MS,
  WINDOWS_REAP_TIMEOUT_MS,
  MAX_DECLARED_GENERIC_TIMEOUT_MS,
  resolveTrustedSessionEndTarget,
};
