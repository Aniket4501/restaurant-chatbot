// Next.js calls register() once when the server starts. The Node server keeps the local model warm (lib/llm/warmer.ts,
// D-23), and resumes a knowledge-index refresh that a restart interrupted or that last failed (failure-mode audit FM-020).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWarmer } = await import("@/lib/llm/warmer");
  startWarmer();
  const { getConfig } = await import("@/lib/config");
  if (getConfig().testMode) return;
  try {
    const { defaultDeps, refresherOf } = await import("@/lib/api/deps");
    const { resumeRefresh } = await import("@/lib/kb/refresh");
    const deps = defaultDeps();
    resumeRefresh(deps.db(), refresherOf(deps));
  } catch (e) {
    // A database that can't be opened yet is reported by /api/health; the server still starts.
    console.warn(JSON.stringify({ event: "kb_refresh_resume_skipped", error: e instanceof Error ? e.name : "unknown" }));
  }
}
