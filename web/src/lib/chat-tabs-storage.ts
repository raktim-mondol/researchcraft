/**
 * Persist which chat tabs were open (and which Pi session each is bound to)
 * so a browser reload / app restart can restore transcripts instead of a blank
 * "Chat 1" tab.
 *
 * Session bodies live on disk under projects/<id>/sandbox/.pi/sessions/ — this
 * only remembers the *tab strip* layout per project.
 */
import { apiFetch } from "@/lib/projects";

export interface PersistedChatTab {
  id: string;
  title: string;
  sessionId?: string;
}

export interface PersistedChatTabsState {
  tabs: PersistedChatTab[];
  activeTabId: string;
}

export interface SessionListItem {
  id: string;
  name: string | null;
  created: string | number;
  modified: string | number;
  messageCount: number;
  firstMessage?: string | null;
}

const keyFor = (projectId: string) => `researchcraft:chat-tabs:${projectId}`;

export function sessionTabTitle(s: SessionListItem): string {
  const raw = (s.name ?? s.firstMessage ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "Untitled chat";
  return raw.length > 60 ? raw.slice(0, 60) + "…" : raw;
}

export function loadPersistedChatTabs(
  projectId: string,
): PersistedChatTabsState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(keyFor(projectId));
    if (!raw) return null;
    const data = JSON.parse(raw) as PersistedChatTabsState;
    if (!data || !Array.isArray(data.tabs) || data.tabs.length === 0) return null;
    const tabs = data.tabs
      .filter(
        (t): t is PersistedChatTab =>
          Boolean(t) &&
          typeof t.id === "string" &&
          typeof t.title === "string",
      )
      .map((t) => ({
        id: t.id,
        title: t.title,
        ...(typeof t.sessionId === "string" && t.sessionId
          ? { sessionId: t.sessionId }
          : {}),
      }));
    if (tabs.length === 0) return null;
    const activeTabId =
      typeof data.activeTabId === "string" &&
      tabs.some((t) => t.id === data.activeTabId)
        ? data.activeTabId
        : tabs[0].id;
    return { tabs, activeTabId };
  } catch {
    return null;
  }
}

export function savePersistedChatTabs(
  projectId: string,
  state: PersistedChatTabsState,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(projectId), JSON.stringify(state));
  } catch {
    // private mode / quota — restore will fall back to most-recent session
  }
}

/** List non-empty project sessions, newest first. */
export async function fetchRecentSessions(): Promise<SessionListItem[]> {
  try {
    const res = await apiFetch("/sessions");
    if (!res.ok) return [];
    const list = (await res.json()) as SessionListItem[];
    if (!Array.isArray(list)) return [];
    return [...list]
      .filter((s) => s && typeof s.id === "string" && (s.messageCount ?? 0) > 0)
      .sort(
        (a, b) =>
          new Date(b.modified).getTime() - new Date(a.modified).getTime(),
      );
  } catch {
    return [];
  }
}

/**
 * Resolve the tab strip to show for a project after load / project switch:
 * 1. Open tabs remembered in localStorage (that still exist on disk)
 * 2. Else the single most recently modified non-empty session
 * 3. Else null (caller opens a blank tab)
 */
export async function resolveChatTabsForProject(
  projectId: string,
  opts: { maxTabs: number; blankTabId: string; blankTitle: string },
): Promise<PersistedChatTabsState> {
  const recent = await fetchRecentSessions();
  const byId = new Map(recent.map((s) => [s.id, s]));

  const stored = loadPersistedChatTabs(projectId);
  if (stored) {
    const restored: PersistedChatTab[] = [];
    for (const t of stored.tabs) {
      if (restored.length >= opts.maxTabs) break;
      if (!t.sessionId) continue;
      const s = byId.get(t.sessionId);
      if (!s) continue;
      // Prefer a human title from the session if the tab still has a default name.
      const looksDefault = /^Chat \d+$/i.test(t.title) || t.title === opts.blankTitle;
      restored.push({
        id: t.id,
        title: looksDefault ? sessionTabTitle(s) : t.title,
        sessionId: t.sessionId,
      });
    }
    if (restored.length > 0) {
      const activeTabId = restored.some((t) => t.id === stored.activeTabId)
        ? stored.activeTabId
        : restored[0].id;
      return { tabs: restored, activeTabId };
    }
  }

  if (recent.length > 0) {
    const s = recent[0];
    return {
      tabs: [
        {
          id: opts.blankTabId,
          title: sessionTabTitle(s),
          sessionId: s.id,
        },
      ],
      activeTabId: opts.blankTabId,
    };
  }

  return {
    tabs: [{ id: opts.blankTabId, title: opts.blankTitle }],
    activeTabId: opts.blankTabId,
  };
}
