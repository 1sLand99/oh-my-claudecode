import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const NODE = process.execPath;
const REPO_ROOT = resolve(join(__dirname, '..', '..'));
const SCRIPT_PATH = join(REPO_ROOT, 'scripts', 'post-tool-rules-injector.mjs');

function runHook(input: Record<string, unknown>, extraEnv?: Record<string, string>) {
  const raw = execFileSync(NODE, [SCRIPT_PATH], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      NODE_ENV: 'test',
      ...extraEnv,
    },
    timeout: 15000,
  }).trim();

  return JSON.parse(raw) as {
    continue: boolean;
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
}

describe('post-tool-rules-injector.mjs skip guards (DISABLE_OMC / OMC_SKIP_HOOKS)', () => {
  // A payload with a file_path drives the hook into its rules-processing path, so a
  // hook that ignores the kill switch would NOT emit the bare `{ continue: true }`
  // that a guarded short-circuit produces.
  const INPUT = {
    tool_name: 'Read',
    tool_input: { file_path: 'README.md' },
    session_id: 'abc',
  };

  function expectSkipped(extraEnv: Record<string, string>) {
    // Guarded hooks short-circuit before any processing with a bare continue.
    expect(runHook(INPUT, extraEnv)).toEqual({ continue: true });
  }

  it('no-ops when DISABLE_OMC=1', () => {
    expectSkipped({ DISABLE_OMC: '1', OMC_SKIP_HOOKS: '' });
  });

  it('no-ops when DISABLE_OMC=true', () => {
    expectSkipped({ DISABLE_OMC: 'true', OMC_SKIP_HOOKS: '' });
  });

  it('no-ops when OMC_SKIP_HOOKS contains the post-tool-use event token', () => {
    expectSkipped({ DISABLE_OMC: '', OMC_SKIP_HOOKS: 'post-tool-use' });
  });

  it('honors whitespace and commas in OMC_SKIP_HOOKS', () => {
    expectSkipped({ DISABLE_OMC: '', OMC_SKIP_HOOKS: ' keyword-detector , post-tool-use ' });
  });

  it('returns a Codex-compatible no-op response when processing is enabled', () => {
    expect(runHook(INPUT, { DISABLE_OMC: '', OMC_SKIP_HOOKS: '' })).toEqual({ continue: true });
  });

  it('returns a Codex-compatible no-op response for unrelated skip tokens', () => {
    expect(runHook(INPUT, { DISABLE_OMC: '', OMC_SKIP_HOOKS: 'keyword-detector' })).toEqual({
      continue: true,
    });
  });

  it('returns a Codex-compatible no-op response when DISABLE_OMC=false', () => {
    expect(runHook(INPUT, { DISABLE_OMC: 'false', OMC_SKIP_HOOKS: '' })).toEqual({
      continue: true,
    });
  });

  it('preserves additionalContext without unsupported response fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'post-tool-rules-injector-'));
    const home = join(root, 'home');
    const filePath = join(root, 'README.md');
    mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(root, '.git'), 'gitdir: placeholder');
    writeFileSync(join(root, '.claude', 'rules', 'style.md'), '---\nalwaysApply: true\n---\nUse this rule.');
    writeFileSync(filePath, '# fixture');

    try {
      const output = runHook(
        {
          cwd: root,
          tool_name: 'Read',
          tool_input: { file_path: filePath },
          session_id: `issue-3956-${Date.now()}`,
        },
        {
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: join(root, 'config'),
        },
      );

      expect(output).toEqual({
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: expect.stringContaining('Use this rule.'),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
