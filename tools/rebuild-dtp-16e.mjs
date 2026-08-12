// Phase 16E — canonicalize the DTP pouch family to the single-purchase-path
// architecture. Four Spektra vendor-finished sizes (4x5x2 / 5x4x2 / 6x5x2 /
// 8x5x2) priced by the 15C.2 owner selling-price ladders via the canonical
// DTP engine.
//   - 4x5-custom-pouch (existing, media + description preserved) becomes the
//     canonical 4x5x2 product: 6-variant Material/zipper matrix -> ONE
//     "Default Title" variant @ 1.00 / CONTINUE (placeholder — checkout is
//     draft-order based and server-repriced), configurator-pilot tag
//     (lockout marker), productType "DTP Pouches", template configurator-pilot
//   - the other three sizes are CREATED as DRAFT single-variant products
//     (no media yet -> the --activate media gate holds them until the owner
//     adds imagery; nothing is fabricated)
//   - each size gets an ERP ConfiguratorProduct row (dtp_<size>, MOQ 1000)
//
//   node tools/rebuild-dtp-16e.mjs               read-only audit + dry run
//   node tools/rebuild-dtp-16e.mjs --execute     canonicalize + create (stays DRAFT)
//   node tools/rebuild-dtp-16e.mjs --activate    activate verified products WITH media
//   node tools/rebuild-dtp-16e.mjs --rollback    restore snapshots / re-draft created products
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const ACTIVATE = process.argv.includes("--activate");
const ROLLBACK = process.argv.includes("--rollback");
const SHOP = "942075-2.myshopify.com";
const DATA_DIR = path.join("tools", "rebuild-16c-data");
const ROLLBACK_FILE = path.join(DATA_DIR, "rollback-16e-dtp.json");
const MARKER = "16E DTP canonical launch";
const DTP_MIN_QTY = 1000;

// handle -> { type, title, existing } (existing=true products are
// canonicalized in place; the rest are created as DRAFT).
const TARGETS = {
  "4x5-custom-pouch": { type: "dtp_4x5x2", title: "4x5 Custom Pouch", existing: true },
  "5x4x2-dtp-pouch": { type: "dtp_5x4x2", title: "5x4x2 DTP Pouch", existing: false },
  "6x5x2-dtp-pouch": { type: "dtp_6x5x2", title: "6x5x2 DTP Pouch", existing: false },
  "8x5x2-dtp-pouch": { type: "dtp_8x5x2", title: "8x5x2 DTP Pouch", existing: false },
};

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
  variants(first: 20) { nodes { id title position price compareAtPrice barcode inventoryPolicy
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

function appendRollback(entry) {
  let artifact = { savedAt: new Date().toISOString(), products: [] };
  if (existsSync(ROLLBACK_FILE)) artifact = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
  if (!artifact.products.some((existing) => existing.handle === entry.handle)) {
    artifact.products.push(entry);
    artifact.savedAt = new Date().toISOString();
    writeFileSync(ROLLBACK_FILE, JSON.stringify(artifact, null, 1));
  }
}

async function upsertErpRow(detail, target) {
  const variantGid = detail.variants.nodes[0].id;
  const existing = await db.configuratorProduct.findFirst({
    where: { shop: SHOP, OR: [{ productType: target.type }, { title: target.title }] },
  });
  const data = {
    title: target.title,
    shopifyProductGid: detail.id,
    shopifyVariantGid: variantGid,
    shopifyHandle: detail.handle,
    sku: detail.variants.nodes[0].inventoryItem?.sku ?? null,
    productType: target.type,
    defaultSides: "Double Sided",
    minQuantity: DTP_MIN_QTY,
    pilot: true,
    active: true,
    notes: `${MARKER}: outsourced Spektra vendor-finished pouch; priced by the 15C.2 owner selling-price ladders via canonical-dtp-pricing (MOQ ${DTP_MIN_QTY}).`,
  };
  if (existing) {
    if (existing.shopifyProductGid && existing.shopifyProductGid !== detail.id) {
      throw new Error(`${detail.handle}: ConfiguratorProduct collision (${existing.id}) — STOP`);
    }
    await db.configuratorProduct.update({ where: { id: existing.id }, data });
  } else {
    await db.configuratorProduct.create({ data: { shop: SHOP, ...data } });
  }
}

async function verifyCanonical(token, handle, target) {
  const detail = await detailFor(token, handle);
  const problems = [];
  const variants = detail.variants.nodes;
  if (variants.length !== 1) problems.push(`${variants.length} variants`);
  if (detail.options.length !== 1) problems.push(`${detail.options.length} options`);
  if (variants[0] && Number(variants[0].price) !== 1) problems.push(`price ${variants[0].price}`);
  if (variants[0] && variants[0].inventoryPolicy !== "CONTINUE") problems.push(`policy ${variants[0].inventoryPolicy}`);
  if (!detail.tags.includes("configurator-pilot")) problems.push("missing configurator-pilot tag");
  if (detail.productType !== "DTP Pouches") problems.push(`productType "${detail.productType}"`);
  if (detail.templateSuffix !== "configurator-pilot") problems.push(`templateSuffix ${detail.templateSuffix}`);
  const row = await db.configuratorProduct.findFirst({ where: { shop: SHOP, productType: target.type } });
  if (!row) problems.push("ERP row missing");
  else {
    if (row.shopifyVariantGid !== variants[0]?.id) problems.push("ERP variant GID mismatch");
    if (row.minQuantity !== DTP_MIN_QTY) problems.push(`ERP minQuantity ${row.minQuantity}`);
    if (!row.active) problems.push("ERP row inactive");
  }
  return { detail, ok: problems.length === 0, problems };
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const session = await db.session.findFirst({ where: { shop: SHOP }, orderBy: { id: "asc" } });
  const token = session.accessToken;

  if (ROLLBACK) {
    if (!existsSync(ROLLBACK_FILE)) throw new Error("No 16E rollback artifact found.");
    const artifact = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
    for (const entry of artifact.products) {
      if (entry.created) {
        // created products are never deleted — re-draft + deactivate the ERP row
        const result = await gql(token, `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id status } userErrors { field message } } }`, { p: { id: entry.id, status: "DRAFT" } });
        requireClean(`${entry.handle} re-draft`, result.productUpdate);
        await db.configuratorProduct.updateMany({ where: { shop: SHOP, shopifyProductGid: entry.id, notes: { contains: MARKER } }, data: { active: false } });
        console.log(`re-drafted created product ${entry.handle} (ERP row deactivated; product kept)`);
        continue;
      }
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
      const result = await gql(token, `mutation($input: ProductSetInput!) { productSet(input: $input, synchronous: true) { product { id status variantsCount { count } } userErrors { field message } } }`, { input });
      const errors = result.productSet?.userErrors || [];
      if (errors.length) { console.log(`FAIL ${entry.handle}: ${JSON.stringify(errors).slice(0, 250)}`); continue; }
      await db.configuratorProduct.updateMany({ where: { shop: SHOP, shopifyProductGid: entry.id, notes: { contains: MARKER } }, data: { active: false } });
      console.log(`restored ${entry.handle} -> ${result.productSet.product.status}, ${result.productSet.product.variantsCount.count} variants (ERP row deactivated)`);
      await sleep(400);
    }
    return;
  }

  if (ACTIVATE) {
    let activated = 0;
    let blocked = 0;
    for (const [handle, target] of Object.entries(TARGETS)) {
      const verdict = await verifyCanonical(token, handle, target);
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
    console.log(`\nACTIVE: ${activated}/${Object.keys(TARGETS).length}${blocked ? ` | media-blocked: ${blocked}` : ""}`);
    return;
  }

  for (const [handle, target] of Object.entries(TARGETS)) {
    const detail = await detailFor(token, handle, true);

    if (!detail && !target.existing) {
      console.log(`${EXECUTE ? "CREATE" : "[dry] would create"} ${handle} ("${target.title}", DRAFT, single 1.00 variant, tag+type+template, ERP ${target.type} minQ ${DTP_MIN_QTY})`);
      if (!EXECUTE) continue;
      const result = await gql(token, `mutation($input: ProductSetInput!) { productSet(input: $input, synchronous: true) {
        product { id handle status variantsCount { count } } userErrors { field message } } }`, {
        input: {
          title: target.title,
          handle,
          status: "DRAFT",
          productType: "DTP Pouches",
          vendor: "GSO Packaging",
          templateSuffix: "configurator-pilot",
          tags: ["configurator-pilot"],
          productOptions: [{ name: "Title", position: 1, values: [{ name: "Default Title" }] }],
          variants: [{ optionValues: [{ optionName: "Title", name: "Default Title" }], price: "1.00", inventoryPolicy: "CONTINUE" }],
        },
      });
      requireClean(`${handle} create`, result.productSet);
      appendRollback({ handle, id: result.productSet.product.id, created: true });
      const fresh = await detailFor(token, handle);
      await upsertErpRow(fresh, target);
      const verdict = await verifyCanonical(token, handle, target);
      console.log(`  ${handle}: ${verdict.ok ? "CREATED + VERIFIED (media 0 — activation media-gated)" : "VERIFY FAILED: " + verdict.problems.join("; ")}`);
      if (!verdict.ok) process.exitCode = 1;
      await sleep(300);
      continue;
    }
    if (!detail) throw new Error(`${handle}: expected existing product — STOP.`);

    const already = detail.tags.includes("configurator-pilot") && detail.variants.nodes.length === 1;
    if (!already && target.existing) {
      if (detail.status !== "DRAFT") throw new Error(`${handle}: status ${detail.status} (expected DRAFT) — STOP.`);
      if (detail.variants.nodes.length < 2) throw new Error(`${handle}: ${detail.variants.nodes.length} variants — STOP.`);
    }
    const plan = already ? "converge (already canonical)" : `keep pos-1 variant, delete ${detail.variants.nodes.length - 1} variants + ${detail.options.length} options`;
    console.log(`${EXECUTE ? "REBUILD" : "[dry]"} ${handle} (${detail.status}, ${detail.variants.nodes.length} variants, media ${detail.mediaCount?.count ?? 0}): ${plan}; +tag +type "DTP Pouches" +tmpl configurator-pilot +ERP ${target.type}`);
    if (!EXECUTE) continue;

    appendRollback({
      handle,
      id: detail.id,
      created: false,
      previousStatus: detail.status,
      previousProductType: detail.productType ?? "",
      previousTemplateSuffix: detail.templateSuffix ?? null,
      previousTags: [...(detail.tags || [])],
      options: (detail.options || []).map((option) => ({ id: option.id, name: option.name, position: option.position, values: [...option.values] })),
      variants: detail.variants.nodes.map((variant) => ({
        id: variant.id, title: variant.title, position: variant.position, price: variant.price,
        compareAtPrice: variant.compareAtPrice ?? null, barcode: variant.barcode ?? null,
        sku: variant.inventoryItem?.sku ?? null, inventoryPolicy: variant.inventoryPolicy ?? null,
        selectedOptions: variant.selectedOptions.map((so) => ({ name: so.name, value: so.value })),
      })),
    });

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
    if (current.productType !== "DTP Pouches" || current.templateSuffix !== "configurator-pilot") {
      const result = await gql(token, `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id } userErrors { field message } } }`, { p: { id: current.id, productType: "DTP Pouches", templateSuffix: "configurator-pilot" } });
      requireClean(`${handle} type/template`, result.productUpdate);
      await sleep(300);
    }
    const fresh = await detailFor(token, handle);
    await upsertErpRow(fresh, target);
    const verdict = await verifyCanonical(token, handle, target);
    console.log(`  ${handle}: ${verdict.ok ? `VERIFIED (media ${verdict.detail.mediaCount?.count ?? 0}; activation via --activate)` : "VERIFY FAILED: " + verdict.problems.join("; ")}`);
    if (!verdict.ok) process.exitCode = 1;
    await sleep(300);
  }

  if (!EXECUTE) console.log(`\nDRY RUN ONLY — no writes. Targets: ${Object.keys(TARGETS).join(", ")}`);
}

main()
  .catch((error) => { console.error("ERROR:", error.message || error); process.exit(1); })
  .finally(() => db.$disconnect());
