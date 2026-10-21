// Shared E2E settings (D-12).
export const E2E_NOW = "2026-10-16T14:00:00+05:30"; // Fri 16 Oct 2026, 2:00 PM IST: base.json's dates are around it
export const PORTS = { main: 3100, lowLimit: 3101 } as const;

export function serverFiles(port: number) {
  return { db: `test-results/e2e/app-${port}.db`, trace: `test-results/e2e/trace-${port}.jsonl`, log: `test-results/e2e/server-${port}.log`, evals: `test-results/e2e/evals-${port}`, evalsBaseline: `test-results/e2e/evals-baseline-${port}.json` };
}
