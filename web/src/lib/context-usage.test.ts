import { describe, expect, it } from "vitest";

import {
  contextPressure,
  contextRatio,
  parseContextUsage,
} from "@/lib/context-usage";

describe("context-usage", () => {
  it("parses a valid payload", () => {
    expect(
      parseContextUsage({ tokens: 40_000, contextWindow: 128_000, percent: 31.25 }),
    ).toEqual({ tokens: 40_000, contextWindow: 128_000, percent: 31.25 });
  });

  it("rejects missing window", () => {
    expect(parseContextUsage({ tokens: 1, contextWindow: 0 })).toBeNull();
    expect(parseContextUsage(null)).toBeNull();
  });

  it("computes pressure bands", () => {
    expect(
      contextPressure({ tokens: 10_000, contextWindow: 100_000, percent: 10 }),
    ).toBe("ok");
    expect(
      contextPressure({ tokens: 75_000, contextWindow: 100_000, percent: 75 }),
    ).toBe("warn");
    expect(
      contextPressure({ tokens: 90_000, contextWindow: 100_000, percent: 90 }),
    ).toBe("critical");
    expect(
      contextPressure({ tokens: null, contextWindow: 100_000, percent: null }),
    ).toBe("unknown");
  });

  it("derives ratio from tokens when percent missing", () => {
    expect(
      contextRatio({ tokens: 50_000, contextWindow: 100_000, percent: null }),
    ).toBe(0.5);
  });
});
