// Phase 16C Part F — contain the 4 miscellaneous ACTIVE products that predate
// the canonical architecture. All four have EMPTY productType, so neither the
// Stock Bag lockout nor any configurator applies: they are natively purchasable
// at legacy placeholder prices today. Classification (16C):
//   4x5-custom-pouch   -> CANONICAL PRODUCT BASE for the future DTP pouch family (hide until built)
//   4x5-sticker-bag    -> REPLACE: superseded by the canonical Stock Bag fleet
//                         (210-variant native matrix must never be sellable again)
//   14x16-sticker-bag  -> CANONICAL PRODUCT BASE for a future large-format size (hide until built)
//   4x5-box            -> CANONICAL PRODUCT BASE for the future Boxes family (hide until built)
// None are deleted — DRAFT only, with a rollback artifact, mirroring 16B.
//   node tools/misc-containment-16c.mjs             dry run
//   node tools/misc-containment-16c.mjs --execute   draft the verified targets
//   node tools/misc-containment-16c.mjs --rollback  restore recorded statuses
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const ROLLBACK = process.argv.includes("--rollback");
const SHOP = "942075-2.myshopify.com";
const DATA_DIR = path.join("tools", "rebuild-16c-data");
const ROLLBACK_FILE = path.join(DATA_DIR, "rollback-16c-misc-status.json");

const TARGET_HANDLES = ["4x5-custom-pouch", "4x5-sticker-bag", "14x16-sticker-bag", "4x5-box"];

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

  const erpGids = new Set(
    (await db.configuratorProduct.findMany({ where: { shop: SHOP }, select: { shopifyProductGid: true } })).map((row) => row.shopifyProductGid).filter(Boolean),
  );

  const targets = [];
  for (const handle of TARGET_HANDLES) {
    const data = await gql(token, `query($h: String!) { productByIdentifier(identifier: { handle: $h }) { id handle title status productType tags variantsCount { count } } }`, { h: handle });
    const product = data.productByIdentifier;
    if (!product) { console.log(`MISSING ${handle} — skipping`); continue; }
    const problems = [];
    if (product.productType !== "") problems.push(`productType "${product.productType}" (expected empty legacy type)`);
    if (erpGids.has(product.id)) problems.push("linked in ERP ConfiguratorProduct");
    if (product.tags.includes("configurator-pilot")) problems.push("has configurator-pilot tag");
    if (problems.length) {
      throw new Error(`${handle}: does not match containment criteria — ${problems.join("; ")} — STOP.`);
    }
    console.log(`${EXECUTE ? "DRAFT" : "[dry] would draft"} ${handle} (${product.status}, ${product.variantsCount.count} variants) "${product.title.slice(0, 40)}"`);
    targets.push(product);
  }
  if (!targets.length) throw new Error("No targets matched.");

  if (!EXECUTE) {
    console.log(`\nDRY RUN ONLY — ${targets.length} products would move to DRAFT. No writes performed.`);
    return;
  }

  let artifact = { savedAt: new Date().toISOString(), products: [] };
  if (existsSync(ROLLBACK_FILE)) artifact = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
  const known = new Set(artifact.products.map((p) => p.id));
  for (const p of targets) {
    if (!known.has(p.id)) artifact.products.push({ id: p.id, handle: p.handle, previousStatus: p.status });
  }
  writeFileSync(ROLLBACK_FILE, JSON.stringify(artifact, null, 1));

  let drafted = 0;
  for (const product of targets) {
    if (product.status === "DRAFT") { console.log(`already DRAFT ${product.handle}`); continue; }
    const result = await gql(token, `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id status } userErrors { field message } } }`, { p: { id: product.id, status: "DRAFT" } });
    const errors = result.productUpdate.userErrors;
    if (errors.length || result.productUpdate.product.status !== "DRAFT") {
      console.log(`FAIL ${product.handle}: ${JSON.stringify(errors)}`);
      process.exitCode = 1;
      continue;
    }
    drafted += 1;
    console.log(`DRAFTED ${product.handle}`);
  }
  console.log(`\nDRAFTED: ${drafted}/${targets.length} | rollback artifact: ${ROLLBACK_FILE}`);
}

main()
  .catch((error) => { console.error("ERROR:", error.message || error); process.exit(1); })
  .finally(() => db.$disconnect());
