// Next.js calls register() once when the server starts. The Node server keeps the local model warm (lib/llm/warmer.ts, D-23).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWarmer } = await import("@/lib/llm/warmer");
  startWarmer();
}
