import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { inspect } from 'node:util';
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
function loggerLikeWrap(value: unknown): unknown {
  if (value instanceof Error) {
    const wrapped: Record<string, unknown> = { ...value };
    wrapped.name = value.name;
    wrapped.message = value.message;
    wrapped.cause = value.cause !== undefined ? loggerLikeWrap(value.cause) : undefined;
    return wrapped;
  }
  if (value !== null && typeof value === 'object') {
    return { ...value };
  }
  return value;
}

function assertOpaqueCanonicalSerialization(
  value: { providedRoot: string; trustedRoot: string; callerLabel: string },
  opts: { providedRoot: string; trustedRoot: string; callerLabel: string },
): void {
  expect(value.providedRoot).toBe(opts.providedRoot);
  expect(value.trustedRoot).toBe(opts.trustedRoot);
  expect(value.callerLabel).toBe(opts.callerLabel);

  const provided = Object.getOwnPropertyDescriptor(value, 'providedRoot');
  const trusted = Object.getOwnPropertyDescriptor(value, 'trustedRoot');
  const caller = Object.getOwnPropertyDescriptor(value, 'callerLabel');
  expect(provided).toMatchObject({
    enumerable: false,
    writable: false,
    configurable: false,
    value: opts.providedRoot,
  });
  expect(trusted).toMatchObject({
    enumerable: false,
    writable: false,
    configurable: false,
    value: opts.trustedRoot,
  });
  expect(caller?.enumerable).toBe(true);
  expect(caller?.value).toBe(opts.callerLabel);
  expect(Object.keys(value)).not.toContain('providedRoot');
  expect(Object.keys(value)).not.toContain('trustedRoot');
  expect(Object.keys(value)).toContain('callerLabel');

  const spread = { ...value };
  expect(spread).not.toHaveProperty('providedRoot');
  expect(spread).not.toHaveProperty('trustedRoot');
  expect(spread.callerLabel).toBe(opts.callerLabel);

  const cloned = structuredClone(value);
  const wrappedError = new Error('logger wrap', { cause: value as unknown as Error });
  const clonedWrapper = structuredClone(wrappedError);
  const payloads = [
    JSON.stringify(value),
    JSON.stringify(spread),
    JSON.stringify(cloned),
    JSON.stringify(loggerLikeWrap(value)),
    JSON.stringify(loggerLikeWrap(wrappedError)),
    JSON.stringify({ err: value, cause: value }),
    JSON.stringify({ ...clonedWrapper, cause: clonedWrapper.cause }),
    inspect(value, { depth: 8, getters: true, showHidden: false }),
  ];

  for (const path of [opts.providedRoot, opts.trustedRoot]) {
    for (const payload of payloads) {
      expect(payload).not.toContain(path);
    }
  }

  const parsed = JSON.parse(JSON.stringify(value)) as { callerLabel?: string };
  expect(parsed.callerLabel).toBe(opts.callerLabel);
  expect(parsed).not.toHaveProperty('providedRoot');
  expect(parsed).not.toHaveProperty('trustedRoot');
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
    expect(resolution.status).toBe('foreign_repository');
    if (resolution.status !== 'foreign_repository') return;
    expect(resolution.providedRoot).toBe(canonicalForeign);
    expect(resolution.trustedRoot).toBe(canonicalSession);
    expect(resolution.callerLabel).toBe(foreignRepo);
    expect('root' in resolution).toBe(false);
    expect(resolution).toEqual({
      status: 'foreign_repository',
      callerLabel: foreignRepo,
    });
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
    assertOpaqueCanonicalSerialization(error, {
      providedRoot: '/canonical/foreign-vault',
      trustedRoot: '/canonical/session-project',
      callerLabel: '../foreign-vault',
    });
    const inspected = inspect(error, { depth: 8, getters: true, showHidden: false });
    expect(inspected).toContain('at ');
    expect(inspected).toContain('../foreign-vault');
    expect(inspected).not.toContain('/canonical/foreign-vault');
    expect(inspected).not.toContain('/canonical/session-project');
  });

  it('foreign_repository resolution and thrown error keep canonical roots opaque under serialization', () => {
    const relativeAlias = join('..', 'foreign-vault');
    const resolution = resolveWorkingDirectoryOrLinkedWorktree(relativeAlias);
    expect(resolution.status).toBe('foreign_repository');
    if (resolution.status !== 'foreign_repository') return;

    assertOpaqueCanonicalSerialization(resolution, {
      providedRoot: canonicalForeign,
      trustedRoot: canonicalSession,
      callerLabel: relativeAlias,
    });

    try {
      validateWorkingDirectoryOrLinkedWorktree(relativeAlias);
      expect.unreachable('must throw');
    } catch (error) {
      const foreign = error as ForeignWorkingDirectoryError;
      expect(foreign.message).toContain(relativeAlias);
      expect(foreign.message).not.toContain(canonicalForeign);
      expect(foreign.message).not.toContain(canonicalSession);
      expect(foreign.message).toContain(basename(sessionRepo));
      assertOpaqueCanonicalSerialization(foreign, {
        providedRoot: canonicalForeign,
        trustedRoot: canonicalSession,
        callerLabel: relativeAlias,
      });
    }
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
