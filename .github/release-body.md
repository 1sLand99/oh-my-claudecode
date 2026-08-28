## OMC v5.0.2

v5.0.2 is the patch release from `v5.0.1..9d4d6c834fdd78febdb177eba70dc264efafad93`.

### Highlights

- Corrects Claude Code subagent nesting and concurrency workflow guidance.
- Hardens graph artifact containment and path validation, including traversal, TOCTOU, epoch, symlink, and identity cases.
- Fails closed for macOS graph execution when a safe directory-descriptor primitive is unavailable; macOS graph execution is intentionally not restored by this release.

### Verification

Release validation covers exact-head version consistency, projections, inventory, graph runtime tests, lint, typecheck, tests, build, package checks, and release-boundary checks.
