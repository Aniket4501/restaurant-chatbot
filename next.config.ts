import type { NextConfig } from "next";

// D-07: no Next-managed AGENTS.md and no agent-triggered upgrades, so gate runs are deterministic.
// Tailwind runs through @tailwindcss/postcss (postcss.config.mjs), not the scaffold's turbopack CSS loader.
// The dev server's request log prints each URL with its query; the staff bookings search sends the guest's name there,
// so those requests aren't logged (failure-mode audit FM-053).
export const UNLOGGED_REQUESTS = [/\/api\/admin\/reservations\?/];

const nextConfig: NextConfig = {
  agentRules: false,
  experimental: {
    agentUpgrade: false,
  },
  logging: { incomingRequests: { ignore: UNLOGGED_REQUESTS } },
};

export default nextConfig;
