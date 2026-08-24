import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearWorktreeCache,
  resolveWorkingDirectoryOrLinkedWorktree,
  validateWorkingDirectoryOrLinkedWorktree,
  ForeignWorkingDirectoryError,
} from '../../lib/worktree-paths.js';
import { wikiQueryTool, wikiReadTool } from '../../tools/wiki-tools.js';

function git(cwd: string, command: string): void {
  execSync(`git ${command}`, { cwd, stdio: 'pipe' });
}

describe('shared resolver #3858: foreign repo, linked worktree, non-git, same-root', () => {
  let tempDir: string;
  let originalCwd: string;
  let sessionRepo: string;
  let foreignRepo: string;
  let linkedWorktree: string;
  let plainDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'resolver-3858-'));
    clearWorktreeCache();

    sessionRepo = join(tempDir, 'session-project');
    mkdirSync(sessionRepo, { recursive: true });
    git(sessionRepo, 'init');
    git(sessionRepo, 'config user.email "test@example.com"');
    git(sessionRepo, 'config user.name "Test User"');
    writeFileSync(join(sessionRepo, 'README.md'), 'session\n');
    git(sessionRepo, 'add README.md');
    git(sessionRepo, 'commit -m initial');

    foreignRepo = join(tempDir, 'foreign-vault');
    mkdirSync(foreignRepo, { recursive: true });
    git(foreignRepo, 'init');
    git(foreignRepo, 'config user.email "test@example.com"');
    git(foreignRepo, 'config user.name "Test User"');
    writeFileSync(join(foreignRepo, 'README.md'), 'vault\n');
    git(foreignRepo, 'add README.md');
    git(foreignRepo, 'commit -m initial');

    linkedWorktree = join(tempDir, 'session-linked');
    git(sessionRepo, `worktree add -b linked ${linkedWorktree}`);

    plainDir = join(tempDir, 'plain-notes');
    mkdirSync(plainDir, { recursive: true });

    process.chdir(sessionRepo);
    clearWorktreeCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    clearWorktreeCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolveWorkingDirectoryOrLinkedWorktree returns foreign_repository for a different repo, never a root', () => {
    const resolution = resolveWorkingDirectoryOrLinkedWorktree(foreignRepo);
    expect(resolution).toEqual({
      status: 'foreign_repository',
      providedRoot: foreignRepo,
      trustedRoot: sessionRepo,
    });
    if (resolution.status === 'foreign_repository') {
      expect('root' in resolution).toBe(false);
    }
  });

  it('validateWorkingDirectoryOrLinkedWorktree throws ForeignWorkingDirectoryError instead of substituting', () => {
    expect(() => validateWorkingDirectoryOrLinkedWorktree(foreignRepo)).toThrow(ForeignWorkingDirectoryError);
    try {
      validateWorkingDirectoryOrLinkedWorktree(foreignRepo);
      expect.unreachable('must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ForeignWorkingDirectoryError);
      const foreign = error as ForeignWorkingDirectoryError;
      expect(foreign.providedRoot).toBe(foreignRepo);
      expect(foreign.trustedRoot).toBe(sessionRepo);
      expect(foreign.message).toContain('belongs to a different repository');
      expect(foreign.message).toContain('not used');
    }
  });

  it('accepts a linked worktree of the same repository (preserves #2880)', () => {
    expect(validateWorkingDirectoryOrLinkedWorktree(linkedWorktree)).toBe(linkedWorktree);
    expect(resolveWorkingDirectoryOrLinkedWorktree(linkedWorktree)).toEqual({
      status: 'ok',
      root: linkedWorktree,
    });
  });

  it('accepts the same root and a subdirectory of the trusted repo', () => {
    expect(validateWorkingDirectoryOrLinkedWorktree(sessionRepo)).toBe(sessionRepo);
    expect(validateWorkingDirectoryOrLinkedWorktree()).toBe(sessionRepo);

    const sub = join(sessionRepo, 'docs');
    mkdirSync(sub, { recursive: true });
    // Non-repo directory inside the trusted root normalizes to the trusted root.
    expect(validateWorkingDirectoryOrLinkedWorktree(sub)).toBe(sessionRepo);
  });

  it('still throws for a non-git path outside the trusted root', () => {
    expect(() => validateWorkingDirectoryOrLinkedWorktree(plainDir)).toThrow(
      'is outside the trusted worktree root'
    );
  });

  it('linked-worktree wiki flows keep working end to end (no regression from #2880)', async () => {
    const readResult = await wikiReadTool.handler({ page: 'missing', workingDirectory: linkedWorktree });
    expect(readResult.isError).toBe(true);
    expect(readResult.content[0].text).toContain('Wiki page not found: missing.md');
    expect(readResult.content[0].text).not.toContain('different repository');

    const queryResult = await wikiQueryTool.handler({ query: 'anything', workingDirectory: linkedWorktree });
    expect(queryResult.isError).toBeUndefined();
    expect(queryResult.content[0].text).toContain('No wiki pages match "anything"');
    expect(existsSync(join(sessionRepo, '.omc', 'wiki'))).toBe(false);
  });
});
