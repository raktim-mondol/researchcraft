/**
 * Minimal Runpod REST client for ephemeral pod jobs.
 *
 * Uses REST v1 (`https://rest.runpod.io/v1`) with `Authorization: Bearer <key>`.
 * Pods are created with an injected PUBLIC_KEY so we can SSH + SFTP without a
 * pre-registered account key (mirrors the agentic pod workflow in runpod skills).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";

const REST_BASE = process.env.RUNPOD_REST_API_URL ?? "https://rest.runpod.io/v1";

export interface RunpodPodPort {
  ip?: string;
  isIpPublic?: boolean;
  privatePort?: number;
  publicPort?: number;
  type?: string;
}

export interface RunpodPod {
  id: string;
  name?: string;
  desiredStatus?: string;
  imageName?: string;
  runtime?: {
    uptimeInSeconds?: number;
    ports?: RunpodPodPort[];
  } | null;
  machine?: { podHostId?: string } | null;
}

export interface SshEndpoint {
  host: string;
  port: number;
  /** "tcp" = direct public IP; "proxy" = *.proxy.runpod.net style. */
  kind: "tcp" | "proxy";
}

export interface EphemeralKeyPair {
  privateKeyPath: string;
  publicKeyOpenSsh: string;
  cleanup: () => void;
}

function apiKey(): string {
  const key = process.env.RUNPOD_API_KEY?.trim();
  if (!key) throw new Error("RUNPOD_API_KEY is not set");
  return key;
}

async function request<T>(
  method: string,
  relPath: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${REST_BASE}${relPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data && "error" in data
        ? String((data as { error: unknown }).error)
        : typeof data === "object" && data && "message" in data
          ? String((data as { message: unknown }).message)
          : text || res.statusText;
    throw new Error(`Runpod API ${method} ${relPath} → ${res.status}: ${msg}`);
  }
  return data as T;
}

export async function createPod(body: Record<string, unknown>): Promise<RunpodPod> {
  return request<RunpodPod>("POST", "/pods", body);
}

export async function getPod(podId: string): Promise<RunpodPod> {
  return request<RunpodPod>("GET", `/pods/${encodeURIComponent(podId)}`);
}

export async function deletePod(podId: string): Promise<void> {
  await request<unknown>("DELETE", `/pods/${encodeURIComponent(podId)}`);
}

/** Generate an ephemeral OpenSSH ed25519 key pair in a temp dir. */
export function makeEphemeralSshKey(): EphemeralKeyPair {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-runpod-ssh-"));
  const privateKeyPath = path.join(dir, "id_ed25519");

  // Prefer ssh-keygen (emits native OpenSSH keys that ssh/scp accept).
  try {
    runSync("ssh-keygen", [
      "-t",
      "ed25519",
      "-f",
      privateKeyPath,
      "-N",
      "",
      "-C",
      "researchcraft-ephemeral",
      "-q",
    ]);
    const publicKeyOpenSsh = fs.readFileSync(`${privateKeyPath}.pub`, "utf8").trim();
    if (!publicKeyOpenSsh.startsWith("ssh-")) {
      throw new Error("ssh-keygen produced an unexpected public key format");
    }
    return {
      privateKeyPath,
      publicKeyOpenSsh,
      cleanup: () => {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      },
    };
  } catch (primaryErr) {
    // Fallback: Node crypto PEM + ssh-keygen -y conversion.
    try {
      const { privateKey } = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
      let publicKeyOpenSsh = runSync("ssh-keygen", ["-y", "-f", privateKeyPath]).trim();
      if (!publicKeyOpenSsh.startsWith("ssh-")) {
        throw new Error("ssh-keygen -y did not produce an OpenSSH public key");
      }
      publicKeyOpenSsh = `${publicKeyOpenSsh} researchcraft-ephemeral`;
      fs.writeFileSync(`${privateKeyPath}.pub`, `${publicKeyOpenSsh}\n`, { mode: 0o644 });
      return {
        privateKeyPath,
        publicKeyOpenSsh,
        cleanup: () => {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        },
      };
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      const detail = (primaryErr as Error).message ?? String(primaryErr);
      throw new Error(
        "ssh-keygen is required to provision ephemeral SSH keys for Runpod pods. " +
          "Install OpenSSH client tools and retry. " +
          `(${detail})`,
      );
    }
  }
}

function runSync(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} failed: ${(r.stderr || r.stdout || "").trim()}`);
  }
  return r.stdout;
}

/** Resolve an SSH endpoint from a pod's runtime ports, with proxy fallback. */
export function resolveSshEndpoint(pod: RunpodPod): SshEndpoint | null {
  const ports = pod.runtime?.ports ?? [];
  const tcp22 = ports.find(
    (p) =>
      (p.privatePort === 22 || p.type === "tcp") &&
      p.publicPort &&
      p.ip,
  );
  // Prefer a public TCP mapping for port 22.
  const sshPort = ports.find((p) => p.privatePort === 22 && p.publicPort && p.ip);
  if (sshPort?.ip && sshPort.publicPort) {
    return { host: sshPort.ip, port: sshPort.publicPort, kind: "tcp" };
  }
  if (tcp22?.ip && tcp22.publicPort) {
    return { host: tcp22.ip, port: tcp22.publicPort, kind: "tcp" };
  }
  // Runpod SSH proxy host form used when direct TCP isn't ready yet.
  if (pod.id) {
    return {
      host: `${pod.id}-22.port.proxy.runpod.net`,
      port: 22,
      kind: "proxy",
    };
  }
  return null;
}

/** Poll until the pod is RUNNING and an SSH endpoint is usable (or timeout). */
export async function waitForPodSsh(
  podId: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ pod: RunpodPod; ssh: SshEndpoint }> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastStatus = "";
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("Aborted while waiting for Runpod pod");
    const pod = await getPod(podId);
    lastStatus = pod.desiredStatus ?? "";
    if (lastStatus === "EXITED" || lastStatus === "TERMINATED") {
      throw new Error(`Pod ${podId} entered terminal status ${lastStatus}`);
    }
    if (lastStatus === "RUNNING") {
      const ssh = resolveSshEndpoint(pod);
      if (ssh) {
        // Probe SSH readiness with a short BatchMode connect.
        const ready = await probeSsh(ssh, opts.signal);
        if (ready) return { pod, ssh };
      }
    }
    await sleep(3000, opts.signal);
  }
  throw new Error(
    `Timed out waiting for pod ${podId} SSH (last status: ${lastStatus || "unknown"})`,
  );
}

async function probeSsh(ssh: SshEndpoint, signal?: AbortSignal): Promise<boolean> {
  // Without a key we can't fully probe; readiness is checked later with the real key.
  // Here we only require the endpoint object to exist after RUNNING.
  void ssh;
  void signal;
  return true;
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface SshRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function sshBaseArgs(keyPath: string, ssh: SshEndpoint): string[] {
  return [
    "-i",
    keyPath,
    "-p",
    String(ssh.port),
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
  ];
}

/** Run a remote command over SSH as root. Retries briefly while sshd starts. */
export async function sshExec(
  keyPath: string,
  ssh: SshEndpoint,
  command: string,
  opts: { timeoutMs: number; signal?: AbortSignal; retries?: number } = {
    timeoutMs: 600_000,
  },
): Promise<SshRunResult> {
  const retries = opts.retries ?? 12;
  let lastErr = "";
  for (let attempt = 0; attempt < retries; attempt++) {
    if (opts.signal?.aborted) throw new Error("Aborted");
    try {
      return await sshExecOnce(keyPath, ssh, command, opts);
    } catch (err) {
      lastErr = (err as Error).message ?? String(err);
      // Connection refused / timeout while sshd boots — retry.
      if (
        /Connection refused|Connection timed out|Connection reset|No route to host|Connection closed/i.test(
          lastErr,
        ) &&
        attempt < retries - 1
      ) {
        await sleep(4000, opts.signal);
        continue;
      }
      throw err;
    }
  }
  throw new Error(lastErr || "SSH exec failed");
}

function sshExecOnce(
  keyPath: string,
  ssh: SshEndpoint,
  command: string,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<SshRunResult> {
  return new Promise((resolve, reject) => {
    const args = [
      ...sshBaseArgs(keyPath, ssh),
      `root@${ssh.host}`,
      command,
    ];
    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new Error("Aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`SSH command timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      // ssh prints host-key warnings on stderr even on success; keep them.
      if (code === 255 && /Permission denied|Connection refused|timed out/i.test(stderr + stdout)) {
        reject(new Error((stderr || stdout || "SSH failed").trim()));
        return;
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

/** Upload a local file or directory to the remote path via scp. */
export async function scpUpload(
  keyPath: string,
  ssh: SshEndpoint,
  localPath: string,
  remotePath: string,
  opts: { signal?: AbortSignal; recursive?: boolean } = {},
): Promise<void> {
  const recursive =
    opts.recursive ??
    (() => {
      try {
        return fs.statSync(localPath).isDirectory();
      } catch {
        return false;
      }
    })();
  await scpOnce(keyPath, ssh, localPath, `root@${ssh.host}:${remotePath}`, {
    ...opts,
    recursive,
  });
}

/** Download a remote file to a local path via scp. */
export async function scpDownload(
  keyPath: string,
  ssh: SshEndpoint,
  remotePath: string,
  localPath: string,
  opts: { signal?: AbortSignal; recursive?: boolean } = {},
): Promise<void> {
  await scpOnce(keyPath, ssh, `root@${ssh.host}:${remotePath}`, localPath, opts);
}

function scpOnce(
  keyPath: string,
  ssh: SshEndpoint,
  src: string,
  dest: string,
  opts: { signal?: AbortSignal; recursive?: boolean },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      ...(opts.recursive ? ["-r"] : []),
      "-i",
      keyPath,
      "-P",
      String(ssh.port),
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      src,
      dest,
    ];
    const child = spawn("scp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const onAbort = () => {
      child.kill("SIGTERM");
      reject(new Error("Aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (code === 0) resolve();
      else reject(new Error(`scp failed (${code}): ${stderr.trim() || "unknown error"}`));
    });
  });
}

/** Unique short pod name for ResearchCraft ephemeral jobs. */
export function ephemeralPodName(): string {
  return `rc-${randomBytes(4).toString("hex")}`;
}
