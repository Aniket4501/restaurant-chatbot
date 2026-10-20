import { errorResponse, okResponse } from "@/lib/http/json";
import { resetTestDatabase } from "@/lib/testing/reset";
import type { ApiDeps } from "@/lib/api/deps";

/** POST /api/__test/reset: 404 unless E2E_TEST_MODE=1 (D-12). Fresh fixture database, cleared limits and trace. */
export function testResetHandler(deps: ApiDeps) {
  return async (): Promise<Response> => {
    const config = deps.config();
    if (!config.testMode) return errorResponse(404, "NOT_FOUND", "Not found.");
    const now = deps.now();
    const r = await resetTestDatabase(config, now);
    deps.limits.adminLogin.reset();
    deps.limits.createsGlobal.reset();
    deps.limits.createsPerPhone.reset();
    deps.chat.limiter.reset?.();
    return okResponse(200, { ok: true, now, facts: r.facts });
  };
}
