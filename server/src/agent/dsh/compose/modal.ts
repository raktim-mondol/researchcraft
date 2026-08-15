/** Row for the `modal_run` tool — see `../../dsh-plugins/modal-tool.mjs`. Only composed when Modal BYOK creds are configured (`config.ts`'s `modalConfigured()`). */
import { fileURLToPath } from "node:url";
import { row, type PluginRow } from "./rows.ts";

const PLUGIN_PATH = fileURLToPath(
  new URL("../../dsh-plugins/modal-tool.mjs", import.meta.url),
);

export function buildModalToolRow(options: {
  projectId: string;
  kadyDir: string;
  sandboxRoot: string;
}): PluginRow {
  return row("modal-tool", PLUGIN_PATH, options);
}
