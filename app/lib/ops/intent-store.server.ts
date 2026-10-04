// Process-wide OPS repositories (OPS-2). Selected by GSO_OPS_REPOSITORY:
//   memory (default) — non-durable, safe before the OPS-2 migration exists
//   prisma           — durable; requires the OPS-2 migration to be APPLIED by
//                      the owner first (tables OpsActionIntent etc.)
// Business code never imports Prisma directly; it receives OpsRepositories.

import { createMemoryRepositories } from "./memory-repositories";
import { createPrismaRepositories } from "./prisma-repositories.server";
import { readOpsRuntimeConfig } from "./runtime-config";
import type { OpsRepositories } from "./repositories";

const globalRef = globalThis as unknown as { __gsoOpsRepositories?: OpsRepositories };

/**
 * Importing prisma-repositories.server has NO database side effect: it only
 * references the shared Prisma client; the Ops* tables are queried solely
 * inside repository methods, which run only when GSO_OPS_REPOSITORY=prisma.
 * (Release gate 2026-10-04: a CommonJS `require` here was unresolvable in the
 * ESM server bundle and would have thrown the moment prisma mode was enabled.)
 */
export function getOpsRepositories(): OpsRepositories {
  if (globalRef.__gsoOpsRepositories) return globalRef.__gsoOpsRepositories;
  const config = readOpsRuntimeConfig();
  if (config.repository === "prisma") {
    globalRef.__gsoOpsRepositories = createPrismaRepositories();
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
