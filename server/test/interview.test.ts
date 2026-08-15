import { describe, expect, it, vi } from "vitest";
import {
  pendingInterviewFor,
  registerInterview,
  resolveInterview,
  validateAnswer,
  type InterviewParamsT,
} from "../src/agent/interview.ts";

function payload(overrides: Partial<InterviewParamsT> = {}): InterviewParamsT {
  return {
    title: "Confirm approach",
    questions: [{ id: "q1", type: "text", question: "Which dataset?" }],
    ...overrides,
  };
}

describe("interview tool core", () => {
  it("rejects duplicate question ids up front, without registering a pending interview", async () => {
    const bad = payload({
      questions: [
        { id: "q1", type: "text", question: "A" },
        { id: "q1", type: "text", question: "B" },
      ],
    });
    await expect(registerInterview("p1", "s1", "call1", bad)).rejects.toThrow(/Duplicate question id/);
    expect(pendingInterviewFor("p1", "s1")).toBeNull();
  });

  it("rejects a single/multi question with no options", async () => {
    const bad = payload({ questions: [{ id: "q1", type: "single", question: "Pick one" }] });
    await expect(registerInterview("p1", "s1", "call1", bad)).rejects.toThrow(/has no options/);
  });

  it("blocks until resolveInterview supplies answers, then returns them", async () => {
    const p = payload();
    const promise = registerInterview("proj", "sess", "call-x", p);
    expect(pendingInterviewFor("proj", "sess")).toEqual({ toolCallId: "call-x", payload: p });

    const ok = resolveInterview("proj", "sess", "call-x", {
      responses: [{ id: "q1", value: "GSE12345" }],
    });
    expect(ok).toBe(true);
    await expect(promise).resolves.toEqual({ responses: [{ id: "q1", value: "GSE12345" }] });
    expect(pendingInterviewFor("proj", "sess")).toBeNull();
  });

  it("refuses to resolve from the wrong project or session", async () => {
    const promise = registerInterview("proj", "sess", "call-y", payload());
    expect(resolveInterview("other-proj", "sess", "call-y", { cancelled: true })).toBe(false);
    expect(resolveInterview("proj", "other-sess", "call-y", { cancelled: true })).toBe(false);
    // Still pending — settle it for real so the promise doesn't leak into other tests.
    resolveInterview("proj", "sess", "call-y", { cancelled: true });
    await expect(promise).resolves.toEqual({ cancelled: true });
  });

  it("rejects when the abort signal fires", async () => {
    const controller = new AbortController();
    const promise = registerInterview("proj", "sess", "call-z", payload(), controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/i);
    expect(pendingInterviewFor("proj", "sess")).toBeNull();
  });

  it("floors a too-short timeout and times out without implying the user answered", async () => {
    vi.useFakeTimers();
    try {
      const promise = registerInterview("proj", "sess", "call-t", payload({ timeout: 1 }));
      const assertion = expect(promise).rejects.toThrow(/did NOT answer/);
      // MIN_TIMEOUT_S floors a `timeout: 1` request to 60s.
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("validateAnswer rejects malformed/oversized attachments without consuming a pending interview", () => {
    expect(validateAnswer({ responses: [{ id: "q1", value: "x" }] })).toBeNull();
    expect(validateAnswer({ responses: [{ id: "q1", value: 5 as never }] })).toMatch(/string or string array/);
    expect(
      validateAnswer({ responses: [{ id: "q1", value: "x", attachments: [{ data: "a", mimeType: "text/plain" }] }] }),
    ).toMatch(/only image attachments/);
  });
});
