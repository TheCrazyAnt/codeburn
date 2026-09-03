import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach } from "vitest";

// Every test starts from an empty database with the schema from ./migrations
// applied. `reset()` wipes all binding storage (the local D1 database included),
// so the migrations are re-applied afterwards.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
