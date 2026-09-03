import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT_PATH = join(__dirname, '..', '..', 'scripts', 'session-start.mjs');
const NODE = process.execPath;

/**
 * The update check does not depend on a workspace, so it must also run when
 * validateCwd() rejects the cwd (no .git / .omc-workspace). Everything here is
 * driven from a marketplace clone plus a fresh cache, so no network is used.
 */
describe('session-start.mjs update check', () => {
  let tempDir: string;
  let fakeHome: string;
  let pluginRoot: string;
  let cachePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'omc-session-start-update-'));
    fakeHome = join(tempDir, 'home');

    // Managed plugin cache root: makes the update channel 'marketplace'.
    pluginRoot = join(fakeHome, '.claude', 'plugins', 'cache', 'omc', 'oh-my-claudecode', '1.0.0');
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }));

    const marketplaceDir = join(fakeHome, '.claude', 'plugins', 'marketplaces', 'omc', '.claude-plugin');
    mkdirSync(marketplaceDir, { recursive: true });
    writeFileSync(
      join(marketplaceDir, 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'oh-my-claudecode', version: '9.9.9' }] }),
    );

    // Fresh Claude Code entry so the registry fetch is skipped.
    cachePath = join(fakeHome, '.claude', '.omc', 'update-check.json');
    mkdirSync(join(fakeHome, '.claude', '.omc'), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ claudeCodeLatestVersion: '2.1.240', claudeCodeCheckedAt: Date.now() }),
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function runSessionStart(cwd: string): string {
    return execFileSync(NODE, [SCRIPT_PATH], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'update-check', cwd }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        // config-dir.mjs prefers CLAUDE_CONFIG_DIR over HOME; without this the
        // test would write to the developer's real config directory.
        CLAUDE_CONFIG_DIR: join(fakeHome, '.claude'),
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
      timeout: 15000,
    }).trim();
  }

  it('checks for updates even when the cwd is not a workspace', () => {
    const nonWorkspace = join(tempDir, 'not-a-workspace');
    mkdirSync(nonWorkspace, { recursive: true });

    const output = JSON.parse(runSessionStart(nonWorkspace)) as {
      continue?: boolean;
      systemMessage?: string;
    };

    expect(output.continue).toBe(true);
    expect(output.systemMessage).toContain('[OMC UPDATE AVAILABLE]');
    expect(output.systemMessage).toContain('9.9.9');

    const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    expect(cached.latestVersion).toBe('9.9.9');
    expect(cached.updateAvailable).toBe(true);
  });

  it('preserves the cached Claude Code version across an OMC-only refresh', () => {
    const nonWorkspace = join(tempDir, 'not-a-workspace-2');
    mkdirSync(nonWorkspace, { recursive: true });

    runSessionStart(nonWorkspace);

    const cached = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
    expect(cached.claudeCodeLatestVersion).toBe('2.1.240');
  });
});
