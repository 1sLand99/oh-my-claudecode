import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const runCjs = require('../../scripts/run.cjs');
const RUN_CJS_PATH = join(process.cwd(), 'scripts', 'run.cjs');
const HUNG_PARENT = join(process.cwd(), 'src', '__tests__', 'fixtures', 'hung-hooks', 'hung-parent.cjs');
const DETACHED_ORPHAN = join(process.cwd(), 'src', '__tests__', 'fixtures', 'hung-hooks', 'detached-stdout-orphan.cjs');
const SUCCESS_ORPHAN = join(process.cwd(), 'src', '__tests__', 'fixtures', 'hung-hooks', 'success-parent-stdout-orphan.cjs');

function killIfAlive(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already dead */ }
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        windowsHide: true,
        timeout: 2000,
        stdio: 'ignore',
      });
    } catch { /* already dead or taskkill unavailable */ }
  }
}

async function waitForDeath(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`PID ${pid} survived process-tree reap`);
}

async function waitForFile(path: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${path}`);
}

function writePluginHook(root: string, scriptName: string, source: string, timeoutSec: number): string {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  const target = join(root, 'scripts', scriptName);
  writeFileSync(target, source);
  writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify({
    hooks: {
      PostToolUse: [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: `node "$CLAUDE_PLUGIN_ROOT"/scripts/run.cjs "$CLAUDE_PLUGIN_ROOT"/scripts/${scriptName}`,
          timeout: timeoutSec,
        }],
      }],
    },
  }));
  return target;
}
async function runDeclaredOrphan(declaredSec: number): Promise<{
  elapsed: number;
  stdout: string;
  stderr: string;
  orphanPid: number;
  stdoutEnded: boolean;
  exitCode: number | null;
}> {
  const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-budget-'));
  const pidfile = join(directory, 'orphan.pid');
  const pluginRoot = join(directory, 'plugin');
  const declaredMs = Math.round(declaredSec * 1000);
  const target = writePluginHook(
    pluginRoot,
    'orphan-hook.cjs',
    readFileSync(DETACHED_ORPHAN, 'utf8'),
    declaredSec,
  );
  const startedAt = Date.now();
  const runner = spawn(process.execPath, [RUN_CJS_PATH, target], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OMC_TEST_PIDFILE: pidfile, CLAUDE_PLUGIN_ROOT: pluginRoot },
    windowsHide: true,
  });
  let orphanPid: number | undefined;
  try {
    let stdout = '';
    let stderr = '';
    let stdoutEnded = false;
    runner.stdout.setEncoding('utf8');
    runner.stderr.setEncoding('utf8');
    runner.stdout.on('data', chunk => { stdout += chunk; });
    runner.stderr.on('data', chunk => { stderr += chunk; });
    runner.stdout.on('end', () => { stdoutEnded = true; });
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`run.cjs exceeded declared ${declaredMs}ms outer budget`)),
        declaredMs,
      );
      runner.once('exit', code => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    await waitForFile(pidfile, declaredMs);
    orphanPid = Number(readFileSync(pidfile, 'utf8'));
    const exitCode = await exitPromise;
    await new Promise(resolve => setTimeout(resolve, 50));
    return {
      elapsed: Date.now() - startedAt,
      stdout,
      stderr,
      orphanPid,
      stdoutEnded,
      exitCode,
    };
  } finally {
    killIfAlive(orphanPid);
    try { runner.kill('SIGKILL'); } catch { /* already gone */ }
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('run.cjs Windows/protocol stdio contract (#3920)', () => {
  it('never hands protocol stdout/stderr to a process that can outlive the runner', () => {
    expect(runCjs.resolveGenericChildStdio('win32')).toEqual(['inherit', 'pipe', 'pipe', 'ipc']);
    expect(runCjs.resolveGenericChildStdio('linux')).toEqual(['inherit', 'pipe', 'pipe']);
    expect(runCjs.resolveGenericChildStdio('darwin')).toEqual(['inherit', 'pipe', 'pipe']);
  });

  it('keeps inner timeout plus bounded reap inside the declared hook budget', () => {
    const cases = [
      { timeoutMs: 1000, event: 'PostToolUse', win32: 500, linux: 500 },
      { timeoutMs: 1500, event: 'PostToolUse', win32: 750, linux: 1000 },
      { timeoutMs: 3000, event: 'PostToolUse', win32: 1500, linux: 2500 },
      { timeoutMs: 10000, event: 'PostToolUse', win32: 8500, linux: 9500 },
      { timeoutMs: 60000, event: 'PostToolUse', win32: 58500, linux: 59500 },
    ] as const;
    for (const row of cases) {
      const winInner = runCjs.resolveGenericTimeoutMs({ timeoutMs: row.timeoutMs, event: row.event }, 'win32');
      const posixInner = runCjs.resolveGenericTimeoutMs({ timeoutMs: row.timeoutMs, event: row.event }, 'linux');
      expect(winInner, `win32 inner for ${row.timeoutMs}`).toBe(row.win32);
      expect(posixInner, `linux inner for ${row.timeoutMs}`).toBe(row.linux);
      expect(winInner).toBeGreaterThanOrEqual(Math.min(row.timeoutMs - 1, runCjs.MIN_HOOK_INNER_MS));
      expect(winInner / row.timeoutMs).toBeGreaterThanOrEqual(runCjs.MIN_HOOK_INNER_FRACTION);
      expect(winInner + runCjs.WINDOWS_REAP_TIMEOUT_MS).toBeLessThanOrEqual(row.timeoutMs);
      expect(row.timeoutMs - winInner).toBeLessThanOrEqual(runCjs.WINDOWS_TIMEOUT_CUSHION_MS);
    }
    expect(runCjs.resolveGenericTimeoutMs(null, 'win32')).toBe(58500);
    expect(runCjs.resolveGenericTimeoutMs(null, 'linux')).toBe(59500);
  });
  it.each([1.5, 3])('spawns a grandchild and exits inside a %ss declared outer budget', async (declaredSec) => {
    const declaredMs = Math.round(declaredSec * 1000);
    const result = await runDeclaredOrphan(declaredSec);
    expect(result.exitCode).toBe(0);
    expect(result.orphanPid).toBeGreaterThan(0);
    expect(result.elapsed).toBeLessThan(declaredMs);
    expect(result.stdoutEnded).toBe(true);
    expect(result.stdout).toContain('hook-ready');
    expect(result.stderr).toMatch(/timed out after \d+ms; exiting fail-open/);
    const inner = runCjs.resolveGenericTimeoutMs({ timeoutMs: declaredMs, event: 'PostToolUse' });
    expect(inner).toBeGreaterThanOrEqual(runCjs.MIN_HOOK_INNER_MS);
    expect(result.elapsed).toBeGreaterThanOrEqual(Math.max(0, inner - 200));
  });

  it('closes protocol stdout when the runner times out even if a detached descendant still lives', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-eof-'));
    const pidfile = join(directory, 'orphan.pid');
    let orphanPid: number | undefined;
    const pluginRoot = join(directory, 'plugin');
    const declaredSec = 3;
    const declaredMs = declaredSec * 1000;
    const target = writePluginHook(
      pluginRoot,
      'orphan-hook.cjs',
      readFileSync(DETACHED_ORPHAN, 'utf8'),
      declaredSec,
    );
    const startedAt = Date.now();
    const runner = spawn(process.execPath, [RUN_CJS_PATH, target], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMC_TEST_PIDFILE: pidfile, CLAUDE_PLUGIN_ROOT: pluginRoot },
      windowsHide: true,
    });
    try {
      let stdout = '';
      let stderr = '';
      let stdoutEnded = false;
      runner.stdout.setEncoding('utf8');
      runner.stderr.setEncoding('utf8');
      runner.stdout.on('data', chunk => { stdout += chunk; });
      runner.stderr.on('data', chunk => { stderr += chunk; });
      runner.stdout.on('end', () => { stdoutEnded = true; });

      await waitForFile(pidfile, declaredMs);
      orphanPid = Number(readFileSync(pidfile, 'utf8'));
      expect(orphanPid).toBeGreaterThan(0);

      const remainingMs = Math.max(1, declaredMs - (Date.now() - startedAt));
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`run.cjs exceeded declared ${declaredMs}ms outer budget`)),
          remainingMs,
        );
        runner.once('exit', code => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(exitCode).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(declaredMs);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(stdoutEnded).toBe(true);
      expect(stdout).toContain('hook-ready');
      expect(stderr).toContain('hook-stderr');
      expect(stderr).toMatch(/timed out after \d+ms; exiting fail-open/);

      try {
        process.kill(orphanPid, 0);
        // Detached grandchild may still be alive; protocol EOF must not depend on it.
      } catch (error: unknown) {
        expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
      }
    } finally {
      killIfAlive(orphanPid);
      try { runner.kill('SIGKILL'); } catch { /* already gone */ }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('closes protocol stdout after a successful hook exit even if a detached descendant still lives', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-success-eof-'));
    const pidfile = join(directory, 'orphan.pid');
    const outerTimeoutMs = 2000;
    let orphanPid: number | undefined;
    try {
      const startedAt = Date.now();
      const result = spawnSync(process.execPath, [RUN_CJS_PATH, SUCCESS_ORPHAN], {
        encoding: 'utf8',
        timeout: outerTimeoutMs,
        env: { ...process.env, OMC_TEST_PIDFILE: pidfile },
        windowsHide: true,
      });
      const elapsed = Date.now() - startedAt;
      expect(result.error, result.error?.message).toBeUndefined();
      expect(result.status).toBe(0);
      expect(elapsed).toBeLessThan(outerTimeoutMs);
      expect(result.stdout).toContain('hook-ok');
      expect(result.stderr).toContain('hook-err');
      expect(result.stderr).not.toMatch(/timed out after \d+ms/);
      await waitForFile(pidfile, 2000);
      const pid = Number(readFileSync(pidfile, 'utf8'));
      orphanPid = pid;
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      killIfAlive(orphanPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('forwards hook stdout and stderr exactly once through the runner', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-forward-'));
    try {
      const fixture = join(directory, 'echo-hook.cjs');
      writeFileSync(fixture, 'process.stdout.write("OUT-BYTES"); process.stderr.write("ERR-BYTES");');
      const result = spawnSync(process.execPath, [RUN_CJS_PATH, fixture], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('OUT-BYTES');
      expect(result.stderr).toBe('ERR-BYTES');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reaps timed-out generic descendants so no orphan survives', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'omc-stdio-reap-'));
    const pidfile = join(directory, 'grandchild.pid');
    const previousPidfile = process.env.OMC_TEST_PIDFILE;
    let grandchildPid: number | undefined;
    process.env.OMC_TEST_PIDFILE = pidfile;
    // 250ms is below observed Windows supervisor→hook→grandchild cold start
    // (361–559ms). Inner budget must cover that spawn chain; outer deadline
    // is a separate assertion so a hung reap cannot hide behind a long inner.
    const innerMs = 1500;
    const outerMs = 3000;
    try {
      const startedAt = Date.now();
      let deadline: NodeJS.Timeout | undefined;
      const status = await Promise.race([
        runCjs.runGenericChild(HUNG_PARENT, [], innerMs, null),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`runGenericChild exceeded ${outerMs}ms outer deadline`)),
            outerMs,
          );
        }),
      ]).finally(() => clearTimeout(deadline));
      const elapsed = Date.now() - startedAt;
      expect(status).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(innerMs - 400);
      expect(elapsed).toBeLessThan(outerMs);
      grandchildPid = Number(readFileSync(pidfile, 'utf8'));
      expect(grandchildPid).toBeGreaterThan(0);
      await waitForDeath(grandchildPid);
    } finally {
      if (previousPidfile === undefined) delete process.env.OMC_TEST_PIDFILE;
      else process.env.OMC_TEST_PIDFILE = previousPidfile;
      killIfAlive(grandchildPid);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
