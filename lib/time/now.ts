import { getConfig, type AppConfig } from "@/lib/config";

/**
 * The only place app code reads the clock (D-12). Route handlers, Server Components and the admin default
 * date all call this; booking logic receives `now` as a parameter and never calls it.
 * NOW_OVERRIDE is honoured only in test mode.
 */
export function getNow(config: AppConfig = getConfig()): number {
  return config.test?.nowOverrideMs ?? Date.now();
}
