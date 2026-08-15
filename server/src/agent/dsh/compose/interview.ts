/** Row for the `interview` tool — see `../../dsh-plugins/interview-tool.mjs`. */
import { fileURLToPath } from "node:url";
import { row, type PluginRow } from "./rows.ts";

const PLUGIN_PATH = fileURLToPath(
  new URL("../../dsh-plugins/interview-tool.mjs", import.meta.url),
);

export function buildInterviewToolRow(options: {
  projectId: string;
  kadyDir: string;
  internalBaseUrl: string;
}): PluginRow {
  return row("interview-tool", PLUGIN_PATH, options);
}
