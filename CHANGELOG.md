# oh-my-claudecode v5.0.2

## Release Notes

v5.0.2 is the patch release from `v5.0.1..9d4d6c834fdd78febdb177eba70dc264efafad93`. It corrects Claude Code subagent nesting and concurrency guidance and hardens graph artifact containment and path handling.

### Highlights

- Corrects Claude Code subagent nesting and concurrency workflow guidance for current Claude Code releases.
- Replaces opaque macOS `/dev/fd/N` graph failures with explicit fail-closed containment when a safe directory-descriptor primitive is unavailable.
- Closes graph artifact basename traversal, path-fallback time-of-check/time-of-use, malformed or unsafe epoch, symlink, and identity-validation gaps.
- Keeps graph execution deterministic and safe on supported platforms while intentionally not restoring macOS graph execution without a safe `dirfd` primitive.

### Validation

The release candidate was validated against the exact candidate head with version, projection, inventory, graph safe-fs/fence/CLI tests, build, typecheck, lint, package, and release-boundary checks. The release process must not treat any failing or unavailable validation as passing evidence.
