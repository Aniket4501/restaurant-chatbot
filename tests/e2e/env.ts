// Shared E2E settings (D-12). The admin values below are test-only fixtures for the E2E servers, not secrets.
export const E2E_NOW = "2026-10-16T14:00:00+05:30"; // Fri 16 Oct 2026, 2:00 PM IST: base.json's dates are around it
export const PORTS = { main: 3100, lowLimit: 3101 } as const;
export const E2E_ADMIN = { password: "e2e-admin-password-not-secret", secret: "e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0e2e0" } as const;

export function serverFiles(port: number) {
  return { db: `test-results/e2e/app-${port}.db`, trace: `test-results/e2e/trace-${port}.jsonl`, log: `test-results/e2e/server-${port}.log` };
}
