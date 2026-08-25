/**
 * Agent node executor.
 *
 * Runs one GraphAgentNode attempt through the Claude Agent SDK. The SDK is
 * lazy-imported inside execute() so unit tests inject fakes and never require
 * network access; the injectable queryImpl mirrors `query` from
 * `@anthropic-ai/claude-agent-sdk`.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  NodeExecutionContext,
  NodeExecutionOutput,
  NodeExecutor,
} from "../types.js";
import type { GraphEvidenceReference } from "../../types.js";

/** Injectable SDK surface: the real `query` or a test fake. */
export type AgentQueryImpl = (
  options: unknown,
) => AsyncIterable<unknown> | Promise<unknown>;

const SUMMARY_LIMIT = 2000;

class AgentTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`);
    this.name = "AgentTimeoutError";
  }
}

class AgentRunError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    isRecord(value) &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

/** Text of an assistant message's text blocks, or null when not one. */
function assistantText(message: unknown): string | null {
  if (!isRecord(message) || message.type !== "assistant") return null;
  const inner = message.message;
  if (!isRecord(inner) || !Array.isArray(inner.content)) return null;
  const parts: string[] = [];
  for (const block of inner.content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

/** Terminal SDK result message: ok with final text, failed with reason, or null. */
function sdkResult(
  message: unknown,
): { ok: true; text: string } | { ok: false; reason: string } | null {
  if (!isRecord(message) || message.type !== "result") return null;
  if (message.subtype !== "success" || message.is_error === true) {
    const reason =
      typeof message.subtype === "string" ? message.subtype : "error";
    return { ok: false, reason };
  }
  return { ok: true, text: typeof message.result === "string" ? message.result : "" };
}

function truncate(text: string): string {
  return text.length > SUMMARY_LIMIT ? text.slice(0, SUMMARY_LIMIT) : text;
}

export class AgentNodeExecutor implements NodeExecutor {
  readonly kinds = ["agent"] as const;

  constructor(private readonly queryImpl?: AgentQueryImpl) {}

  async execute(context: NodeExecutionContext): Promise<NodeExecutionOutput> {
    const node = context.node;
    if (node.kind !== "agent") {
      return failed(context, `unsupported node kind ${node.kind}`);
    }

    const prompt = `${node.instructions}\n\nGoal: ${context.descriptor.goal}`;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), node.timeout_ms);

    try {
      let queryFn: AgentQueryImpl;
      if (this.queryImpl) {
        queryFn = this.queryImpl;
      } else {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        queryFn = (options: unknown) =>
          query(options as { prompt: string; options?: Options });
      }

      const collect = async (): Promise<string> => {
        const returned = queryFn({ prompt, options: { abortController } });
        if (!isAsyncIterable(returned)) {
          const value = await returned;
          const final = sdkResult(value);
          if (final) {
            if (!final.ok) throw new AgentRunError(`sdk result error: ${final.reason}`);
            return final.text;
          }
          return assistantText(value) ?? "";
        }
        let text = "";
        for await (const message of returned) {
          const final = sdkResult(message);
          if (final) {
            if (!final.ok) throw new AgentRunError(`sdk result error: ${final.reason}`);
            return final.text;
          }
          const chunk = assistantText(message);
          if (chunk !== null) text = chunk;
        }
        return text;
      };

      // Rejects when the timer fires even if the underlying query never settles.
      const timedOut = new Promise<never>((_, reject) => {
        abortController.signal.addEventListener(
          "abort",
          () => reject(new AgentTimeoutError(node.timeout_ms)),
          { once: true },
        );
      });

      const work = collect();
      try {
        const text = await Promise.race([work, timedOut]);
        if (text.trim().length === 0) {
          return failed(context, "empty response");
        }
        return {
          outcome: "succeeded",
          output_summary: truncate(text),
          evidence_refs: evidenceRefs(context),
        };
      } finally {
        work.catch(() => {}); // loser of the race may still reject post-abort
      }
    } catch (error) {
      if (error instanceof AgentTimeoutError) {
        return failed(context, error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      return failed(context, `error: ${truncate(message)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function evidenceRefs(
  context: NodeExecutionContext,
): readonly GraphEvidenceReference[] {
  return [
    {
      kind: "url",
      ref: `agent://${context.activation_id}`,
      summary: `agent attempt ${context.attempt_id}`,
    },
  ];
}

function failed(context: NodeExecutionContext, summary: string): NodeExecutionOutput {
  return {
    outcome: "failed",
    output_summary: summary,
    evidence_refs: evidenceRefs(context),
  };
}
