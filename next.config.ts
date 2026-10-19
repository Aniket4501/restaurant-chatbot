import type { NextConfig } from "next";

// D-07: no Next-managed AGENTS.md and no agent-triggered upgrades, so gate runs are deterministic.
// Tailwind runs through @tailwindcss/postcss (postcss.config.mjs), not the scaffold's turbopack CSS loader.
const nextConfig: NextConfig = {
  agentRules: false,
  experimental: {
    agentUpgrade: false,
  },
};

export default nextConfig;
