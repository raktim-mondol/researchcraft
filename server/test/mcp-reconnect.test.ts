/**
 * Regression tests for the MCP reconnect-on-call behaviour.
 *
 * Remote streamable-HTTP MCP servers (Firecrawl, Parallel, Scite, Consensus)
 * expire idle sessions; the SDK then closes the transport and every callTool
 * throws `Not connected`. Wrapped tools must re-dial once and retry instead
 * of surfacing that error to the model forever.
 */
import { describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isMcpConnectionError, wrapTool } from "../src/agent/mcp.ts";

function fakeClient(failures: number): { client: Client; calls: () => number } {
  let calls = 0;
  let remainingFailures = failures;
  const client = {
    callTool: async () => {
      calls += 1;
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("Not connected");
      }
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
  } as unknown as Client;
  return { client, calls: () => calls };
}

const TOOL = { name: "search", inputSchema: { type: "object", properties: {} } };

describe("isMcpConnectionError", () => {
  it("matches SDK connection-level failures", () => {
    expect(isMcpConnectionError(new Error("Not connected"))).toBe(true);
    expect(isMcpConnectionError(new Error("connection is closed"))).toBe(true);
    expect(isMcpConnectionError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("does not match tool-level errors", () => {
    expect(isMcpConnectionError(new Error("Invalid API key"))).toBe(false);
    expect(isMcpConnectionError(new Error("rate limit exceeded"))).toBe(false);
  });
});

describe("wrapTool reconnect behaviour", () => {
  it("returns content on a healthy connection without reconnecting", async () => {
    const { client, calls } = fakeClient(0);
    let reconnects = 0;
    const tool = wrapTool("srv", client, TOOL, async () => {
      reconnects += 1;
      return client;
    });
    const res = await tool.execute!("id", {}, undefined as never);
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(calls()).toBe(1);
    expect(reconnects).toBe(0);
  });

  it("reconnects once and retries after a dropped remote session", async () => {
    const dead = fakeClient(99); // always fails
    const fresh = fakeClient(0); // healthy replacement
    let reconnects = 0;
    const tool = wrapTool("srv", dead.client, TOOL, async () => {
      reconnects += 1;
      return fresh.client;
    });
    const res = await tool.execute!("id", {}, undefined as never);
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(reconnects).toBe(1);
  });

  it("keeps using the reconnected client for later calls", async () => {
    const dead = fakeClient(99);
    const fresh = fakeClient(0);
    const tool = wrapTool("srv", dead.client, TOOL, async () => fresh.client);
    await tool.execute!("id", {}, undefined as never);
    const res = await tool.execute!("id", {}, undefined as never);
    expect(res.content).toEqual([{ type: "text", text: "ok" }]);
    expect(fresh.calls()).toBe(2); // both post-reconnect calls hit the fresh client
  });

  it("rethrows connection errors when no reconnect hook exists", async () => {
    const dead = fakeClient(99);
    const tool = wrapTool("srv", dead.client, TOOL);
    await expect(tool.execute!("id", {}, undefined as never)).rejects.toThrow(
      "Not connected",
    );
  });

  it("does not retry on tool-level errors", async () => {
    let calls = 0;
    const client = {
      callTool: async () => {
        calls += 1;
        throw new Error("Invalid API key");
      },
    } as unknown as Client;
    let reconnects = 0;
    const tool = wrapTool("srv", client, TOOL, async () => {
      reconnects += 1;
      return client;
    });
    await expect(tool.execute!("id", {}, undefined as never)).rejects.toThrow(
      "Invalid API key",
    );
    expect(calls).toBe(1);
    expect(reconnects).toBe(0);
  });
});
