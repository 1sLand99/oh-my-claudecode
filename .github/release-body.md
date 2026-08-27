## OMC v5.0.1

v5.0.1 is the patch release from `v5.0.0..9e701b690a87acb546297ef5b1c93b0b1ad480b2`.

### Highlights

- Adds the graph workflow entrypoint and `omc graph run`, with crash recovery, approvals, progress reporting, and runtime authority checks.
- Improves canonical workflow discovery and execution guidance.
- Hardens persistent state ownership, recovery, migration, locking, identity, and non-Git workspace handling.
- Improves team worker bootstrap, claims, task/inbox paths, verdict finalization, and slow-start reliability.
- Fixes Cursor worker trust, reviewer routing, model forwarding, launch, and verdict lifecycle issues.
- Strengthens script, live-data, Windows argument, and dependency-runtime security boundaries.
- Synchronizes prompt projections, inventory metadata, plugin payloads, and package shipping artifacts.

### Verification

Release validation covers exact-head version consistency, projections, inventory, plugin shipping, lint, typecheck, tests, build, package checks, and release-boundary checks.
