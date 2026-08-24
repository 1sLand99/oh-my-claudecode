import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { clearWorktreeCache } from '../../lib/worktree-paths.js';
import {
  wikiIngestTool,
  wikiAddTool,
  wikiQueryTool,
  wikiReadTool,
  wikiListTool,
  wikiLintTool,
  wikiDeleteTool,
} from '../wiki-tools.js';

function git(cwd: string, command: string): void {
  execSync(`git ${command}`, { cwd, stdio: 'pipe' });
}

describe('wiki tools foreign-repository workingDirectory (#3858)', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalOmcStateDir: string | undefined;
  let sessionRepo: string;
  let foreignRepo: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalOmcStateDir = process.env.OMC_STATE_DIR;
    delete process.env.OMC_STATE_DIR;
    tempDir = mkdtempSync(join(tmpdir(), 'wiki-foreign-3858-'));
    clearWorktreeCache();

    sessionRepo = join(tempDir, 'session-project');
    mkdirSync(sessionRepo, { recursive: true });
    git(sessionRepo, 'init');
    git(sessionRepo, 'config user.email "test@example.com"');
    git(sessionRepo, 'config user.name "Test User"');
    writeFileSync(join(sessionRepo, 'README.md'), 'session project\n');
    git(sessionRepo, 'add README.md');
    git(sessionRepo, 'commit -m initial');

    foreignRepo = join(tempDir, 'foreign-vault');
    mkdirSync(foreignRepo, { recursive: true });
    git(foreignRepo, 'init');
    git(foreignRepo, 'config user.email "test@example.com"');
    git(foreignRepo, 'config user.name "Test User"');
    writeFileSync(join(foreignRepo, 'README.md'), 'foreign vault\n');
    git(foreignRepo, 'add README.md');
    git(foreignRepo, 'commit -m initial');
    // Populated wiki corpus in the foreign repository.
    mkdirSync(join(foreignRepo, '.omc', 'wiki'), { recursive: true });
    writeFileSync(
      join(foreignRepo, '.omc', 'wiki', 'aapanel-setup.md'),
      '---\ntitle: aaPanel Setup\ncategory: reference\nconfidence: high\ntags: [aapanel, hosting]\nupdated: 2026-08-24\n---\n\naaPanel reverse proxy notes for the vault.\n',
    );

    process.chdir(sessionRepo);
    clearWorktreeCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    clearWorktreeCache();
    if (originalOmcStateDir === undefined) {
      delete process.env.OMC_STATE_DIR;
    } else {
      process.env.OMC_STATE_DIR = originalOmcStateDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('wiki_query rejects a foreign-repository workingDirectory visibly instead of returning empty matches', async () => {
    const result = await wikiQueryTool.handler({ query: 'aaPanel', workingDirectory: foreignRepo });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('belongs to a different repository');
    expect(text).toContain('not used');
    expect(text).toContain(basename(foreignRepo));
    // No silent "no results" answer for knowledge that exists elsewhere.
    expect(text).not.toContain('No wiki pages match');
  });

  it('wiki_read rejects a foreign-repository workingDirectory instead of reporting not-found', async () => {
    const result = await wikiReadTool.handler({ page: 'aapanel-setup', workingDirectory: foreignRepo });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('belongs to a different repository');
    expect(text).not.toContain('Wiki page not found');
  });

  it('wiki_ingest rejects a foreign-repository workingDirectory and writes to neither repository', async () => {
    const before = {
      sessionWiki: existsSync(join(sessionRepo, '.omc', 'wiki')),
      foreignPages: existsSync(join(foreignRepo, '.omc', 'wiki', 'foreign-page.md')),
    };

    const result = await wikiIngestTool.handler({
      title: 'Foreign Page',
      content: 'should never be written',
      tags: ['x'],
      category: 'reference',
      workingDirectory: foreignRepo,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('belongs to a different repository');
    // No fallback-root write: the session repo must not gain a wiki directory,
    // and the foreign repo must not gain the page.
    expect(existsSync(join(sessionRepo, '.omc', 'wiki', 'foreign-page.md'))).toBe(false);
    expect(existsSync(join(foreignRepo, '.omc', 'wiki', 'foreign-page.md'))).toBe(false);
    if (!before.sessionWiki) {
      expect(existsSync(join(sessionRepo, '.omc', 'wiki'))).toBe(false);
    }
  });

  it('wiki_add rejects a foreign-repository workingDirectory without writing', async () => {
    const result = await wikiAddTool.handler({
      title: 'Foreign Page',
      content: 'should never be written',
      workingDirectory: foreignRepo,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('belongs to a different repository');
    expect(existsSync(join(sessionRepo, '.omc', 'wiki', 'foreign-page.md'))).toBe(false);
    expect(existsSync(join(foreignRepo, '.omc', 'wiki', 'foreign-page.md'))).toBe(false);
  });

  it('wiki_delete rejects a foreign-repository workingDirectory without touching either wiki', async () => {
    const result = await wikiDeleteTool.handler({ page: 'aapanel-setup', workingDirectory: foreignRepo });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('belongs to a different repository');
    // The foreign page still exists — no cross-repo deletion, no fallback hit.
    expect(existsSync(join(foreignRepo, '.omc', 'wiki', 'aapanel-setup.md'))).toBe(true);
  });

  it('wiki_lint and wiki_list reject a foreign-repository workingDirectory', async () => {
    const lintResult = await wikiLintTool.handler({ workingDirectory: foreignRepo });
    expect(lintResult.isError).toBe(true);
    expect(lintResult.content[0].text).toContain('belongs to a different repository');

    const listResult = await wikiListTool.handler({ workingDirectory: foreignRepo });
    expect(listResult.isError).toBe(true);
    expect(listResult.content[0].text).toContain('belongs to a different repository');
  });

  it('the trusted repository is identified by basename only, not absolute path', async () => {
    const result = await wikiQueryTool.handler({ query: 'aaPanel', workingDirectory: foreignRepo });
    const text = result.content[0].text;

    expect(text).toContain(basename(sessionRepo));
    expect(text).not.toContain(sessionRepo);
  });

  it('wiki_query reports searched root and corpus size for a genuine no-match inside the trusted repo', async () => {
    // Seed one page in the session repo so the corpus is non-empty.
    const addResult = await wikiAddTool.handler({
      title: 'Session Note',
      content: 'belongs to session repo wiki',
    });
    expect(addResult.isError).toBeUndefined();

    const result = await wikiQueryTool.handler({ query: 'aaPanel' });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('No wiki pages match "aaPanel".');
    expect(text).toContain('searched 1 page');
    expect(text).toContain(basename(sessionRepo));
    expect(text).not.toContain(sessionRepo);
  });

  it('wiki_list names the searched root when the wiki is empty', async () => {
    const result = await wikiListTool.handler({});
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('Wiki is empty.');
    expect(text).toContain('searched 0 pages');
    expect(text).toContain(basename(sessionRepo));
    expect(text).not.toContain(sessionRepo);
  });
});
