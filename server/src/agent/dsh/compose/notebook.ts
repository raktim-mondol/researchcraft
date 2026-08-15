/** Row for the `notebook` tool — see `../../dsh-plugins/notebook-tool.mjs`. */
import { fileURLToPath } from "node:url";
import { row, type PluginRow } from "./rows.ts";

const PLUGIN_PATH = fileURLToPath(
  new URL("../../dsh-plugins/notebook-tool.mjs", import.meta.url),
);

export function buildNotebookToolRow(options: {
  projectId: string;
  kadyDir: string;
  sandboxRoot: string;
}): PluginRow {
  return row("notebook-tool", PLUGIN_PATH, options);
}
