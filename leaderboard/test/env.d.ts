import type { D1Migration } from "cloudflare:test";
import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Parsed migrations/*.sql, injected by vitest.config.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
