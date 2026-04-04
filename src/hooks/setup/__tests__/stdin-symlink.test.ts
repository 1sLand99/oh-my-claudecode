/**
 * Tests for ensureStdinSymlink (issue #2152)
 *
 * Verifies that the stdin.mjs symlink is correctly created and healed
 * when OMC upgrades to a new version. The symlink should always point
 * to the current plugin version's templates/hooks/lib/stdin.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, unlinkSync, symlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ensureStdinSymlink } from '../index.js';

describe('ensureStdinSymlink', () => {
  let pluginRoot: string;
  let homeDir: string;
  let hooksLibDir: string;
  let stdinSrcPath: string;

  beforeEach(() => {
    // Create a temporary plugin root with the templates structure
    pluginRoot = mkdtempSync(join(tmpdir(), 'omc-stdin-'));
    const templatesDir = join(pluginRoot, 'templates/hooks/lib');
    mkdirSync(templatesDir, { recursive: true });

    // Create a fake stdin.mjs in the source location
    stdinSrcPath = join(templatesDir, 'stdin.mjs');
    writeFileSync(stdinSrcPath, '// fake stdin.mjs content\n');

    // Mock os.homedir() by temporarily replacing it
    homeDir = mkdtempSync(join(tmpdir(), 'omc-home-'));
    hooksLibDir = join(homeDir, '.claude/hooks/lib');
  });

  afterEach(() => {
    rmSync(pluginRoot, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('creates the destination directory if it does not exist', () => {
    // Mock the homedir to use our temp directory
    const originalHomedir = require('os').homedir;
    require('os').homedir = () => homeDir;

    try {
      ensureStdinSymlink(pluginRoot);
      expect(existsSync(hooksLibDir)).toBe(true);
    } finally {
      require('os').homedir = originalHomedir;
    }
  });

  it('creates a symlink from ~/.claude/hooks/lib/stdin.mjs to the plugin source', () => {
    const originalHomedir = require('os').homedir;
    require('os').homedir = () => homeDir;

    try {
      ensureStdinSymlink(pluginRoot);
      const stdinDst = join(hooksLibDir, 'stdin.mjs');
      expect(existsSync(stdinDst)).toBe(true);
      expect(lstatSync(stdinDst).isSymbolicLink()).toBe(true);
    } finally {
      require('os').homedir = originalHomedir;
    }
  });

  it('heals an existing symlink that points to a different location', () => {
    const originalHomedir = require('os').homedir;
    require('os').homedir = () => homeDir;

    try {
      // Create the directory and a stale symlink pointing elsewhere
      mkdirSync(hooksLibDir, { recursive: true });
      const staleTarget = join(tmpdir(), 'stale-stdin');
      mkdirSync(staleTarget, { recursive: true });
      writeFileSync(join(staleTarget, 'stdin.mjs'), '// stale');
      const stdinDst = join(hooksLibDir, 'stdin.mjs');
      symlinkSync(join(staleTarget, 'stdin.mjs'), stdinDst);

      // Run the healing function
      ensureStdinSymlink(pluginRoot);

      // The symlink should now point to the new source
      const linkTarget = readFileSync(stdinDst, 'utf-8');
      expect(linkTarget).toBe('// fake stdin.mjs content\n');
    } finally {
      require('os').homedir = originalHomedir;
    }
  });

  it('is idempotent — calling twice does not throw', () => {
    const originalHomedir = require('os').homedir;
    require('os').homedir = () => homeDir;

    try {
      ensureStdinSymlink(pluginRoot);
      expect(() => ensureStdinSymlink(pluginRoot)).not.toThrow();
    } finally {
      require('os').homedir = originalHomedir;
    }
  });

  it('is a no-op when pluginRoot does not exist', () => {
    const originalHomedir = require('os').homedir;
    require('os').homedir = () => homeDir;

    try {
      expect(() =>
        ensureStdinSymlink(join(tmpdir(), 'nonexistent-plugin-root-xyz'))
      ).not.toThrow();
    } finally {
      require('os').homedir = originalHomedir;
    }
  });
});
