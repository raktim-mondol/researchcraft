import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadPersistedChatTabs,
  savePersistedChatTabs,
  sessionTabTitle,
  resolveChatTabsForProject,
} from "@/lib/chat-tabs-storage";

const PROJECT = "proj-test";

describe("chat-tabs-storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("round-trips open tabs per project", () => {
    savePersistedChatTabs(PROJECT, {
      tabs: [
        { id: "t1", title: "My analysis", sessionId: "s1" },
        { id: "t2", title: "Chat 2" },
      ],
      activeTabId: "t2",
    });
    expect(loadPersistedChatTabs(PROJECT)).toEqual({
      tabs: [
        { id: "t1", title: "My analysis", sessionId: "s1" },
        { id: "t2", title: "Chat 2" },
      ],
      activeTabId: "t2",
    });
    expect(loadPersistedChatTabs("other")).toBeNull();
  });

  it("sessionTabTitle prefers name then firstMessage", () => {
    expect(
      sessionTabTitle({
        id: "1",
        name: "  Plan  ",
        created: 0,
        modified: 0,
        messageCount: 1,
        firstMessage: "hello",
      }),
    ).toBe("Plan");
    expect(
      sessionTabTitle({
        id: "1",
        name: null,
        created: 0,
        modified: 0,
        messageCount: 1,
        firstMessage: "hello world",
      }),
    ).toBe("hello world");
  });

  function stubSessions(list: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/sessions") && !url.includes("/sessions/")) {
          return new Response(JSON.stringify(list), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
  }

  it("resolveChatTabsForProject restores remembered sessions that still exist", async () => {
    savePersistedChatTabs(PROJECT, {
      tabs: [
        { id: "t1", title: "Keep me", sessionId: "alive" },
        { id: "t2", title: "Gone", sessionId: "dead" },
      ],
      activeTabId: "t1",
    });
    stubSessions([
      {
        id: "alive",
        name: null,
        firstMessage: "from server",
        messageCount: 3,
        created: 1,
        modified: 100,
      },
    ]);
    const resolved = await resolveChatTabsForProject(PROJECT, {
      maxTabs: 10,
      blankTabId: "blank",
      blankTitle: "Chat 1",
    });
    expect(resolved.tabs).toEqual([
      { id: "t1", title: "Keep me", sessionId: "alive" },
    ]);
    expect(resolved.activeTabId).toBe("t1");
  });

  it("resolveChatTabsForProject falls back to most recent session", async () => {
    stubSessions([
      {
        id: "old",
        name: null,
        firstMessage: "older",
        messageCount: 2,
        created: 1,
        modified: 10,
      },
      {
        id: "new",
        name: null,
        firstMessage: "newest chat",
        messageCount: 5,
        created: 2,
        modified: 99,
      },
    ]);
    const resolved = await resolveChatTabsForProject(PROJECT, {
      maxTabs: 10,
      blankTabId: "blank",
      blankTitle: "Chat 1",
    });
    expect(resolved.tabs).toEqual([
      { id: "blank", title: "newest chat", sessionId: "new" },
    ]);
    expect(resolved.activeTabId).toBe("blank");
  });
});
