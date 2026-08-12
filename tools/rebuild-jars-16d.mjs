// Phase 16D/16D.1 — canonicalize the Miron/oz applied-label jar family to the
// single-purchase-path architecture:
//   - collapse native variant matrices to ONE "Default Title" variant @ 1.00 /
//     CONTINUE (placeholder — checkout is draft-order based, server-repriced)
//   - configurator-pilot tag (lockout marker), productType "Jars", template
//     "jar" kept
//   - ERP ConfiguratorProduct rows: shopifyVariantGid backfill, minQuantity 50
//     (owner launch MOQ), active, provenance notes (3oz/4oz have TWO rows per
//     handle — clear + black_white color types — both are updated)
//   - 16D.1: fixes the "50mml-miron-jars" handle typo -> "50ml-miron-jars"
//     WITH a Shopify URL redirect (this also aligns Shopify with the ERP row,
//     which always held the typo-free handle), and corrects the stale jar
//     recipe application labor (10s -> 36s/jar = the owner $20/hr @ 100
//     jars/hr standard; cost-side operational data only, no migration).
// ACTIVATION GATES: --activate refuses any product that fails canonical
// verification or has ZERO media (MEDIA ONLY BLOCKER — no imageless launch).
//
//   node tools/rebuild-jars-16d.mjs               read-only audit + dry run
//   node tools/rebuild-jars-16d.mjs --execute     canonicalize (stays DRAFT)
//   node tools/rebuild-jars-16d.mjs --activate    activate every verified product with media
//   node tools/rebuild-jars-16d.mjs --rollback    restore snapshots
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

// handle -> ERP productTypes rooted at that handle (color-variant sizes have
// two). The 100ml/150ml entries stay so this remains the ONE family tool
// (idempotent converge — already-canonical products verify and skip).
const LAUNCH_TARGETS = {
  "50ml-miron-jars": ["jar_50ml"],
  "100ml-tall-miron-jars": ["jar_100ml_tall"],
  "100ml-wide-miron-jars": ["jar_100ml_wide"],
  "150ml-miron-jars": ["jar_150ml"],
  "250ml-miron-jars": ["jar_250ml"],
  "3oz-jar": ["jar_3oz_clear", "jar_3oz_black_white"],
  "4oz-jar": ["jar_4oz_clear", "jar_4oz_black_white"],
};
const TYPO_HANDLE = "50mml-miron-jars";
const FIXED_HANDLE = "50ml-miron-jars";
const JAR_MIN_QTY = 50;
// Owner application standard: $20/hour at minimum 100 jars/hour = 36 s/jar.
const APPLICATION_SECONDS_PER_JAR = 36;

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

async function detailFor(token, handle, optional = false) {
  const data = await gql(token, DETAIL, { h: handle });
  if (!data.productByIdentifier && !optional) throw new Error(`${handle}: product not found`);
  return data.productByIdentifier;
}

function snapshotOf(detail, erpRows) {
  return {
    id: detail.id,
    handle: detail.handle,
    title: detail.title,
    previousStatus: detail.status,
    previousProductType: detail.productType ?? "",
    previousTemplateSuffix: detail.templateSuffix ?? null,
    previousTags: [...(detail.tags || [])],
    erpRows: (erpRows || []).map((row) => ({
      id: row.id,
      previousMinQuantity: row.minQuantity,
      previousVariantGid: row.shopifyVariantGid ?? null,
      previousActive: row.active,
      previousNotes: row.notes ?? null,
      previousHandle: row.shopifyHandle ?? null,
    })),
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

async function verifyCanonical(token, handle, expectTypes) {
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
  for (const expectType of expectTypes) {
    const row = await db.configuratorProduct.findFirst({ where: { shop: SHOP, shopifyHandle: handle, productType: expectType } });
    if (!row) { problems.push(`ERP row missing (${expectType})`); continue; }
    if (row.shopifyVariantGid !== variants[0]?.id) problems.push(`ERP variant GID mismatch (${expectType})`);
    if (row.minQuantity !== JAR_MIN_QTY) problems.push(`ERP minQuantity ${row.minQuantity} (${expectType})`);
    if (!row.active) problems.push(`ERP row inactive (${expectType})`);
  }
  return { detail, ok: problems.length === 0, problems };
}

// 16D.1: fix the 50mml handle typo with a storefront redirect, aligning
// Shopify with the ERP row (which always held the typo-free handle).
async function fixTypoHandle(token, dryRun) {
  const atFixed = await detailFor(token, FIXED_HANDLE, true);
  if (atFixed) return false; // already fixed
  const atTypo = await detailFor(token, TYPO_HANDLE, true);
  if (!atTypo) throw new Error(`Neither ${FIXED_HANDLE} nor ${TYPO_HANDLE} exists — STOP.`);
  if (dryRun) {
    console.log(`[dry] would rename handle ${TYPO_HANDLE} -> ${FIXED_HANDLE} (redirectNewHandle: true)`);
    return false;
  }
  const intro = await gql(token, `{ t: __type(name: "ProductUpdateInput") { inputFields { name } } }`);
  const hasRedirect = intro.t.inputFields.some((field) => field.name === "redirectNewHandle");
  if (!hasRedirect) throw new Error("ProductUpdateInput has no redirectNewHandle on this API version — STOP (no silent URL break).");
  const result = await gql(
    token,
    `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id handle } userErrors { field message } } }`,
    { p: { id: atTypo.id, handle: FIXED_HANDLE, redirectNewHandle: true } },
  );
  requireClean("handle fix", result.productUpdate);
  if (result.productUpdate.product.handle !== FIXED_HANDLE) throw new Error("handle fix did not stick — STOP");
  console.log(`handle fixed: ${TYPO_HANDLE} -> ${FIXED_HANDLE} (redirect created)`);
  await sleep(300);
  return true;
}

// Owner application standard correction — cost-side operational data only.
async function fixApplicationLabor(dryRun) {
  const stale = await db.productRecipe.findMany({
    where: { shop: SHOP, active: true, productTypeProfile: { key: { startsWith: "jar_" } }, NOT: { applicationLaborSecondsPerUnit: APPLICATION_SECONDS_PER_JAR } },
    select: { id: true, name: true, applicationLaborSecondsPerUnit: true },
  });
  if (!stale.length) { console.log("application labor: all jar recipes already at 36 s/jar"); return; }
  for (const recipe of stale) {
    console.log(`${dryRun ? "[dry] would update" : "updated"} recipe "${recipe.name}": applicationLaborSecondsPerUnit ${recipe.applicationLaborSecondsPerUnit} -> ${APPLICATION_SECONDS_PER_JAR}`);
    if (!dryRun) await db.productRecipe.update({ where: { id: recipe.id }, data: { applicationLaborSecondsPerUnit: APPLICATION_SECONDS_PER_JAR } });
  }
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
        ...(entry.handle ? { handle: entry.handle } : {}),
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
      for (const row of entry.erpRows || (entry.erpRow ? [entry.erpRow] : [])) {
        await db.configuratorProduct.update({
          where: { id: row.id },
          data: {
            minQuantity: row.previousMinQuantity,
            shopifyVariantGid: row.previousVariantGid,
            active: row.previousActive,
            notes: row.previousNotes,
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
    let blocked = 0;
    for (const [handle, expectTypes] of Object.entries(LAUNCH_TARGETS)) {
      const verdict = await verifyCanonical(token, handle, expectTypes);
      if (!verdict.ok) { console.log(`REFUSED ${handle}: ${verdict.problems.join("; ")}`); process.exitCode = 1; continue; }
      if ((verdict.detail.mediaCount?.count ?? 0) === 0) {
        console.log(`MEDIA ONLY BLOCKER ${handle}: technically ready, 0 media — stays ${verdict.detail.status}. Add product imagery, then re-run --activate.`);
        blocked += 1;
        continue;
      }
      if (verdict.detail.status === "ACTIVE") { console.log(`already ACTIVE ${handle}`); activated += 1; continue; }
      const result = await gql(token, `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id status } userErrors { field message } } }`, { p: { id: verdict.detail.id, status: "ACTIVE" } });
      requireClean(`${handle} activate`, result.productUpdate);
      if (result.productUpdate.product.status === "ACTIVE") { console.log(`ACTIVATED ${handle}`); activated += 1; }
      await sleep(250);
    }
    console.log(`\nACTIVE: ${activated}/${Object.keys(LAUNCH_TARGETS).length}${blocked ? ` | media-blocked: ${blocked}` : ""}`);
    return;
  }

  await fixTypoHandle(token, !EXECUTE);
  await fixApplicationLabor(!EXECUTE);

  for (const [handle, expectTypes] of Object.entries(LAUNCH_TARGETS)) {
    const detail = await detailFor(token, handle, true);
    if (!detail) {
      console.log(`${EXECUTE ? "SKIP" : "[dry]"} ${handle}: not found yet (typo fix pending?)`);
      continue;
    }
    const erpRows = [];
    for (const expectType of expectTypes) {
      const row = await db.configuratorProduct.findFirst({ where: { shop: SHOP, productType: expectType, OR: [{ shopifyHandle: handle }, { shopifyProductGid: detail.id }] } });
      if (row) erpRows.push(row);
    }
    const already = detail.tags.includes("configurator-pilot") && detail.variants.nodes.length === 1;
    const guards = [];
    if (erpRows.length !== expectTypes.length) guards.push(`ERP rows ${erpRows.length}/${expectTypes.length} (${expectTypes.join(",")})`);
    if (!already) {
      if (detail.status !== "DRAFT") guards.push(`status ${detail.status} (expected DRAFT pre-canonicalization)`);
      if (detail.variants.nodes.length < 2) guards.push(`${detail.variants.nodes.length} variants`);
    }
    if (guards.length) throw new Error(`${handle}: ${guards.join("; ")} — STOP.`);
    const plan = already
      ? "converge (already canonical)"
      : `keep pos-1 variant, delete ${detail.variants.nodes.length - 1} variants + ${detail.options.length} options`;
    console.log(`${EXECUTE ? "REBUILD" : "[dry]"} ${handle} (${detail.status}, ${detail.variants.nodes.length} variants, media ${detail.mediaCount?.count ?? 0}): ${plan}; +tag +type Jars +${erpRows.length} ERP row(s) vgid/minQ ${JAR_MIN_QTY}`);

    if (!EXECUTE) continue;
    appendRollback(snapshotOf(detail, erpRows));

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
    for (const row of erpRows) {
      await db.configuratorProduct.update({
        where: { id: row.id },
        data: {
          shopifyProductGid: fresh.id,
          shopifyVariantGid: fresh.variants.nodes[0].id,
          shopifyHandle: handle,
          minQuantity: JAR_MIN_QTY,
          active: true,
          pilot: true,
          notes: (row.notes || "").includes(MARKER)
            ? row.notes
            : `${row.notes ? `${row.notes}\n` : ""}${MARKER}: variant matrix collapsed, variant GID backfilled, MOQ ${JAR_MIN_QTY}, owner-approved pricing via canonical jar engine.`,
        },
      });
    }
    const verdict = await verifyCanonical(token, handle, expectTypes);
    console.log(`  ${handle}: ${verdict.ok ? `VERIFIED (media ${verdict.detail.mediaCount?.count ?? 0}; activation via --activate)` : "VERIFY FAILED: " + verdict.problems.join("; ")}`);
    if (!verdict.ok) process.exitCode = 1;
    await sleep(300);
  }

  if (!EXECUTE) console.log(`\nDRY RUN ONLY — no writes. Targets: ${Object.keys(LAUNCH_TARGETS).join(", ")}`);
}

main()
  .catch((error) => { console.error("ERROR:", error.message || error); process.exit(1); })
  .finally(() => db.$disconnect());
