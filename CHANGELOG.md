# oh-my-claudecode v5.0.1

## Release Notes

v5.0.1 is the patch release from `v5.0.0..9e701b690a87acb546297ef5b1c93b0b1ad480b2`. It consolidates the latest workflow, state, team, and Cursor reliability work without exposing internal release operations.

### Highlights

- Adds the graph workflow entrypoint and `omc graph run`, including crash recovery, approval handling, progress reporting, and runtime authority checks.
- Improves workflow discovery and execution guidance across the canonical execute, review, research, and team surfaces.
- Hardens persistent state ownership, recovery, migration, locking, identity, and non-Git workspace handling.
- Improves team worker lifecycle reliability, including worker bootstrap state, claims, inbox/task paths, verdict finalization, and slow-start behavior.
- Fixes Cursor worker trust, reviewer routing, model forwarding, launch, and verdict lifecycle issues.
- Strengthens script, live-data, Windows argument, and dependency-runtime security boundaries.
- Keeps prompt projections, inventory metadata, plugin payloads, and package shipping surfaces deterministic and synchronized.

### Validation

The release candidate was validated against the exact candidate head with version, projection, inventory, plugin-shipping, build, typecheck, lint, package, and release-boundary checks. Full test execution remains subject to the repository's existing environment-sensitive failures; the release process must not treat those failures as passing evidence.
