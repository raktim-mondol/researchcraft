import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { resolve } from "path";

function readAppVersion(): string {
  // The server package is the source of truth for the app version (it's what
  // the README badge and release tags track). Reading it here keeps the
  // frontend's update check honest — a stale fallback makes every published
  // GitHub release look "newer" and shows a false "update available" banner.
  try {
    const pkg = readFileSync(resolve(__dirname, "..", "server", "package.json"), "utf-8");
    const version = (JSON.parse(pkg) as { version?: string }).version;
    if (version) return version;
  } catch {
    // fall through to default
  }
  return "0.0.0";
}

const nextConfig: NextConfig = {
  devIndicators: false,
  env: {
    NEXT_PUBLIC_APP_VERSION: readAppVersion(),
  },
  // Do NOT set turbopack.root to the monorepo parent: CSS `@import "tailwindcss"`
  // then resolves from that directory (no node_modules) instead of web/, and
  // the build fails. The multi-lockfile warning (parent ~/pnpm-lock.yaml) is
  // noisy but harmless; leaving root unset keeps package resolution in web/.
};

export default nextConfig;
