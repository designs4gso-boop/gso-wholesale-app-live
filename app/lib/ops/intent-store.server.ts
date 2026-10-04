// Process-wide OPS repositories (OPS-2). Selected by GSO_OPS_REPOSITORY:
//   memory (default) — non-durable, safe before the OPS-2 migration exists
//   prisma           — durable; requires the OPS-2 migration to be APPLIED by
//                      the owner first (tables OpsActionIntent etc.)
// Business code never imports Prisma directly; it receives OpsRepositories.

import { createMemoryRepositories } from "./memory-repositories";
import { readOpsRuntimeConfig } from "./runtime-config";
import type { OpsRepositories } from "./repositories";

const globalRef = globalThis as unknown as { __gsoOpsRepositories?: OpsRepositories };

export function getOpsRepositories(): OpsRepositories {
  if (globalRef.__gsoOpsRepositories) return globalRef.__gsoOpsRepositories;
  const config = readOpsRuntimeConfig();
  if (config.repository === "prisma") {
    // Lazy require keeps the Prisma client out of memory-mode processes and
    // out of every test. Resolved at runtime only when explicitly configured.
    const mod = require("./prisma-repositories.server") as typeof import("./prisma-repositories.server");
    globalRef.__gsoOpsRepositories = mod.createPrismaRepositories();
  } else {
    globalRef.__gsoOpsRepositories = createMemoryRepositories();
  }
  return globalRef.__gsoOpsRepositories;
}

/** Back-compat for OPS-1 callers. */
export function getIntentStore() {
  return getOpsRepositories().intents;
}

export function describeRepositoryDurability(): string {
  const kind = getOpsRepositories().kind;
  return kind === "prisma" ? "prisma (durable; OPS-2 tables)" : "in-memory (non-durable) — set GSO_OPS_REPOSITORY=prisma after the OPS-2 migration is applied";
}
