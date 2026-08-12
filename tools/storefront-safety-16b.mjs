// Phase 16B — owner-approved purchase-path containment (Shopify writes).
// Sets EXACTLY two verified target sets to DRAFT status:
//   (1) the 31 legacy Stock Bags (24 old variants, no configurator-pilot tag,
//       no ERP ConfiguratorProduct row -> native purchase at placeholder
//       prices with no configurator) — kept as sellable flavor identities
//       for the 16C canonical rebuild, never deleted;
//   (2) the 8 jar-family products (native $0/$1 placeholder purchase paths;
//       hidden until the jar canonical storefront flow is built).
// SAFE BY DEFAULT: dry-run unless --execute. Target membership is verified
// per product against LIVE data (never a bare handle list); a rollback
// artifact records prior status; post-write verification re-reads Shopify.
//   node tools/storefront-safety-16b.mjs            (dry run)
//   node tools/storefront-safety-16b.mjs --execute  (perform the drafts)
//   node tools/storefront-safety-16b.mjs --rollback (restore recorded statuses)
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const ROLLBACK = process.argv.includes("--rollback");
const SHOP = "942075-2.myshopify.com";
const DATA_DIR = path.join("tools", "storefront-16b-data");
const ROLLBACK_FILE = path.join(DATA_DIR, "rollback-16b-status.json");

const JAR_HANDLES = [
  "3oz-jar", "4oz-jar", "miron-jars", "150ml-miron-jars",
  "100ml-tall-miron-jars", "100ml-wide-miron-jars", "50mml-miron-jars", "250ml-miron-jars",
];

const db = new PrismaClient();

async function gql(token, query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 400));
  return json.data;
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const session = await db.session.findFirst({ where: { shop: SHOP }, orderBy: { id: "asc" } });
  const erpHandles = new Set(
    (await db.configuratorProduct.findMany({ where: { active: true }, select: { shopifyHandle: true } })).map((p) => p.shopifyHandle),
  );
  const token = session.accessToken;

  if (ROLLBACK) {
    if (!existsSync(ROLLBACK_FILE)) throw new Error("No rollback artifact found.");
    const saved = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
    for (const item of saved.products) {
      const result = await gql(token, `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id status } userErrors { field message } } }`, { p: { id: item.id, status: item.previousStatus } });
      const errors = result.productUpdate.userErrors;
      console.log(`${errors.length ? "FAIL" : "restored"} ${item.handle} -> ${item.previousStatus}${errors.length ? " " + JSON.stringify(errors) : ""}`);
    }
    return;
  }

  // Build + VERIFY both target sets from live data.
  let cursor = null;
  const legacy = [];
  const jars = [];
  const unexpected = [];
  do {
    const data = await gql(token, `query($c: String) { products(first: 100, after: $c) { pageInfo { hasNextPage endCursor }
      nodes { id handle title status productType tags variantsCount { count } } } }`, { c: cursor });
    for (const p of data.products.nodes) {
      const isLegacyBag =
        p.productType === "Stock Bag" &&
        !p.tags.includes("configurator-pilot") &&
        (p.variantsCount?.count ?? 0) > 1 &&
        !erpHandles.has(p.handle);
      if (isLegacyBag) legacy.push(p);
      if (JAR_HANDLES.includes(p.handle)) {
        if (p.productType === "Stock Bag") unexpected.push(`${p.handle} is typed Stock Bag — refusing`);
        else jars.push(p);
      }
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`legacy stock bags matching ALL safety criteria: ${legacy.length}`);
  console.log(`jar products matched: ${jars.length} of ${JAR_HANDLES.length}`);
  if (unexpected.length) throw new Error("Unexpected targets: " + unexpected.join("; "));
  if (legacy.length !== 31) throw new Error(`Expected exactly 31 legacy bags, found ${legacy.length} — STOP for review.`);
  if (jars.length !== JAR_HANDLES.length) throw new Error(`Expected ${JAR_HANDLES.length} jar products, found ${jars.length} — STOP for review.`);

  const targets = [...legacy, ...jars];
  for (const p of targets) console.log(`${EXECUTE ? "DRAFT" : "[dry] would draft"} ${p.handle} (${p.status}, ${p.variantsCount.count} variants) "${p.title.slice(0, 40)}"`);

  if (!EXECUTE) {
    console.log(`\nDRY RUN ONLY — ${targets.length} products would move to DRAFT (${legacy.length} legacy bags + ${jars.length} jars). No writes performed.`);
    return;
  }

  writeFileSync(ROLLBACK_FILE, JSON.stringify({ savedAt: new Date().toISOString(), products: targets.map((p) => ({ id: p.id, handle: p.handle, previousStatus: p.status })) }, null, 1));
  let drafted = 0;
  for (const p of targets) {
    const result = await gql(token, `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id status } userErrors { field message } } }`, { p: { id: p.id, status: "DRAFT" } });
    const errors = result.productUpdate.userErrors;
    if (errors.length) { console.log(`FAIL ${p.handle}: ${JSON.stringify(errors)}`); continue; }
    if (result.productUpdate.product.status !== "DRAFT") { console.log(`VERIFY FAIL ${p.handle}`); continue; }
    drafted += 1;
  }
  console.log(`\nDRAFTED: ${drafted}/${targets.length} | rollback artifact: ${ROLLBACK_FILE}`);
}

main()
  .catch((error) => { console.error("ERROR:", error.message || error); process.exit(1); })
  .finally(() => db.$disconnect());
