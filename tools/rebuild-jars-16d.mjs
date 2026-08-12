// Phase 16D — canonicalize the Miron applied-label launch jars (100ml tall,
// 100ml wide, 150ml) to the single-purchase-path architecture:
//   - collapse the native 30-variant Material/Label/Spot-Gloss matrix to ONE
//     "Default Title" variant @ 1.00 / CONTINUE (placeholder — checkout is
//     draft-order based and server-repriced; the variant price is never
//     charged once the lockout is live)
//   - add the configurator-pilot tag (lockout marker via the deployed liquid)
//   - set productType "Jars" (drives the 16D jar field labels in the block)
//   - keep templateSuffix "jar" (the jar template's block instance renders
//     the payload-driven jar configurator)
//   - update the ERP ConfiguratorProduct row: shopifyVariantGid backfill,
//     minQuantity 50 (owner 16D launch MOQ), active, provenance note
// ACTIVATION IS A SEPARATE GATE: --activate only after the owner runs
// `shopify app deploy` (the deploy ships the jar lockout + native-submit
// block in the theme JS — activating before it would leave the legacy
// native purchase path open at the 1.00 placeholder).
//
//   node tools/rebuild-jars-16d.mjs               read-only audit + dry run
//   node tools/rebuild-jars-16d.mjs --execute     canonicalize (stays DRAFT)
//   node tools/rebuild-jars-16d.mjs --activate    post-deploy: set ACTIVE + verify
//   node tools/rebuild-jars-16d.mjs --rollback    restore snapshots (stays DRAFT)
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const ACTIVATE = process.argv.includes("--activate");
const ROLLBACK = process.argv.includes("--rollback");
const SHOP = "942075-2.myshopify.com";
const DATA_DIR = path.join("tools", "rebuild-16c-data");
const ROLLBACK_FILE = path.join(DATA_DIR, "rollback-16d-jars.json");
const MARKER = "16D jar canonical launch";

// handle -> expected ERP productType (verified live before any write)
const LAUNCH_TARGETS = {
  "100ml-tall-miron-jars": "jar_100ml_tall",
  "100ml-wide-miron-jars": "jar_100ml_wide",
  "150ml-miron-jars": "jar_150ml",
};
const JAR_MIN_QTY = 50;

const db = new PrismaClient();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function gql(token, query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/2025-10/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 500));
  return json.data;
}

const DETAIL = `query($h: String!) { productByIdentifier(identifier: { handle: $h }) {
  id handle title status productType vendor templateSuffix tags
  mediaCount { count }
  options { id name position values }
  variants(first: 50) { nodes { id title position price compareAtPrice barcode inventoryPolicy
    selectedOptions { name value } inventoryItem { sku tracked } } }
} }`;

function requireClean(step, payload) {
  const errors = payload?.userErrors || [];
  if (errors.length) throw new Error(`${step}: ${JSON.stringify(errors).slice(0, 400)}`);
}

async function detailFor(token, handle) {
  const data = await gql(token, DETAIL, { h: handle });
  if (!data.productByIdentifier) throw new Error(`${handle}: product not found`);
  return data.productByIdentifier;
}

function snapshotOf(detail, erpRow) {
  return {
    id: detail.id,
    handle: detail.handle,
    title: detail.title,
    previousStatus: detail.status,
    previousProductType: detail.productType ?? "",
    previousTemplateSuffix: detail.templateSuffix ?? null,
    previousTags: [...(detail.tags || [])],
    erpRow: erpRow
      ? { id: erpRow.id, previousMinQuantity: erpRow.minQuantity, previousVariantGid: erpRow.shopifyVariantGid ?? null, previousActive: erpRow.active, previousNotes: erpRow.notes ?? null }
      : null,
    options: (detail.options || []).map((option) => ({ id: option.id, name: option.name, position: option.position, values: [...option.values] })),
    variants: detail.variants.nodes.map((variant) => ({
      id: variant.id, title: variant.title, position: variant.position, price: variant.price,
      compareAtPrice: variant.compareAtPrice ?? null, barcode: variant.barcode ?? null,
      sku: variant.inventoryItem?.sku ?? null, inventoryPolicy: variant.inventoryPolicy ?? null,
      selectedOptions: variant.selectedOptions.map((so) => ({ name: so.name, value: so.value })),
    })),
  };
}

function appendRollback(entry) {
  let artifact = { savedAt: new Date().toISOString(), products: [] };
  if (existsSync(ROLLBACK_FILE)) artifact = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
  if (!artifact.products.some((existing) => existing.id === entry.id)) {
    artifact.products.push(entry);
    artifact.savedAt = new Date().toISOString();
    writeFileSync(ROLLBACK_FILE, JSON.stringify(artifact, null, 1));
  }
}

async function verifyCanonical(token, handle, expectType) {
  const detail = await detailFor(token, handle);
  const problems = [];
  const variants = detail.variants.nodes;
  if (variants.length !== 1) problems.push(`${variants.length} variants`);
  if (detail.options.length !== 1) problems.push(`${detail.options.length} options`);
  if (variants[0] && Number(variants[0].price) !== 1) problems.push(`price ${variants[0].price}`);
  if (variants[0] && variants[0].inventoryPolicy !== "CONTINUE") problems.push(`policy ${variants[0].inventoryPolicy}`);
  if (!detail.tags.includes("configurator-pilot")) problems.push("missing configurator-pilot tag");
  if (detail.productType !== "Jars") problems.push(`productType "${detail.productType}"`);
  if (detail.templateSuffix !== "jar") problems.push(`templateSuffix ${detail.templateSuffix}`);
  const row = await db.configuratorProduct.findFirst({ where: { shop: SHOP, shopifyHandle: handle, productType: expectType } });
  if (!row) problems.push("ERP row missing");
  else {
    if (row.shopifyVariantGid !== variants[0]?.id) problems.push("ERP variant GID mismatch");
    if (row.minQuantity !== JAR_MIN_QTY) problems.push(`ERP minQuantity ${row.minQuantity}`);
    if (!row.active) problems.push("ERP row inactive");
  }
  return { detail, ok: problems.length === 0, problems };
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const session = await db.session.findFirst({ where: { shop: SHOP }, orderBy: { id: "asc" } });
  const token = session.accessToken;

  if (ROLLBACK) {
    if (!existsSync(ROLLBACK_FILE)) throw new Error("No 16D rollback artifact found.");
    const artifact = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
    for (const entry of artifact.products) {
      const input = {
        id: entry.id,
        status: entry.previousStatus,
        productType: entry.previousProductType,
        templateSuffix: entry.previousTemplateSuffix,
        tags: entry.previousTags,
        productOptions: entry.options
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          .map((option) => ({ name: option.name, position: option.position, values: option.values.map((value) => ({ name: value })) })),
        variants: entry.variants.map((variant) => ({
          optionValues: variant.selectedOptions.map((so) => ({ optionName: so.name, name: so.value })),
          price: variant.price, compareAtPrice: variant.compareAtPrice, barcode: variant.barcode,
          inventoryPolicy: variant.inventoryPolicy, sku: variant.sku,
        })),
      };
      const result = await gql(token, `mutation($input: ProductSetInput!) { productSet(input: $input, synchronous: true) {
        product { id status variantsCount { count } } userErrors { field message } } }`, { input });
      const errors = result.productSet?.userErrors || [];
      if (errors.length) { console.log(`FAIL ${entry.handle}: ${JSON.stringify(errors).slice(0, 250)}`); continue; }
      if (entry.erpRow) {
        await db.configuratorProduct.update({
          where: { id: entry.erpRow.id },
          data: {
            minQuantity: entry.erpRow.previousMinQuantity,
            shopifyVariantGid: entry.erpRow.previousVariantGid,
            active: entry.erpRow.previousActive,
            notes: entry.erpRow.previousNotes,
          },
        });
      }
      console.log(`restored ${entry.handle} -> ${result.productSet.product.status}, ${result.productSet.product.variantsCount.count} variants (new GIDs)`);
      await sleep(400);
    }
    return;
  }

  if (ACTIVATE) {
    let activated = 0;
    for (const [handle, expectType] of Object.entries(LAUNCH_TARGETS)) {
      const verdict = await verifyCanonical(token, handle, expectType);
      if (!verdict.ok) { console.log(`REFUSED ${handle}: ${verdict.problems.join("; ")}`); process.exitCode = 1; continue; }
      if (verdict.detail.status === "ACTIVE") { console.log(`already ACTIVE ${handle}`); activated += 1; continue; }
      const result = await gql(token, `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id status } userErrors { field message } } }`, { p: { id: verdict.detail.id, status: "ACTIVE" } });
      requireClean(`${handle} activate`, result.productUpdate);
      if (result.productUpdate.product.status === "ACTIVE") { console.log(`ACTIVATED ${handle}`); activated += 1; }
      await sleep(250);
    }
    console.log(`\nACTIVE: ${activated}/${Object.keys(LAUNCH_TARGETS).length}`);
    return;
  }

  for (const [handle, expectType] of Object.entries(LAUNCH_TARGETS)) {
    const detail = await detailFor(token, handle);
    const erpRow = await db.configuratorProduct.findFirst({ where: { shop: SHOP, shopifyHandle: handle, productType: expectType } });
    const already = detail.tags.includes("configurator-pilot") && detail.variants.nodes.length === 1;
    const guards = [];
    if (!erpRow) guards.push(`no ERP row (${expectType})`);
    if (!already) {
      if (detail.status !== "DRAFT") guards.push(`status ${detail.status} (expected DRAFT pre-canonicalization)`);
      if (detail.variants.nodes.length < 2) guards.push(`${detail.variants.nodes.length} variants`);
    }
    if (guards.length) throw new Error(`${handle}: ${guards.join("; ")} — STOP.`);
    const plan = already ? "converge (already collapsed)" : `keep pos-1 variant, delete ${detail.variants.nodes.length - 1} variants + ${detail.options.length} options`;
    console.log(`${EXECUTE ? "REBUILD" : "[dry]"} ${handle} (${detail.status}, ${detail.variants.nodes.length} variants, tmpl=${detail.templateSuffix}): ${plan}; +tag +type Jars +ERP vgid/minQ ${JAR_MIN_QTY}`);

    if (!EXECUTE) continue;
    appendRollback(snapshotOf(detail, erpRow));

    let current = detail;
    if (current.variants.nodes.length > 1) {
      const sorted = [...current.variants.nodes].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      const result = await gql(token, `mutation($productId: ID!, $variantsIds: [ID!]!) { productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) { product { id } userErrors { field message } } }`, { productId: current.id, variantsIds: sorted.slice(1).map((variant) => variant.id) });
      requireClean(`${handle} variant delete`, result.productVariantsBulkDelete);
      console.log(`  ${handle}: deleted ${sorted.length - 1} variants (kept ${sorted[0].title})`);
      await sleep(300);
      current = await detailFor(token, handle);
    }
    if (current.options.length > 1 || (current.options.length === 1 && current.options[0].name !== "Title")) {
      const result = await gql(token, `mutation($productId: ID!, $options: [ID!]!) { productOptionsDelete(productId: $productId, options: $options, strategy: DEFAULT) { deletedOptionsIds userErrors { field message } } }`, { productId: current.id, options: current.options.map((option) => option.id) });
      requireClean(`${handle} option delete`, result.productOptionsDelete);
      await sleep(300);
      current = await detailFor(token, handle);
    }
    const kept = current.variants.nodes[0];
    if (!kept) throw new Error(`${handle}: no variant left — STOP`);
    if (Number(kept.price) !== 1 || kept.inventoryPolicy !== "CONTINUE") {
      const result = await gql(token, `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } } }`, { productId: current.id, variants: [{ id: kept.id, price: "1.00", inventoryPolicy: "CONTINUE" }] });
      requireClean(`${handle} variant normalize`, result.productVariantsBulkUpdate);
      await sleep(300);
    }
    if (!current.tags.includes("configurator-pilot")) {
      const result = await gql(token, `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`, { id: current.id, tags: ["configurator-pilot"] });
      requireClean(`${handle} tag`, result.tagsAdd);
      await sleep(300);
    }
    if (current.productType !== "Jars") {
      const result = await gql(token, `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id productType } userErrors { field message } } }`, { p: { id: current.id, productType: "Jars" } });
      requireClean(`${handle} productType`, result.productUpdate);
      await sleep(300);
    }
    const fresh = await detailFor(token, handle);
    await db.configuratorProduct.update({
      where: { id: erpRow.id },
      data: {
        shopifyProductGid: fresh.id,
        shopifyVariantGid: fresh.variants.nodes[0].id,
        minQuantity: JAR_MIN_QTY,
        active: true,
        pilot: true,
        notes: `${erpRow.notes ? `${erpRow.notes}\n` : ""}${MARKER}: variant matrix collapsed, variant GID backfilled, MOQ ${JAR_MIN_QTY}, owner-approved 16D pricing via canonical jar engine.`,
      },
    });
    const verdict = await verifyCanonical(token, handle, expectType);
    console.log(`  ${handle}: ${verdict.ok ? "VERIFIED (stays DRAFT until --activate after shopify app deploy)" : "VERIFY FAILED: " + verdict.problems.join("; ")}`);
    if (!verdict.ok) process.exitCode = 1;
    await sleep(300);
  }

  if (!EXECUTE) console.log(`\nDRY RUN ONLY — no writes. Targets: ${Object.keys(LAUNCH_TARGETS).join(", ")}`);
}

main()
  .catch((error) => { console.error("ERROR:", error.message || error); process.exit(1); })
  .finally(() => db.$disconnect());
