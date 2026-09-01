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

describe('run.cjs Windows/protocol stdio contract (#3920)', () => {
  it('never hands protocol stdout/stderr to a process that can outlive the runner', () => {
    expect(runCjs.resolveGenericChildStdio('win32')).toEqual(['inherit', 'pipe', 'pipe', 'ipc']);
    expect(runCjs.resolveGenericChildStdio('linux')).toEqual(['inherit', 'pipe', 'pipe']);
    expect(runCjs.resolveGenericChildStdio('darwin')).toEqual(['inherit', 'pipe', 'pipe']);
  });

  it('keeps Windows inner timeout plus bounded reap inside the declared hook budget', () => {
    const declared = 3000;
    const inner = runCjs.resolveGenericTimeoutMs({ timeoutMs: declared, event: 'PostToolUse' }, 'win32');
    const posixInner = runCjs.resolveGenericTimeoutMs({ timeoutMs: declared, event: 'PostToolUse' }, 'linux');
    expect(posixInner).toBe(2500);
    expect(inner).toBe(1500);
    expect(inner + runCjs.WINDOWS_REAP_TIMEOUT_MS).toBeLessThan(declared);
    expect(declared - inner).toBe(runCjs.WINDOWS_TIMEOUT_CUSHION_MS);
    expect(runCjs.resolveGenericTimeoutMs(null, 'win32')).toBe(58500);
    expect(runCjs.resolveGenericTimeoutMs(null, 'linux')).toBe(59500);
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
    let orphanPid: number | undefined;
    const startedAt = Date.now();
    const runner = spawn(process.execPath, [RUN_CJS_PATH, SUCCESS_ORPHAN], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OMC_TEST_PIDFILE: pidfile },
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

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('run.cjs hung after successful hook exit with a live detached descendant')),
          2000,
        );
        runner.once('exit', code => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(exitCode).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(2000);
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(stdoutEnded).toBe(true);
      expect(stdout).toContain('hook-ok');
      expect(stderr).toContain('hook-err');
      expect(stderr).not.toMatch(/timed out after \d+ms/);

      await waitForFile(pidfile, 2000);
      orphanPid = Number(readFileSync(pidfile, 'utf8'));
      expect(orphanPid).toBeGreaterThan(0);
      try {
        process.kill(orphanPid, 0);
      } catch (error: unknown) {
        expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
      }
    } finally {
      killIfAlive(orphanPid);
      try { runner.kill('SIGKILL'); } catch { /* already gone */ }
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
    try {
      const status = await runCjs.runGenericChild(HUNG_PARENT, [], 250, null);
      expect(status).toBe(0);
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
