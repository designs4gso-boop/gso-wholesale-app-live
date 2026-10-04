// Process-wide ActionIntent store. NOT DURABLE: it lives for the life of one
// Node process. Good enough for local development, the simulator and the
// sandbox Slack loop; a Prisma-backed store is the documented deployment
// requirement (docs/GSO_AGENT_DEPLOYMENT_PLAN.md) before any agent action is
// allowed to matter in production.

import { InMemoryActionIntentStore, type ActionIntentStore } from "./action-intents";

const globalRef = globalThis as unknown as { __gsoIntentStore?: ActionIntentStore };

export function getIntentStore(): ActionIntentStore {
  if (!globalRef.__gsoIntentStore) globalRef.__gsoIntentStore = new InMemoryActionIntentStore();
  return globalRef.__gsoIntentStore;
}

export const INTENT_STORE_DURABILITY = "in-memory (non-durable) — Prisma store required before production use" as const;
