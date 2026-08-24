import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, relative } from 'node:path';
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

function canonical(path: string): string {
  return realpathSync(path);
}

describe('shared resolver #3858: foreign repo, linked worktree, non-git, same-root', () => {
  let tempDir: string;
  let originalCwd: string;
  let sessionRepo: string;
  let foreignRepo: string;
  let linkedWorktree: string;
  let plainDir: string;
  let canonicalSession: string;
  let canonicalForeign: string;

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
    canonicalSession = canonical(sessionRepo);
    canonicalForeign = canonical(foreignRepo);
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
      providedRoot: canonicalForeign,
      trustedRoot: canonicalSession,
      callerLabel: foreignRepo,
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
      expect(foreign.providedRoot).toBe(canonicalForeign);
      expect(foreign.trustedRoot).toBe(canonicalSession);
      expect(foreign.callerLabel).toBe(foreignRepo);
      expect(foreign.message).toContain('belongs to a different repository');
      expect(foreign.message).toContain('not used');
      expect(foreign.message).toContain(foreignRepo);
      expect(foreign.message).toContain(basename(sessionRepo));
      expect(foreign.message).not.toContain(canonicalSession);
    }
  });

  it('ForeignWorkingDirectoryError requires callerLabel and never renders canonical provided/trusted roots', () => {
    const error = new ForeignWorkingDirectoryError(
      '/canonical/foreign-vault',
      '/canonical/session-project',
      '../foreign-vault',
    );
    expect(error.callerLabel).toBe('../foreign-vault');
    expect(error.providedRoot).toBe('/canonical/foreign-vault');
    expect(error.trustedRoot).toBe('/canonical/session-project');
    expect(error.message).toContain('../foreign-vault');
    expect(error.message).toContain('session-project');
    expect(error.message).not.toContain('/canonical/foreign-vault');
    expect(error.message).not.toContain('/canonical/session-project');
  });

  it('relative foreign alias keeps the caller-supplied label and hides canonical host paths', () => {
    const relativeAlias = join('..', 'foreign-vault');
    const resolution = resolveWorkingDirectoryOrLinkedWorktree(relativeAlias);
    expect(resolution.status).toBe('foreign_repository');
    if (resolution.status !== 'foreign_repository') return;

    expect(resolution.providedRoot).toBe(canonicalForeign);
    expect(resolution.trustedRoot).toBe(canonicalSession);
    expect(resolution.callerLabel).toBe(relativeAlias);

    try {
      validateWorkingDirectoryOrLinkedWorktree(relativeAlias);
      expect.unreachable('must throw');
    } catch (error) {
      const foreign = error as ForeignWorkingDirectoryError;
      expect(foreign.message).toContain(relativeAlias);
      expect(foreign.message).not.toContain(canonicalForeign);
      expect(foreign.message).not.toContain(canonicalSession);
      expect(foreign.message).toContain(basename(sessionRepo));
    }
  });

  it('symlink foreign alias keeps the symlink label and hides the canonical target', () => {
    const symlinkAlias = join(tempDir, 'foreign-alias');
    symlinkSync(foreignRepo, symlinkAlias);

    const resolution = resolveWorkingDirectoryOrLinkedWorktree(symlinkAlias);
    expect(resolution.status).toBe('foreign_repository');
    if (resolution.status !== 'foreign_repository') return;

    expect(resolution.providedRoot).toBe(canonicalForeign);
    expect(resolution.callerLabel).toBe(symlinkAlias);

    try {
      validateWorkingDirectoryOrLinkedWorktree(symlinkAlias);
      expect.unreachable('must throw');
    } catch (error) {
      const foreign = error as ForeignWorkingDirectoryError;
      expect(foreign.message).toContain(symlinkAlias);
      expect(foreign.message).not.toContain(canonicalForeign);
      expect(foreign.message).not.toContain(canonicalSession);
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

  it('still throws for a non-git path outside the trusted root without leaking the full trusted root', () => {
    expect(() => validateWorkingDirectoryOrLinkedWorktree(plainDir)).toThrow(
      'is outside the trusted worktree root'
    );
    try {
      validateWorkingDirectoryOrLinkedWorktree(plainDir);
      expect.unreachable('must throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(plainDir);
      expect(message).toContain(basename(sessionRepo));
      expect(message).not.toContain(canonicalSession);
    }
  });

  it('rejects a superproject path from a submodule cwd without leaking canonical trusted/foreign roots', () => {
    const parentDir = join(tempDir, 'superproject');
    mkdirSync(parentDir, { recursive: true });
    git(parentDir, 'init');
    git(parentDir, 'config user.email "test@example.com"');
    git(parentDir, 'config user.name "Test User"');
    git(parentDir, 'commit --allow-empty -m parent-init');
    execSync(`git -c protocol.file.allow=always submodule add "${sessionRepo}" mysub`, {
      cwd: parentDir,
      stdio: 'pipe',
    });
    const submodulePath = join(parentDir, 'mysub');
    process.chdir(submodulePath);
    clearWorktreeCache();

    const canonicalSubmodule = canonical(submodulePath);
    const canonicalParent = canonical(parentDir);
    const relativeParent = relative(submodulePath, parentDir);

    expect(() => validateWorkingDirectoryOrLinkedWorktree(parentDir)).toThrow(ForeignWorkingDirectoryError);

    const resolution = resolveWorkingDirectoryOrLinkedWorktree(relativeParent);
    expect(resolution.status).toBe('foreign_repository');
    if (resolution.status !== 'foreign_repository') return;
    expect(resolution.callerLabel).toBe(relativeParent);
    expect(resolution.providedRoot).toBe(canonicalParent);

    try {
      validateWorkingDirectoryOrLinkedWorktree(relativeParent);
      expect.unreachable('must throw');
    } catch (error) {
      const foreign = error as ForeignWorkingDirectoryError;
      expect(foreign.message).toContain(relativeParent);
      expect(foreign.message).toContain(basename(submodulePath));
      expect(foreign.message).not.toContain(canonicalSubmodule);
      expect(foreign.message).not.toContain(canonicalParent);
    }
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
