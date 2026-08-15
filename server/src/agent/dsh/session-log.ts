/**
 * Read-only access to `dsh-session-persistence-jsonl`'s on-disk transcript
 * format. The path-building and packed-chunk-decoding logic here is ported
 * verbatim from that package's `src/format.ts` (see the vendored source at
 * `@deepseek-ai/dsh-session-persistence-jsonl`) because none of it is part of
 * that package's public export surface — only its `JsonlCompression` type is
 * re-exported, the path/decode helpers are internal to its own read/write
 * class. Porting the real algorithm (not reverse-engineering the format from
 * examples) keeps this exactly in sync with what the runtime actually writes.
 *
 * Used for offline history reconstruction (`session-history.ts`) — never for
 * writing; only the runtime subprocess itself writes these logs.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeStorageRecord, type SessionEvent } from "@deepseek-ai/dsh-session";

type JsonlCompression = "zstd" | "none";

function logSuffix(compression: JsonlCompression): ".jsonl.zstd" | ".jsonl" {
  return compression === "zstd" ? ".jsonl.zstd" : ".jsonl";
}

/** Ported verbatim from `dsh-session-persistence-jsonl/src/format.ts#encodeSegment`. */
function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch;
    } else {
      out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  return out;
}

/** Ported verbatim from `dsh-session-persistence-jsonl/src/format.ts#projectKey`. */
function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}

function projectDir(root: string, cwd: string | undefined): string {
  if (cwd === undefined) return join(root, "_no-cwd");
  return join(root, projectKey(cwd));
}

function sessionDir(root: string, cwd: string | undefined, id: string): string {
  return join(projectDir(root, cwd), encodeSegment(id));
}

/** The JSONL artifact path for one session, matching `dsh-session-persistence-jsonl`'s layout exactly. */
export function sessionLogPath(
  root: string,
  cwd: string | undefined,
  id: string,
  compression: JsonlCompression = "none",
): string {
  return join(sessionDir(root, cwd, id), `session${logSuffix(compression)}`);
}

/**
 * Read and fully decode one session's event log. Returns `[]` if the file
 * doesn't exist (a generation that spawned a runtime but never got a prompt
 * delivered — e.g. an immediate abort — leaves nothing on disk, same as the
 * live wire protocol's own "created but never appended" sessions).
 * Malformed/torn trailing lines are skipped rather than failing the whole
 * read — this is a best-effort history view, not the durable store itself.
 */
export async function readSessionLog(
  root: string,
  cwd: string | undefined,
  id: string,
  compression: JsonlCompression = "none",
): Promise<SessionEvent[]> {
  let text: string;
  try {
    text = await readFile(sessionLogPath(root, cwd, id, compression), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  // First line is the header record ({type: 'session', ...}), not an event.
  const events: SessionEvent[] = [];
  for (const line of lines.slice(1)) {
    try {
      events.push(...decodeStorageRecord(JSON.parse(line)));
    } catch {
      break; // torn tail (in-flight write) or corrupt line — stop, keep what's contiguous
    }
  }
  return events;
}
