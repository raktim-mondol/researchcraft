/**
 * Map dsh's `SessionEvent` stream onto the same compact SSE schema the
 * frontend has always consumed (`web/src/lib/use-agent.ts`'s `AgentFrame`) —
 * deliberately unchanged from the Pi era so the frontend needs no rewrite.
 * `HarnessRuntime.run()`'s `onNotification` callback (see
 * `dsh/runtime/HarnessRuntime.ts`) delivers `HarnessNotification`s whose
 * `params.event` is one of these for the `session.event` method; only that
 * method carries turn/tool/message data, so callers filter to it before
 * calling `toClientFrame`.
 *
 * dsh's event log is flatter-grained than Pi's (a `tool/call` and its
 * `tool/result` are separate top-level events correlated only by `callId`,
 * where Pi's `tool_execution_start`/`_end` both carried the tool name
 * directly) — `createFrameMapper` closes over that one piece of
 * cross-event state a translation needs; everything else stays a pure
 * function of one event.
 */
import type { ContentBlock, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { skillLabelForRead } from "./skill-label.ts";

export interface ClientFrame {
  type: string;
  [k: string]: unknown;
}

/** Frontmatter skill name when a `read` call is a skill activation. */
export function skillFieldFor(
  toolName: string,
  args: unknown,
  sandboxRoot: string,
): { skill: string } | undefined {
  if (toolName !== "read") return undefined;
  const p = (args as { path?: unknown } | null | undefined)?.path;
  const skill = skillLabelForRead(p, sandboxRoot);
  return skill ? { skill } : undefined;
}

/**
 * Rewrite absolute sandbox paths to sandbox-relative ones for display.
 *
 * Tool args and bash commands carry the real host path of the project
 * sandbox (e.g. `/Users/.../projects/<id>/sandbox/de_analysis.py`). Surfacing
 * that in the UI and in shared exports is noisy and leaks the user's
 * filesystem layout. We collapse the sandbox root to a relative path:
 *   - an exact path field `<root>/de_analysis.py` → `de_analysis.py`
 *   - an embedded occurrence in a command (`cd <root> && …`) → `cd . && …`
 */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Matcher for every spelling of the sandbox root worth stripping. Windows-ness
 * is derived from the root string itself (contains "\") so behavior is
 * unit-testable anywhere; on a Windows root, matching also covers the
 * forward-slash spelling, either separator after the root, and any casing
 * (NTFS is case-insensitive — drive letters routinely arrive lowercased).
 */
interface RootMatcher {
  /** Prefix-strip one exact path string; null when no root prefix matches. */
  strip(value: string): string | null;
  /** Strip embedded occurrences inside larger strings (bash commands etc.). */
  stripEmbedded(value: string): string;
}

function rootMatcher(sandboxRoot: string): RootMatcher {
  const win = sandboxRoot.includes("\\");
  const roots = win ? [sandboxRoot, sandboxRoot.replaceAll("\\", "/")] : [sandboxRoot];
  const seps = win ? ["\\", "/"] : ["/"];
  const norm = (s: string) => (win ? s.toLowerCase() : s);
  const toWire = (s: string) => (win ? s.replaceAll("\\", "/") : s);
  const embedded = roots.flatMap((root) =>
    seps.map((sep) => new RegExp(escapeRe(root + sep) + "([^\\s\"'`]*)", win ? "gi" : "g")),
  );
  const bare = roots.map((root) => new RegExp(escapeRe(root), win ? "gi" : "g"));
  return {
    strip(value) {
      for (const root of roots) {
        if (norm(value) === norm(root)) return ".";
        for (const sep of seps) {
          const prefix = root + sep;
          if (norm(value.slice(0, prefix.length)) === norm(prefix)) {
            return toWire(value.slice(prefix.length));
          }
        }
      }
      return null;
    },
    stripEmbedded(value) {
      let s = value;
      for (const re of embedded) s = s.replace(re, (_, tail: string) => toWire(tail));
      for (const re of bare) s = s.replace(re, ".");
      return s;
    },
  };
}

/** Strip an exact sandbox-root prefix off one path string; output is always
 *  wire-format (forward slashes). Non-sandbox paths pass through unchanged. */
export function stripSandboxRoot(value: string, sandboxRoot: string): string {
  if (!sandboxRoot) return value;
  return rootMatcher(sandboxRoot).strip(value) ?? value;
}

export function relativizeSandboxPaths<T>(value: T, sandboxRoot: string): T {
  if (!sandboxRoot) return value;
  return relativizeWith(value, rootMatcher(sandboxRoot));
}

function relativizeWith<T>(value: T, matcher: RootMatcher): T {
  if (typeof value === "string") {
    const stripped = matcher.strip(value) ?? value;
    return matcher.stripEmbedded(stripped) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => relativizeWith(v, matcher)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = relativizeWith(v, matcher);
    }
    return out as T;
  }
  return value;
}

/** Pull human-readable text out of a tool result's content blocks before capping it. */
function resultText(s: unknown): string {
  if (typeof s === "string") return s;
  if (Array.isArray(s)) {
    const parts = s
      .map((p) =>
        p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
          ? (p as { text: string }).text
          : null,
      )
      .filter((t): t is string => t !== null);
    if (parts.length) return parts.join("\n");
  }
  if (s && typeof s === "object") {
    const content = (s as { content?: unknown }).content;
    if (content !== undefined) return resultText(content);
  }
  return JSON.stringify(s ?? "");
}

/** Flatten a user message's content blocks to plain text. Image blocks are
 *  dropped — the UI renders steered messages as text. */
function userMessageText(content: ContentBlock[]): string {
  return content
    .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function cap(s: unknown, max = 4000): string {
  const str = resultText(s);
  return str.length > max ? str.slice(0, max) + "…" : str;
}

/** Best-effort JSON.parse of a tool call's raw `arguments` string (dsh keeps
 *  it as the model's exact unparsed JSON). Falls back to the raw string on
 *  malformed JSON rather than throwing mid-stream. */
function parseToolArgs(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Per-run event-to-frame translator. `tool/result` events don't carry the
 * tool name (only `callId`) — this closes over the `tool/call` events seen
 * so far in this run to recover it. Construct one per run (per
 * `HarnessRuntime.run()` call) and feed it every `session.event` in order;
 * do not share across concurrent runs.
 */
export function createFrameMapper(sandboxRoot = ""): {
  toClientFrame(event: SessionEvent): ClientFrame | null;
} {
  const toolNameByCallId = new Map<string, string>();

  function toClientFrame(event: SessionEvent): ClientFrame | null {
    switch (event.type) {
      case "turn/start":
        return { type: "turn_start" };
      case "turn/end": {
        const { reason } = event.data;
        if (reason.kind === "error") {
          return { type: "error", message: reason.error.message, reason: reason.kind };
        }
        return { type: "turn_end", reason: reason.kind };
      }
      case "user/message": {
        const data = event.data;
        if (data.role !== "user") return null;
        return { type: "message_start", role: "user", content: userMessageText(data.content) };
      }
      case "assistant/chunk": {
        const chunk: StreamChunk = event.data.chunk;
        if (chunk.type === "text-delta") return { type: "text_delta", delta: chunk.text };
        if (chunk.type === "reasoning-delta") return { type: "thinking_delta", delta: chunk.text };
        if (chunk.type === "finish" && chunk.reason.kind === "error") {
          return { type: "error", message: chunk.reason.failure.message, reason: "error" };
        }
        if (chunk.type === "finish" && chunk.reason.kind === "aborted") {
          return { type: "error", message: chunk.reason.failure.message, reason: "aborted" };
        }
        return null;
      }
      case "tool/call": {
        const { callId, name, arguments: rawArgs } = event.data;
        toolNameByCallId.set(String(callId), name);
        const args = relativizeSandboxPaths(parseToolArgs(rawArgs), sandboxRoot);
        return {
          type: "tool_start",
          toolCallId: String(callId),
          toolName: name,
          args,
          ...skillFieldFor(name, args, sandboxRoot),
        };
      }
      case "tool/result": {
        const block = event.data.message.content[0];
        const toolCallId = String(block.toolCallId);
        const toolName = toolNameByCallId.get(toolCallId) ?? "tool";
        return {
          type: "tool_end",
          toolCallId,
          toolName,
          isError: Boolean(block.isError),
          result: cap(block.content),
        };
      }
      default:
        return null;
    }
  }

  return { toClientFrame };
}
