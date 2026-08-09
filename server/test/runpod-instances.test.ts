import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUNPOD_INSTANCE_ID,
  RUNPOD_INSTANCE_IDS,
  resolveRunpodInstance,
} from "../src/agent/runpod-instances.ts";

describe("resolveRunpodInstance", () => {
  it("resolves bare ids", () => {
    const spec = resolveRunpodInstance("rtx4090");
    expect(spec?.id).toBe("rtx4090");
    expect(spec?.gpuTypeId).toBe("NVIDIA GeForce RTX 4090");
    expect(spec?.pricePerHour).toBeGreaterThan(0);
  });

  it("resolves runpod: prefixed wire ids", () => {
    const spec = resolveRunpodInstance("runpod:h100");
    expect(spec?.id).toBe("h100");
    expect(spec?.gpuTypeId).toContain("H100");
  });

  it("returns null for unknown / local", () => {
    expect(resolveRunpodInstance("local")).toBeNull();
    expect(resolveRunpodInstance("modal:h100")).toBeNull();
    expect(resolveRunpodInstance(null)).toBeNull();
    expect(resolveRunpodInstance(undefined)).toBeNull();
  });

  it("exports a non-empty catalog with a default", () => {
    expect(RUNPOD_INSTANCE_IDS.length).toBeGreaterThan(0);
    expect(RUNPOD_INSTANCE_IDS).toContain(DEFAULT_RUNPOD_INSTANCE_ID);
    expect(resolveRunpodInstance(DEFAULT_RUNPOD_INSTANCE_ID)).not.toBeNull();
  });

  it("CPU instance has no GPU type", () => {
    const cpu = resolveRunpodInstance("cpu");
    expect(cpu?.gpuTypeId).toBeNull();
    expect(cpu?.gpuCount).toBe(0);
  });
});
