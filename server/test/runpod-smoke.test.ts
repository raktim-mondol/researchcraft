/**
 * Smoke tests for Runpod integration without requiring a live key.
 * If RUNPOD_API_KEY is present in the environment, also probes the REST API.
 */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runpodConfigured } from "../src/config.ts";
import { resolveRunpodInstance, RUNPOD_INSTANCE_IDS } from "../src/agent/runpod-instances.ts";
import { ephemeralPodName, makeEphemeralSshKey } from "../src/agent/runpod-client.ts";

describe("runpod smoke (offline)", () => {
  it("catalog has expected flagship GPUs", () => {
    for (const id of ["cpu", "rtx4090", "h100"]) {
      expect(RUNPOD_INSTANCE_IDS).toContain(id);
      expect(resolveRunpodInstance(id)).not.toBeNull();
    }
  });

  it("ephemeral pod names are short and unique-ish", () => {
    const a = ephemeralPodName();
    const b = ephemeralPodName();
    expect(a).toMatch(/^rc-[0-9a-f]+$/);
    expect(a).not.toBe(b);
  });

  it("can mint an ephemeral OpenSSH keypair when ssh-keygen is available", () => {
    const probe = spawnSync("ssh-keygen", ["-h"], { encoding: "utf8" });
    // Missing binary → error ENOENT. Present binaries usually exit non-zero on -h.
    if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") {
      // CI / minimal hosts without OpenSSH — skip rather than fail the suite.
      return;
    }
    const keys = makeEphemeralSshKey();
    try {
      expect(keys.publicKeyOpenSsh.startsWith("ssh-")).toBe(true);
      expect(keys.publicKeyOpenSsh).toContain("researchcraft-ephemeral");
    } finally {
      keys.cleanup();
    }
  });

  it("runpodConfigured reflects RUNPOD_API_KEY", () => {
    const before = process.env.RUNPOD_API_KEY;
    try {
      delete process.env.RUNPOD_API_KEY;
      expect(runpodConfigured()).toBe(false);
      process.env.RUNPOD_API_KEY = "  test-key-not-real  ";
      expect(runpodConfigured()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.RUNPOD_API_KEY;
      else process.env.RUNPOD_API_KEY = before;
    }
  });
});

describe("runpod live API (optional)", () => {
  const key = process.env.RUNPOD_API_KEY?.trim();
  const maybe = key ? it : it.skip;

  maybe("GET /pods with configured key returns JSON", async () => {
    const base = process.env.RUNPOD_REST_API_URL ?? "https://rest.runpod.io/v1";
    const res = await fetch(`${base}/pods`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
      },
    });
    // 200 = ok; 401 = bad key (still proves network path). Fail hard only on total network death.
    expect([200, 401, 403]).toContain(res.status);
    if (res.status === 200) {
      const body = await res.json();
      expect(body === null || typeof body === "object").toBe(true);
    }
  });
});
