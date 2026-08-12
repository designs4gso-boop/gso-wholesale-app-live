// Phase 16C — rebuild the 31 legacy Stock Bags (drafted in 16B) to the
// canonical single-variant configurator architecture, then reactivate them.
// Per product: collapse the native Sided/Material/Bag Color variant matrix to
// one base variant @ 1.00, delete the options, add the configurator-pilot tag,
// set templateSuffix configurator-pilot, create the ConfiguratorProduct row,
// verify everything, and only then set status ACTIVE. Title/handle/media/
// flavor tags are preserved; nothing is deleted beyond variants/options.
//
// GATES (owner-mandated sequence):
//   node tools/rebuild-legacy-bags-16c.mjs                  read-only audit + dry-run plan
//   node tools/rebuild-legacy-bags-16c.mjs --execute-canary rebuild ONE product, verify
//   node tools/rebuild-legacy-bags-16c.mjs --execute        rebuild the remaining products
//   node tools/rebuild-legacy-bags-16c.mjs --execute --only <handle>   converge one product
//   node tools/rebuild-legacy-bags-16c.mjs --rollback [--only <handle>] restore from artifact
// Execution refuses to run unless the live legacy+rebuilt census is EXACTLY 31
// and every target also appears in the 16B draft rollback artifact. --execute
// refuses until the canary product has been rebuilt and verified. Any product
// failing any step stays DRAFT (never sellable) and is reported.
// Rollback restores status/tags/template and recreates an equivalent variant
// matrix from the snapshot (variant GIDs are necessarily new), and removes the
// ConfiguratorProduct rows this tool created.
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CANONICAL_TAG,
  CANONICAL_TEMPLATE_SUFFIX,
  CANONICAL_VARIANT_PRICE,
  EXPECTED_LEGACY_COUNT,
  REBUILD_NOTES_MARKER,
  classifyProduct,
  erpRowDataFor,
  planRebuild,
  snapshotOf,
  verifyRebuilt,
} from "./legacy-bag-rebuild-lib.mjs";

const EXECUTE = process.argv.includes("--execute");
const CANARY = process.argv.includes("--execute-canary");
const ROLLBACK = process.argv.includes("--rollback");
const onlyIndex = process.argv.indexOf("--only");
const ONLY_HANDLE = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
const SHOP = "942075-2.myshopify.com";
const DATA_DIR = path.join("tools", "rebuild-16c-data");
const ROLLBACK_FILE = path.join(DATA_DIR, "rollback-16c-legacy-bags.json");
const SAFETY_16B_FILE = path.join("tools", "storefront-16b-data", "rollback-16b-status.json");
const REFERENCE_HANDLE = "ritz-vanilla-cupcake";

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

const DETAIL_QUERY = `query($id: ID!) { product(id: $id) {
  id handle title status productType vendor templateSuffix tags
  mediaCount { count }
  options { id name position values }
  variants(first: 50) { nodes { id title position price compareAtPrice barcode inventoryPolicy
    selectedOptions { name value } inventoryItem { sku tracked } } }
} }`;

function requireCleanUserErrors(step, payload) {
  const errors = payload?.userErrors || [];
  if (errors.length) throw new Error(`${step}: ${JSON.stringify(errors).slice(0, 400)}`);
}

async function fetchDetail(token, id) {
  const data = await gql(token, DETAIL_QUERY, { id });
  if (!data.product) throw new Error(`product ${id} not found`);
  return data.product;
}

async function loadReference(token) {
  const data = await gql(
    token,
    `query { productByIdentifier(identifier: { handle: "${REFERENCE_HANDLE}" }) {
      templateSuffix tags variants(first: 1) { nodes { price inventoryPolicy inventoryItem { tracked } } } } }`,
  );
  const ref = data.productByIdentifier;
  if (!ref) throw new Error(`reference product ${REFERENCE_HANDLE} not found`);
  const variant = ref.variants.nodes[0];
  if (ref.templateSuffix !== CANONICAL_TEMPLATE_SUFFIX || !ref.tags.includes(CANONICAL_TAG)) {
    throw new Error(`reference product no longer matches canonical shape — STOP for review`);
  }
  return { inventoryPolicy: variant?.inventoryPolicy ?? null, tracked: variant?.inventoryItem?.tracked ?? null };
}

async function scanProducts(token) {
  const erpRows = await db.configuratorProduct.findMany({
    where: { shop: SHOP },
    select: { shopifyProductGid: true, shopifyHandle: true, title: true },
  });
  const erp = {
    gids: new Set(erpRows.map((row) => row.shopifyProductGid).filter(Boolean)),
    handles: new Set(erpRows.map((row) => row.shopifyHandle).filter(Boolean)),
    titles: new Set(erpRows.map((row) => row.title)),
  };
  let cursor = null;
  const legacy = [];
  let canonical = 0;
  do {
    const data = await gql(
      token,
      `query($c: String) { products(first: 100, after: $c) { pageInfo { hasNextPage endCursor }
        nodes { id handle title status productType tags variantsCount { count } } } }`,
      { c: cursor },
    );
    for (const product of data.products.nodes) {
      const kind = classifyProduct(product, erp);
      if (kind === "legacy") legacy.push(product);
      if (kind === "canonical") canonical += 1;
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);
  legacy.sort((a, b) => a.handle.localeCompare(b.handle));
  return { legacy, canonical };
}

async function erpCollisionFor(product) {
  const row = await db.configuratorProduct.findFirst({
    where: { shop: SHOP, OR: [{ title: product.title }, { shopifyProductGid: product.id }] },
  });
  if (!row) return null;
  const ownRebuildRow = row.shopifyProductGid === product.id && (row.notes || "").includes(REBUILD_NOTES_MARKER);
  if (ownRebuildRow) return null;
  return `ConfiguratorProduct ${row.id} already holds title/gid (gid=${row.shopifyProductGid ?? "none"}) — refusing`;
}

function appendRollbackEntry(entry) {
  let artifact = { savedAt: new Date().toISOString(), products: [] };
  if (existsSync(ROLLBACK_FILE)) artifact = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
  if (!artifact.products.some((existing) => existing.id === entry.id)) {
    artifact.products.push(entry);
    artifact.savedAt = new Date().toISOString();
    writeFileSync(ROLLBACK_FILE, JSON.stringify(artifact, null, 1));
  }
}

// Idempotent per-step convergence: every step inspects live state first, so a
// partially rebuilt product (earlier failure) converges on re-run instead of
// being refused. The product stays DRAFT until verification passes.
async function executeProduct(token, id, reference) {
  let detail = await fetchDetail(token, id);
  const label = detail.handle;
  appendRollbackEntry(snapshotOf(detail));

  const variants = () => detail.variants.nodes;
  if (variants().length > 1) {
    const sorted = [...variants()].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const deleteIds = sorted.slice(1).map((variant) => variant.id);
    const result = await gql(
      token,
      `mutation($productId: ID!, $variantsIds: [ID!]!) { productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
        product { id } userErrors { field message } } }`,
      { productId: id, variantsIds: deleteIds },
    );
    requireCleanUserErrors(`${label} variant delete`, result.productVariantsBulkDelete);
    console.log(`  ${label}: deleted ${deleteIds.length} variants (kept ${sorted[0].title})`);
    await sleep(300);
    detail = await fetchDetail(token, id);
  }

  if (detail.options.length > 1 || (detail.options.length === 1 && detail.options[0].name !== "Title")) {
    const optionIds = detail.options.map((option) => option.id);
    let result = await gql(
      token,
      `mutation($productId: ID!, $options: [ID!]!) { productOptionsDelete(productId: $productId, options: $options, strategy: DEFAULT) {
        deletedOptionsIds userErrors { field message } } }`,
      { productId: id, options: optionIds },
    );
    let errors = result.productOptionsDelete?.userErrors || [];
    if (errors.length && optionIds.length > 1) {
      // Some API versions refuse deleting every option in one call — peel the
      // non-primary options first, then the last one.
      console.log(`  ${label}: bulk option delete refused (${JSON.stringify(errors).slice(0, 160)}); retrying two-step`);
      result = await gql(
        token,
        `mutation($productId: ID!, $options: [ID!]!) { productOptionsDelete(productId: $productId, options: $options, strategy: DEFAULT) {
          deletedOptionsIds userErrors { field message } } }`,
        { productId: id, options: optionIds.slice(1) },
      );
      requireCleanUserErrors(`${label} option delete (secondary)`, result.productOptionsDelete);
      await sleep(300);
      result = await gql(
        token,
        `mutation($productId: ID!, $options: [ID!]!) { productOptionsDelete(productId: $productId, options: $options, strategy: DEFAULT) {
          deletedOptionsIds userErrors { field message } } }`,
        { productId: id, options: [optionIds[0]] },
      );
    }
    requireCleanUserErrors(`${label} option delete`, result.productOptionsDelete);
    console.log(`  ${label}: options deleted`);
    await sleep(300);
    detail = await fetchDetail(token, id);
  }

  const keptVariant = variants()[0];
  if (!keptVariant) throw new Error(`${label}: no variant left after collapse — STOP`);
  const priceWrong = Number(keptVariant.price) !== Number(CANONICAL_VARIANT_PRICE);
  const policyWrong = reference.inventoryPolicy && keptVariant.inventoryPolicy !== reference.inventoryPolicy;
  if (priceWrong || policyWrong) {
    const variantInput = { id: keptVariant.id, price: CANONICAL_VARIANT_PRICE };
    if (reference.inventoryPolicy) variantInput.inventoryPolicy = reference.inventoryPolicy;
    const result = await gql(
      token,
      `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price inventoryPolicy } userErrors { field message } } }`,
      { productId: id, variants: [variantInput] },
    );
    requireCleanUserErrors(`${label} variant normalize`, result.productVariantsBulkUpdate);
    console.log(`  ${label}: base variant normalized (price ${CANONICAL_VARIANT_PRICE}${reference.inventoryPolicy ? ", policy " + reference.inventoryPolicy : ""})`);
    await sleep(300);
  }

  if (!detail.tags.includes(CANONICAL_TAG)) {
    const result = await gql(
      token,
      `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { field message } } }`,
      { id, tags: [CANONICAL_TAG] },
    );
    requireCleanUserErrors(`${label} tag add`, result.tagsAdd);
    await sleep(300);
  }

  if (detail.templateSuffix !== CANONICAL_TEMPLATE_SUFFIX) {
    const result = await gql(
      token,
      `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id templateSuffix } userErrors { field message } } }`,
      { p: { id, templateSuffix: CANONICAL_TEMPLATE_SUFFIX } },
    );
    requireCleanUserErrors(`${label} template`, result.productUpdate);
    await sleep(300);
  }

  detail = await fetchDetail(token, id);
  const freshVariant = detail.variants.nodes[0];
  const rowData = erpRowDataFor(detail, freshVariant.id, freshVariant.inventoryItem?.sku ?? null);
  const existingRow = await db.configuratorProduct.findFirst({
    where: { shop: SHOP, OR: [{ title: detail.title }, { shopifyProductGid: detail.id }] },
  });
  if (existingRow && existingRow.shopifyProductGid && existingRow.shopifyProductGid !== detail.id) {
    throw new Error(`${label}: ConfiguratorProduct collision (${existingRow.id}) — STOP`);
  }
  if (existingRow) {
    await db.configuratorProduct.update({ where: { id: existingRow.id }, data: rowData });
  } else {
    await db.configuratorProduct.create({ data: { shop: SHOP, ...rowData } });
  }

  const verdict = verifyRebuilt(detail, reference);
  const erpRow = await db.configuratorProduct.findFirst({ where: { shop: SHOP, shopifyProductGid: detail.id } });
  if (!erpRow || erpRow.shopifyVariantGid !== freshVariant.id) {
    verdict.ok = false;
    verdict.problems.push("ConfiguratorProduct row missing or variant GID mismatch");
  }
  if (!verdict.ok) {
    console.log(`  ${label}: VERIFY FAILED — stays DRAFT: ${verdict.problems.join("; ")}`);
    return { handle: label, ok: false, problems: verdict.problems };
  }

  const activate = await gql(
    token,
    `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id status } userErrors { field message } } }`,
    { p: { id, status: "ACTIVE" } },
  );
  requireCleanUserErrors(`${label} activate`, activate.productUpdate);
  if (activate.productUpdate.product.status !== "ACTIVE") {
    return { handle: label, ok: false, problems: ["activation did not stick"] };
  }
  console.log(`  ${label}: VERIFIED + ACTIVE (media ${detail.mediaCount?.count}, tags ${detail.tags.length})`);
  return { handle: label, ok: true };
}

async function rollback(token) {
  if (!existsSync(ROLLBACK_FILE)) throw new Error("No 16C rollback artifact found.");
  const artifact = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
  const targets = artifact.products.filter((entry) => !ONLY_HANDLE || entry.handle === ONLY_HANDLE);
  if (!targets.length) throw new Error("No matching rollback entries.");
  for (const entry of targets) {
    const input = {
      id: entry.id,
      status: entry.previousStatus,
      templateSuffix: entry.previousTemplateSuffix,
      tags: entry.previousTags,
      productOptions: entry.options
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((option) => ({ name: option.name, position: option.position, values: option.values.map((value) => ({ name: value })) })),
      variants: entry.variants.map((variant) => ({
        optionValues: variant.selectedOptions.map((so) => ({ optionName: so.name, name: so.value })),
        price: variant.price,
        compareAtPrice: variant.compareAtPrice,
        barcode: variant.barcode,
        inventoryPolicy: variant.inventoryPolicy,
        sku: variant.sku,
      })),
    };
    const result = await gql(
      token,
      `mutation($input: ProductSetInput!) { productSet(input: $input, synchronous: true) {
        product { id variantsCount { count } status } userErrors { field message } } }`,
      { input },
    );
    const errors = result.productSet?.userErrors || [];
    if (errors.length) {
      console.log(`FAIL ${entry.handle}: ${JSON.stringify(errors).slice(0, 300)}`);
      continue;
    }
    const restored = result.productSet.product;
    await db.configuratorProduct.deleteMany({
      where: { shop: SHOP, shopifyProductGid: entry.id, notes: { contains: REBUILD_NOTES_MARKER } },
    });
    console.log(`restored ${entry.handle} -> ${restored.status}, ${restored.variantsCount.count} variants (new variant GIDs)`);
    await sleep(400);
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const session = await db.session.findFirst({ where: { shop: SHOP }, orderBy: { id: "asc" } });
  const token = session.accessToken;

  if (ROLLBACK) return rollback(token);

  const reference = await loadReference(token);
  console.log(`reference (${REFERENCE_HANDLE}): inventoryPolicy=${reference.inventoryPolicy} tracked=${reference.tracked}`);

  const { legacy, canonical } = await scanProducts(token);
  const rebuiltRows = await db.configuratorProduct.findMany({
    where: { shop: SHOP, notes: { contains: REBUILD_NOTES_MARKER } },
    select: { shopifyHandle: true },
  });
  const census = legacy.length + rebuiltRows.length;
  console.log(`legacy remaining: ${legacy.length} | rebuilt by 16C: ${rebuiltRows.length} | canonical fleet: ${canonical}`);
  if (census !== EXPECTED_LEGACY_COUNT) {
    throw new Error(`Census ${census} != expected ${EXPECTED_LEGACY_COUNT} (legacy ${legacy.length} + rebuilt ${rebuiltRows.length}) — STOP for review.`);
  }

  // Anchor every target to the 16B draft artifact — the products we draft-ed
  // in 16B are the only products this tool may ever mutate.
  const anchored = new Set(
    existsSync(SAFETY_16B_FILE)
      ? JSON.parse(readFileSync(SAFETY_16B_FILE, "utf8")).products.map((product) => product.id)
      : [],
  );
  if (!anchored.size) throw new Error(`16B rollback artifact missing (${SAFETY_16B_FILE}) — cannot anchor target set, STOP.`);
  const unanchored = legacy.filter((product) => !anchored.has(product.id));
  if (unanchored.length) {
    throw new Error(`Products matching legacy criteria but NOT in the 16B artifact: ${unanchored.map((p) => p.handle).join(", ")} — STOP.`);
  }

  const collisions = [];
  for (const product of legacy) {
    const collision = await erpCollisionFor(product);
    if (collision) collisions.push(`${product.handle}: ${collision}`);
  }
  if (collisions.length) throw new Error(`ERP collisions — STOP:\n  ${collisions.join("\n  ")}`);

  let targets = legacy;
  if (ONLY_HANDLE) {
    targets = legacy.filter((product) => product.handle === ONLY_HANDLE);
    if (!targets.length) throw new Error(`--only ${ONLY_HANDLE} does not match any remaining legacy product.`);
  } else if (CANARY) {
    targets = legacy.slice(0, 1);
  }

  for (const product of targets) {
    const plan = planRebuild(
      await fetchDetail(token, product.id),
    );
    if (plan.errors.length) {
      console.log(`${product.handle}: PLAN REFUSED — ${plan.errors.join("; ")}`);
      if (!ONLY_HANDLE) throw new Error(`Plan refused for ${product.handle} — STOP before any mutation.`);
      continue;
    }
    console.log(
      `${EXECUTE || CANARY ? "REBUILD" : "[dry]"} ${product.handle}: keep ${plan.keepVariantId.slice(-8)}, delete ${plan.deleteVariantIds.length} variants + ${plan.optionIds.length} options, +tag +template +ERP row`,
    );
    await sleep(120);
  }

  if (!EXECUTE && !CANARY) {
    console.log(`\nDRY RUN ONLY — ${targets.length} products planned, 0 mutated. Canary next: ${legacy[0]?.handle}`);
    return;
  }
  if (EXECUTE && !CANARY && !ONLY_HANDLE && rebuiltRows.length === 0) {
    throw new Error("--execute refused: run --execute-canary first and verify one product end-to-end.");
  }

  const results = [];
  for (const product of targets) {
    try {
      results.push(await executeProduct(token, product.id, reference));
    } catch (error) {
      console.log(`  ${product.handle}: ERROR — ${error.message?.slice(0, 300)} (stays DRAFT)`);
      results.push({ handle: product.handle, ok: false, problems: [error.message?.slice(0, 200)] });
    }
    await sleep(300);
  }
  const succeeded = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  console.log(`\nREBUILT + ACTIVATED: ${succeeded.length}/${results.length} | rollback artifact: ${ROLLBACK_FILE}`);
  if (failed.length) {
    console.log(`FAILED (left DRAFT): ${failed.map((result) => result.handle).join(", ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => { console.error("ERROR:", error.message || error); process.exit(1); })
  .finally(() => db.$disconnect());
