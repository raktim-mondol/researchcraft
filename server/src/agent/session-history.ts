/**
 * Replay a ResearchCraft session's stored dsh transcript(s) as the client SSE
 * frame vocabulary, for the frontend's "reopen session" reload recovery
 * (folds these frames through the same reducer it uses for live streams —
 * `applyFrameToMessage` — so a reopened transcript renders exactly like it
 * did while streaming).
 *
 * A ResearchCraft session can span multiple dsh "generations" (see
 * `session-registry.ts`'s file doc): each generation minted its own dsh
 * session id and wrote its own JSONL log under `dshSessionsRoot`. This reads
 * every generation in order and concatenates their frames — full transcript
 * fidelity survives a restart/abort/model-change even though the *live*
 * model conversation does not (that gap is model memory, not stored history).
 */
import { createFrameMapper, type ClientFrame } from "./events.ts";
import { readSessionLog } from "./dsh/session-log.ts";
import { dshSessionsRoot, getManifest } from "./session-registry.ts";
import type { ProjectPaths } from "../projects.ts";

export interface HistoryMessage {
  role: "user" | "assistant";
  /** Prompt text — user messages only. */
  content?: string;
  /** Ordered replay frames — assistant messages only. */
  frames?: ClientFrame[];
  /** Wall-clock ms of the underlying log event, when recorded. */
  timestamp?: number;
}

export async function toHistory(paths: ProjectPaths, sessionId: string): Promise<HistoryMessage[]> {
  const manifest = getManifest(paths, sessionId);
  if (!manifest) return [];

  const out: HistoryMessage[] = [];
  let assistant: HistoryMessage | null = null;
  const pushFrame = (f: ClientFrame, timestamp: number) => {
    if (!assistant) {
      assistant = { role: "assistant", frames: [], timestamp };
      out.push(assistant);
    }
    assistant.frames!.push(f);
  };

  const root = dshSessionsRoot(paths);
  const mapper = createFrameMapper(paths.sandbox);
  for (const generation of manifest.generations) {
    const events = await readSessionLog(root, paths.sandbox, generation.dshSessionId);
    for (const event of events) {
      const frame = mapper.toClientFrame(event);
      if (!frame) continue;
      if (frame.type === "message_start" && frame.role === "user") {
        const content = typeof frame.content === "string" ? frame.content : "";
        if (!content.trim()) continue;
        out.push({ role: "user", content, timestamp: event.time });
        assistant = null;
        continue;
      }
      if (frame.type === "text_delta" || frame.type === "thinking_delta" ||
          frame.type === "tool_start" || frame.type === "tool_end") {
        pushFrame(frame, event.time);
      }
    }
  }
  return out;
}
