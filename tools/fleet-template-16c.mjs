// Phase 16C — close the fleet-wide native purchase leak on canonical Stock Bags.
// Part C verification proved that bags with templateSuffix=null render the theme's
// DEFAULT product template: native add-to-cart + dynamic checkout at the $1.00
// placeholder variant price, no configurator, no lockout. Only products on the
// "configurator-pilot" suffix template (ritz-vanilla-cupcake + the 31 rebuilt in
// 16C Part B) render the canonical configurator with the purchase-path lockout.
// This tool flips every verified canonical bag to that proven template.
//
//   node tools/fleet-template-16c.mjs             read-only audit + dry run
//   node tools/fleet-template-16c.mjs --execute   set templateSuffix on all targets
//   node tools/fleet-template-16c.mjs --rollback  restore recorded previous suffixes
//
// Target membership is verified per product against LIVE data: ACTIVE Stock Bag,
// configurator-pilot tag, exactly 1 variant, ERP-linked, templateSuffix null.
// Rollback artifact records each product's previous suffix (null) before writes.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const ROLLBACK = process.argv.includes("--rollback");
const SHOP = "942075-2.myshopify.com";
const TARGET_SUFFIX = "configurator-pilot";
const DATA_DIR = path.join("tools", "rebuild-16c-data");
const ROLLBACK_FILE = path.join(DATA_DIR, "rollback-16c-template-suffix.json");

const db = new PrismaClient();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const token = session.accessToken;

  if (ROLLBACK) {
    if (!existsSync(ROLLBACK_FILE)) throw new Error("No rollback artifact found.");
    const saved = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
    let restored = 0;
    for (const item of saved.products) {
      const result = await gql(token, `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id templateSuffix } userErrors { field message } } }`, { p: { id: item.id, templateSuffix: item.previousTemplateSuffix } });
      const errors = result.productUpdate.userErrors;
      if (errors.length) console.log(`FAIL ${item.handle}: ${JSON.stringify(errors)}`);
      else restored += 1;
      await sleep(120);
    }
    console.log(`restored ${restored}/${saved.products.length} template suffixes`);
    return;
  }

  const erpHandles = new Set(
    (await db.configuratorProduct.findMany({ where: { shop: SHOP, productType: "stock_bag_4x5", active: true }, select: { shopifyHandle: true } })).map((row) => row.shopifyHandle),
  );
  console.log(`ERP active stock_bag_4x5 rows: ${erpHandles.size}`);

  let cursor = null;
  const targets = [];
  let alreadySet = 0;
  const excluded = [];
  do {
    const data = await gql(
      token,
      `query($c: String) { products(first: 100, after: $c, query: "product_type:'Stock Bag'") { pageInfo { hasNextPage endCursor }
        nodes { id handle status productType tags templateSuffix variantsCount { count } } } }`,
      { c: cursor },
    );
    for (const product of data.products.nodes) {
      if (product.templateSuffix === TARGET_SUFFIX) { alreadySet += 1; continue; }
      const eligible =
        product.status === "ACTIVE" &&
        product.tags.includes("configurator-pilot") &&
        (product.variantsCount?.count ?? 0) === 1 &&
        erpHandles.has(product.handle) &&
        (product.templateSuffix ?? null) === null;
      if (eligible) targets.push(product);
      else excluded.push(`${product.handle}: status=${product.status} tag=${product.tags.includes("configurator-pilot")} variants=${product.variantsCount?.count} erp=${erpHandles.has(product.handle)} tmpl=${product.templateSuffix}`);
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  console.log(`already on ${TARGET_SUFFIX}: ${alreadySet} | eligible to flip: ${targets.length} | excluded: ${excluded.length}`);
  if (excluded.length) console.log("  excluded detail:", excluded.slice(0, 10).join(" | "));
  const expected = erpHandles.size - alreadySet;
  if (targets.length !== expected) {
    throw new Error(`Eligible count ${targets.length} != expected ${expected} (ERP ${erpHandles.size} - already ${alreadySet}) — STOP for review.`);
  }
  if (excluded.length) throw new Error("Excluded Stock Bag products exist — STOP for review (fleet should be uniform).");

  if (!EXECUTE) {
    console.log(`\nDRY RUN ONLY — ${targets.length} products would get templateSuffix "${TARGET_SUFFIX}". No writes performed.`);
    console.log(`sample: ${targets.slice(0, 5).map((p) => p.handle).join(", ")}`);
    return;
  }

  // Merge into any existing artifact so multi-pass execution (10-minute shell
  // windows) never drops earlier entries' rollback coverage.
  let artifact = { savedAt: new Date().toISOString(), targetSuffix: TARGET_SUFFIX, products: [] };
  if (existsSync(ROLLBACK_FILE)) artifact = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
  const known = new Set(artifact.products.map((p) => p.id));
  for (const p of targets) {
    if (!known.has(p.id)) artifact.products.push({ id: p.id, handle: p.handle, previousTemplateSuffix: p.templateSuffix ?? null });
  }
  artifact.savedAt = new Date().toISOString();
  writeFileSync(ROLLBACK_FILE, JSON.stringify(artifact, null, 1));
  let flipped = 0;
  const failures = [];
  for (const product of targets) {
    const result = await gql(token, `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id templateSuffix } userErrors { field message } } }`, { p: { id: product.id, templateSuffix: TARGET_SUFFIX } });
    const errors = result.productUpdate.userErrors;
    if (errors.length || result.productUpdate.product.templateSuffix !== TARGET_SUFFIX) {
      failures.push(product.handle);
      console.log(`FAIL ${product.handle}: ${JSON.stringify(errors).slice(0, 200)}`);
    } else {
      flipped += 1;
      if (flipped % 200 === 0) console.log(`  ...${flipped}/${targets.length}`);
    }
    await sleep(60);
  }
  console.log(`\nFLIPPED: ${flipped}/${targets.length} | failures: ${failures.length} | rollback artifact: ${ROLLBACK_FILE}`);
  if (failures.length) {
    console.log("FAILED handles:", failures.slice(0, 20).join(", "));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => { console.error("ERROR:", error.message || error); process.exit(1); })
  .finally(() => db.$disconnect());
