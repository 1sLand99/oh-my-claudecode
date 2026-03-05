# oh-my-claudecode v4.7.1: Team Stability Fixes

## Release Notes

Patch release with critical stability fixes for team orchestration — prevents infinite agent spawning and fixes Gemini CLI worker launch failures.

### Bug Fixes

- **fix(hooks): prevent infinite team spawning** — Disabled automatic team keyword detection in hooks to prevent recursive agent spawning loops. Team mode now requires explicit `/team` invocation only, eliminating the risk of infinite spawn cascades when the keyword "team" appears in natural conversation. (#1355)
- **fix(team): gemini worker launch with correct approval mode** — Fixed Gemini CLI worker spawning by using `--approval-mode yolo -i` flags, matching the expected Gemini CLI interface for non-interactive autonomous execution. Previously, workers would fail to launch due to missing approval mode configuration. (#1356)
- **fix(tests): update tier0 contract test** — Aligned tier0 contract tests with the new explicit-only team mode behavior to prevent false test failures.

### Build

- **chore: rebuild dist artifacts** — Rebuilt `bridge/cli.cjs` and `dist/cli/` with `--json` flag support for `omc team start`, enabling structured JSON output for programmatic team orchestration. Tests for `--json` envelope, `--count` expansion, and non-JSON fallback included.

### Install / Update

```bash
npm install -g oh-my-claude-sisyphus@4.7.1
```

Or reinstall the plugin:
```bash
claude /install-plugin oh-my-claudecode
```

**Full Changelog**: https://github.com/Yeachan-Heo/oh-my-claudecode/compare/v4.7.0...v4.7.1
