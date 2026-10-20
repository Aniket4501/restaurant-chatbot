import { bind } from "@/lib/api/deps";
import { testResetHandler } from "@/lib/api/test-reset";

// The folder is "%5F_test" because Next.js treats "_" folders as private; this serves /api/__test/reset.
export const dynamic = "force-dynamic";
export const POST = bind(testResetHandler);
