/**
 * Unit tests for the agent node executor. All SDK interactions go through
 * injected fakes — zero network in CI.
 */

import { describe, expect, it } from "vitest";
import { sealGraphDescriptor } from "../../../descriptor.js";
import { approvalDescriptor } from "../../fixtures.js";
import { AgentNodeExecutor } from "../../../runtime/executors/agent.js";
import type {
  NodeExecutionContext,
  NodeExecutionOutput,
} from "../../../runtime/types.js";
import type { GraphAgentNode } from "../../../types.js";

function makeContext(overrides?: Partial<NodeExecutionContext>): NodeExecutionContext {
  const descriptor = sealGraphDescriptor(approvalDescriptor());
  const node = descriptor.nodes.find((n) => n.id === "entry") as GraphAgentNode;
  return {
    descriptor,
    node,
    activation_id: "act-1",
    attempt_id: "att-1",
    attempt_no: 1,
    ...overrides,
  };
}

describe("AgentNodeExecutor", () => {
  it("succeeds and summarizes final text from a fake stream", async () => {
    let receivedOptions: unknown;
    const executor = new AgentNodeExecutor(async function* (
      options: unknown,
    ) {
      receivedOptions = options;
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Analysis complete." }] },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Analysis complete.",
      };
    });

    const output: NodeExecutionOutput = await executor.execute(makeContext());

    expect(output.outcome).toBe("succeeded");
    expect(output.output_summary).toContain("Analysis complete.");
    expect(output.evidence_refs).toEqual([
      {
        kind: "url",
        ref: "agent://act-1",
        summary: "agent attempt att-1",
      },
    ]);
    expect(receivedOptions).toMatchObject({
      prompt: expect.stringContaining("\n\nGoal: Verify human approval gate"),
    });
  });

  it("fails when the query throws", async () => {
    const executor = new AgentNodeExecutor(() => {
      throw new Error("boom");
    });

    const output = await executor.execute(makeContext());

    expect(output.outcome).toBe("failed");
    expect(output.output_summary).toContain("error:");
    expect(output.output_summary).toContain("boom");
  });

  it("fails with timeout noted when timeout fires before the impl settles", async () => {
    const executor = new AgentNodeExecutor(
      (_options: unknown) => new Promise(() => {}), // never settles
    );

    const base = makeContext();
    const output = await executor.execute({
      ...base,
      node: { ...base.node, timeout_ms: 10 },
    });

    expect(output.outcome).toBe("failed");
    expect(output.output_summary).toBe("timeout after 10ms");
  });

  it("fails on empty response", async () => {
    const executor = new AgentNodeExecutor(async function* () {});

    const output = await executor.execute(makeContext());

    expect(output.outcome).toBe("failed");
    expect(output.output_summary).toBe("empty response");
  });

  it("truncates summaries to 2000 characters", async () => {
    const long = "x".repeat(3000);
    const executor = new AgentNodeExecutor(async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: long }] },
      };
    });

    const output = await executor.execute(makeContext());

    expect(output.outcome).toBe("succeeded");
    expect(output.output_summary?.length).toBe(2000);
  });

  it("accumulates multi-message streams instead of keeping only the last chunk", async () => {
    const executor = new AgentNodeExecutor(async function* () {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "part one." }] },
      };
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "part two." }] },
      };
    });

    const output = await executor.execute(makeContext());

    expect(output.outcome).toBe("succeeded");
    expect(output.output_summary).toContain("part one.");
    expect(output.output_summary).toContain("part two.");
  });
});
