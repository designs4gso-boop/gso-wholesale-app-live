// Phase 16F — create the canonical sticker/label launch products.
// Two products, both dimension-driven through the canonical sticker engine
// (the SAME ERP cost + commercial policy pipeline the Cost Calculator uses):
//   custom-stickers   -> sticker_regular  (square/rectangle cut)
//   die-cut-stickers  -> sticker_die_cut  (kiss-cut contour + weeding)
// Both are CREATED as DRAFT single-variant products (1.00 CONTINUE
// placeholder, configurator-pilot tag/lockout, productType "Stickers",
// template configurator-pilot) with ERP ConfiguratorProduct rows (MOQ 50).
// --activate refuses 0-media products (no fabricated imagery) and any
// product failing canonical verification.
// The legacy 4x5-sticker-bag / 14x16-sticker-bag products are STICKER-BAG
// products (label-applied bags), NOT sticker products — they stay DRAFT and
// are never touched by this tool.
//
//   node tools/rebuild-stickers-16f.mjs               dry run
//   node tools/rebuild-stickers-16f.mjs --execute     create (stays DRAFT)
//   node tools/rebuild-stickers-16f.mjs --activate    activate verified products WITH media
//   node tools/rebuild-stickers-16f.mjs --rollback    re-draft created products
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const EXECUTE = process.argv.includes("--execute");
const ACTIVATE = process.argv.includes("--activate");
const ROLLBACK = process.argv.includes("--rollback");
const SHOP = "942075-2.myshopify.com";
const DATA_DIR = path.join("tools", "rebuild-16c-data");
const ROLLBACK_FILE = path.join(DATA_DIR, "rollback-16f-stickers.json");
const MARKER = "16F sticker canonical launch";
const STICKER_MIN_QTY = 50;

const TARGETS = {
  "custom-stickers": { type: "sticker_regular", title: "Custom Stickers" },
  "die-cut-stickers": { type: "sticker_die_cut", title: "Die-Cut Stickers" },
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
  id handle title status productType templateSuffix tags
  mediaCount { count }
  options { id name }
  variants(first: 5) { nodes { id price inventoryPolicy inventoryItem { sku } } }
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

async function verifyCanonical(token, handle, target) {
  const detail = await detailFor(token, handle);
  const problems = [];
  const variants = detail.variants.nodes;
  if (variants.length !== 1) problems.push(`${variants.length} variants`);
  if (variants[0] && Number(variants[0].price) !== 1) problems.push(`price ${variants[0].price}`);
  if (variants[0] && variants[0].inventoryPolicy !== "CONTINUE") problems.push(`policy ${variants[0].inventoryPolicy}`);
  if (!detail.tags.includes("configurator-pilot")) problems.push("missing configurator-pilot tag");
  if (detail.productType !== "Stickers") problems.push(`productType "${detail.productType}"`);
  if (detail.templateSuffix !== "configurator-pilot") problems.push(`templateSuffix ${detail.templateSuffix}`);
  const row = await db.configuratorProduct.findFirst({ where: { shop: SHOP, productType: target.type } });
  if (!row) problems.push("ERP row missing");
  else {
    if (row.shopifyVariantGid !== variants[0]?.id) problems.push("ERP variant GID mismatch");
    if (row.minQuantity !== STICKER_MIN_QTY) problems.push(`ERP minQuantity ${row.minQuantity}`);
    if (!row.active) problems.push("ERP row inactive");
  }
  return { detail, ok: problems.length === 0, problems };
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  const session = await db.session.findFirst({ where: { shop: SHOP }, orderBy: { id: "asc" } });
  const token = session.accessToken;

  if (ROLLBACK) {
    if (!existsSync(ROLLBACK_FILE)) throw new Error("No 16F rollback artifact found.");
    const artifact = JSON.parse(readFileSync(ROLLBACK_FILE, "utf8"));
    for (const entry of artifact.products) {
      const result = await gql(token, `mutation($p: ProductUpdateInput!) { productUpdate(product: $p) { product { id status } userErrors { field message } } }`, { p: { id: entry.id, status: "DRAFT" } });
      requireClean(`${entry.handle} re-draft`, result.productUpdate);
      await db.configuratorProduct.updateMany({ where: { shop: SHOP, shopifyProductGid: entry.id, notes: { contains: MARKER } }, data: { active: false } });
      console.log(`re-drafted ${entry.handle} (ERP row deactivated; product kept)`);
      await sleep(250);
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
    const existing = await detailFor(token, handle, true);
    if (existing) {
      console.log(`${EXECUTE ? "CONVERGE" : "[dry]"} ${handle}: already exists (${existing.status}) — verifying + updating ERP row only`);
      if (!EXECUTE) continue;
    } else {
      console.log(`${EXECUTE ? "CREATE" : "[dry] would create"} ${handle} ("${target.title}", DRAFT, single 1.00 variant, tag+type Stickers+tmpl configurator-pilot, ERP ${target.type} minQ ${STICKER_MIN_QTY})`);
      if (!EXECUTE) continue;
      const result = await gql(token, `mutation($input: ProductSetInput!) { productSet(input: $input, synchronous: true) {
        product { id handle status } userErrors { field message } } }`, {
        input: {
          title: target.title,
          handle,
          status: "DRAFT",
          productType: "Stickers",
          vendor: "GSO Packaging",
          templateSuffix: "configurator-pilot",
          tags: ["configurator-pilot"],
          productOptions: [{ name: "Title", position: 1, values: [{ name: "Default Title" }] }],
          variants: [{ optionValues: [{ optionName: "Title", name: "Default Title" }], price: "1.00", inventoryPolicy: "CONTINUE" }],
        },
      });
      requireClean(`${handle} create`, result.productSet);
      appendRollback({ handle, id: result.productSet.product.id, created: true });
      await sleep(300);
    }
    const fresh = await detailFor(token, handle);
    const variantGid = fresh.variants.nodes[0].id;
    const erpExisting = await db.configuratorProduct.findFirst({ where: { shop: SHOP, OR: [{ productType: target.type }, { title: target.title }] } });
    const data = {
      title: target.title,
      shopifyProductGid: fresh.id,
      shopifyVariantGid: variantGid,
      shopifyHandle: handle,
      sku: fresh.variants.nodes[0].inventoryItem?.sku ?? null,
      productType: target.type,
      defaultSides: "Double Sided",
      minQuantity: STICKER_MIN_QTY,
      pilot: true,
      active: true,
      notes: `${MARKER}: dimension-driven canonical sticker pricing (ERP cost engine + owner margin/floor policy); ${target.type === "sticker_die_cut" ? "kiss-cut contour + weeding" : "square/rectangle cut"}; MOQ ${STICKER_MIN_QTY}.`,
    };
    if (erpExisting) {
      if (erpExisting.shopifyProductGid && erpExisting.shopifyProductGid !== fresh.id) throw new Error(`${handle}: ConfiguratorProduct collision (${erpExisting.id}) — STOP`);
      await db.configuratorProduct.update({ where: { id: erpExisting.id }, data });
    } else {
      await db.configuratorProduct.create({ data: { shop: SHOP, ...data } });
    }
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
