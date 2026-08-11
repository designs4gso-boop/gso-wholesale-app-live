// Phase 15G.5E shared helpers — Stock Bag MOQ description cleanup.
// Owner-approved Shopify CONTENT update (descriptionHtml only). These helpers
// never build price/variant/title/handle/tag/collection mutations.
import { PrismaClient } from "@prisma/client";
import { mkdirSync } from "node:fs";
import path from "node:path";

export const SHOP = "942075-2.myshopify.com";
export const API_VERSION = "2025-10";
// Exact literals — case-sensitive, byte-for-byte. "64" -> "50" preserves length.
export const OLD_SENTENCE = "Minimum order 64 units";
export const NEW_SENTENCE = "Minimum order 50 units";
export const DATA_DIR = path.join("tools", "moq-cleanup-data");
export const ROLLBACK_FILE = path.join(DATA_DIR, "rollback-15g5e.json");
export const CHECKPOINT_FILE = path.join(DATA_DIR, "checkpoint-15g5e.json");

export function ensureDataDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

export async function getAccessToken() {
  const db = new PrismaClient();
  try {
    const session = await db.session.findFirst({ where: { shop: SHOP }, orderBy: { id: "asc" } });
    if (!session?.accessToken) throw new Error("No Shopify session/access token found for shop");
    return session.accessToken;
  } finally {
    await db.$disconnect();
  }
}

export async function shopifyGraphql(accessToken, query, variables, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let res, json;
    try {
      res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query, variables }),
      });
      json = await res.json();
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(1500 * (attempt + 1));
      continue;
    }
    const throttled = json.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < retries) {
      await sleep(2500 * (attempt + 1));
      continue;
    }
    if (!res.ok || json.errors) {
      throw new Error(`Shopify GraphQL failed (status ${res.status}): ${JSON.stringify(json.errors || json).slice(0, 400)}`);
    }
    return json.data;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function countOccurrences(haystack, needle) {
  if (!haystack) return 0;
  return haystack.split(needle).length - 1;
}

// The ONLY transformation this phase performs. split/join replaces every exact
// occurrence and cannot touch any other byte; 64 -> 50 keeps length identical.
export function replaceSentence(descriptionHtml) {
  return String(descriptionHtml).split(OLD_SENTENCE).join(NEW_SENTENCE);
}
