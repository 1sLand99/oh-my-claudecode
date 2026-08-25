---
name: graph
description: Deterministic orchestration graph runtime - declarative DAG pipelines with journal-based crash recovery
argument-hint: "<descriptor.json | describe the pipeline> [--runs-root <dir>]"
aliases: []
level: 4
---

# Graph Skill

Run a deterministic orchestration graph from a declarative JSON descriptor.
The runtime consumes the sealed-descriptor and pure-scheduler contracts in
`src/graph/*` and executes through an independent OS process (`omc graph run`),
so crash recovery (kill mid-run, rerun, resume from journal) works for real.

## Usage

```
/oh-my-claudecode:graph <descriptor.json>
/oh-my-claudecode:graph "build then test then ask me before deploy"   (author the descriptor first)
```

The execution surface is always the CLI subcommand:

    omc graph run <descriptor.json> [--runs-root <dir>]

Run it via the Bash tool for non-interactive graphs. Progress lines stream as
`[run]`, `[node]`, `[ok]`, `[fail]`, `[join]`, `[done]`.

## When To Use

- Repeatable multi-step pipelines with explicit dependencies (DAG)
- Work that must survive interruption: kill/restart resumes from journal
- Auditable runs: OCC journal + projection snapshots under `.omc/graph-runs/<run_id>/`

When NOT to use: exploratory one-off work (use conversation or /team);
anything needing adaptive re-planning mid-run (graphs are deterministic).

## Workflow

1. **Descriptor given** -> go to step 3.
2. **Pipeline described** -> author the descriptor JSON (schema below), write
   it next to the project (suggest `.omc/graphs/<name>.json`) and show it to
   the user before running. `run_id` must be unique per logical pipeline;
   rerunning with the same `run_id` RESUMES, not restarts.
3. **Approval nodes**: if the descriptor contains any `"kind": "human-approval"`
   node, do NOT run it through the Bash tool (stdin is not interactive there;
   EOF fails closed to denied). Tell the user to run interactively instead:

       ! omc graph run <file>

   The `!` prefix runs it inside this session with live stdin so y/n works.
4. Run and relay progress. Exit codes (normative):
   0 succeeded | 1 terminal failed | 19 another writer owns this run (busy)
   20 corrupt/tampered journal (fail-closed) | 21 descriptor drift on resume
   | 70 runtime crash (unmapped error)
5. **Resume**: rerunning the same command after a crash replays committed
   transitions and continues. Completed nodes never re-execute.

## Descriptor Schema (minimal)

{
  "descriptor_version": 1,
  "run_id": "unique-pipeline-id",
  "revision_id": "rev-1",
  "goal": "one line",
  "nodes": [
    { "id": "n1", "kind": "command", "title": "...", "timeout_ms": 60000,
      "max_attempts": 2, "effect_policy": { "policy": "side_effect_free" },
      "command": "npm test" },
    { "id": "a1", "kind": "agent", "title": "...", "timeout_ms": 300000,
      "max_attempts": 1, "effect_policy": { "policy": "side_effect_free" },
      "instructions": "..." },
    { "id": "gate", "kind": "human-approval", "title": "...",
      "prompt": "Proceed?" }
  ],
  "edges": [ { "id": "e1", "kind": "fixed", "from": "n1", "to": "a1" } ],
  "entry_node_ids": ["n1"],
  "concurrency_limit": 2,
  "terminal_verification_node_id": "a1"
}

Edge kinds: fixed | conditional (needs route on result) | fan_out/join pairs
| back_edge (bounded retries via max_traversals). See src/graph/schema.ts for
the authoritative Zod schema.
