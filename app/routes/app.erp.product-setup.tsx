import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PRODUCT_FAMILIES = ["Labels", "Sticker Bags", "DTP Bags", "Boxes", "DTF / Apparel"];
const PRODUCTION_MODES = ["in_house", "outsourced", "hybrid"];
const UNIT_OPTIONS = ["each", "sqft", "sqin", "ml", "hour"];

function slugify(value: string) {
  return String(value || "template")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "template";
}

function numberValue(value: FormDataEntryValue | null, fallback = 0) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intValue(value: FormDataEntryValue | null, fallback = 0) {
  const parsed = parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money(value: any) {
  return `$${(Number(value) || 0).toFixed(2)}`;
}

function pct(value: any) {
  return `${(Number(value) || 0).toFixed(1)}%`;
}

function parseTiers(value: any) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function tiersToText(tiers: any[]) {
  if (!tiers?.length) return "";
  return tiers
    .map((tier) => {
      const range = tier.maxQty ? `${tier.minQty}-${tier.maxQty}` : `${tier.minQty}+`;
      const mode = tier.fixedPrice ? `$${tier.fixedPrice}` : `${tier.marginPct ?? 50}%`;
      return `${range}: ${mode}`;
    })
    .join("\n");
}

function parseTierText(text: string, fallbackMargin = 50) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rangeRaw, valueRaw] = line.split(":").map((part) => part?.trim());
      const range = rangeRaw || "1+";
      const value = valueRaw || `${fallbackMargin}`;
      let minQty = 1;
      let maxQty: number | null = null;
      if (range.includes("-")) {
        const [min, max] = range.split("-");
        minQty = Math.max(1, parseInt(min, 10) || 1);
        maxQty = Math.max(minQty, parseInt(max, 10) || minQty);
      } else {
        minQty = Math.max(1, parseInt(range.replace("+", ""), 10) || 1);
      }
      const isFixed = value.includes("$");
      const numeric = Number(value.replace(/[^0-9.]/g, ""));
      return {
        minQty,
        maxQty,
        marginPct: isFixed ? null : (Number.isFinite(numeric) ? numeric : fallbackMargin),
        fixedPrice: isFixed ? (Number.isFinite(numeric) ? numeric : null) : null,
      };
    })
    .sort((a, b) => a.minQty - b.minQty);
}

function templateForFamily(family: string) {
  if (family === "Labels") {
    return [
      { minQty: 64, maxQty: 199, marginPct: 70, fixedPrice: null },
      { minQty: 200, maxQty: 499, marginPct: 65, fixedPrice: null },
      { minQty: 500, maxQty: 999, marginPct: 60, fixedPrice: null },
      { minQty: 1000, maxQty: 2499, marginPct: 55, fixedPrice: null },
      { minQty: 2500, maxQty: 4999, marginPct: 50, fixedPrice: null },
      { minQty: 5000, maxQty: null, marginPct: 45, fixedPrice: null },
    ];
  }
  if (family === "Sticker Bags") {
    return [
      { minQty: 64, maxQty: 199, marginPct: 70, fixedPrice: null },
      { minQty: 200, maxQty: 499, marginPct: 65, fixedPrice: null },
      { minQty: 500, maxQty: 999, marginPct: 60, fixedPrice: null },
      { minQty: 1000, maxQty: 2499, marginPct: 55, fixedPrice: null },
      { minQty: 2500, maxQty: null, marginPct: 50, fixedPrice: null },
    ];
  }
  if (family === "Boxes" || family === "DTP Bags") {
    return [
      { minQty: 500, maxQty: 999, marginPct: 45, fixedPrice: null },
      { minQty: 1000, maxQty: 2499, marginPct: 40, fixedPrice: null },
      { minQty: 2500, maxQty: 4999, marginPct: 35, fixedPrice: null },
      { minQty: 5000, maxQty: 9999, marginPct: 32, fixedPrice: null },
      { minQty: 10000, maxQty: null, marginPct: 30, fixedPrice: null },
    ];
  }
  return [
    { minQty: 1, maxQty: 99, marginPct: 70, fixedPrice: null },
    { minQty: 100, maxQty: 499, marginPct: 60, fixedPrice: null },
    { minQty: 500, maxQty: null, marginPct: 50, fixedPrice: null },
  ];
}

const APPROVED_TEMPLATE_KEYS = PRODUCT_FAMILIES.map((family) => slugify(family));
const UNAPPROVED_TEMPLATE_HINTS = [
  "stock_bags",
  "stock_bag",
  "sourced_products",
  "sourced_product",
  "die_cut_bags",
  "die_cut",
  "general",
  "bag_box_combo",
  "combo",
];

function approvedTemplateName(family: string) {
  return `${family} Pricing Template`;
}

async function archiveDuplicateAndUnapprovedTemplates(shop: string) {
  const allTemplates = await db.productTypeProfile.findMany({ where: { shop }, orderBy: { createdAt: "asc" } });
  const approvedKeys = new Set(APPROVED_TEMPLATE_KEYS);
  const canonicalByKey = new Map<string, string>();

  for (const family of PRODUCT_FAMILIES) {
    const key = slugify(family);
    const existing = allTemplates.find((template: any) => template.key === key);
    if (existing) canonicalByKey.set(key, existing.id);
  }

  for (const template of allTemplates as any[]) {
    const key = String(template.key || "");
    const nameKey = slugify(template.name || "");
    const isApprovedCanonical = approvedKeys.has(key) && canonicalByKey.get(key) === template.id;
    const isUnapproved = !approvedKeys.has(key) || UNAPPROVED_TEMPLATE_HINTS.some((hint) => key.includes(hint) || nameKey.includes(hint));
    const isDuplicateApprovedName = PRODUCT_FAMILIES.some((family) => {
      const familyKey = slugify(family);
      return nameKey.includes(familyKey) && key !== familyKey;
    });

    if (!isApprovedCanonical && (isUnapproved || isDuplicateApprovedName)) {
      await db.productTypeProfile.update({
        where: { id: template.id },
        data: {
          active: false,
          notes: `${template.notes || ""}\nArchived by template cleanup. Approved families: ${PRODUCT_FAMILIES.join(", ")}.`.trim(),
        },
      });
    }
  }
}

async function createDefaultTemplates(shop: string) {
  for (const family of PRODUCT_FAMILIES) {
    const tiers = templateForFamily(family);
    const key = slugify(family);
    await db.productTypeProfile.upsert({
      where: { shop_key: { shop, key } },
      create: {
        shop,
        key,
        name: `${family} Pricing Template`,
        productionMode: family === "Boxes" || family === "DTP Bags" ? "outsourced" : "in_house",
        minQuantity: tiers[0]?.minQty || 1,
        defaultQuantity: family === "Labels" || family === "Sticker Bags" ? 250 : 1000,
        tierBreakpoints: tiers.map((tier) => tier.minQty).join(","),
        tierTemplate: JSON.stringify(tiers),
        defaultMarginPct: Number(tiers[0]?.marginPct || 50),
        pricingMethod: "auto_margin",
        notes: "Approved default GSO pricing template. Edit tier margins as real cost data improves.",
        active: true,
      },
      update: {
        name: approvedTemplateName(family),
        productionMode: family === "Boxes" || family === "DTP Bags" ? "outsourced" : "in_house",
        minQuantity: tiers[0]?.minQty || 1,
        defaultQuantity: family === "Labels" || family === "Sticker Bags" ? 250 : 1000,
        tierBreakpoints: tiers.map((tier) => tier.minQty).join(","),
        tierTemplate: JSON.stringify(tiers),
        defaultMarginPct: Number(tiers[0]?.marginPct || 50),
        pricingMethod: "auto_margin",
        active: true,
      },
    });
  }
  await archiveDuplicateAndUnapprovedTemplates(shop);
}

function unitCost(material: any) {
  return Number(material?.calculatedUnitCost || material?.costPerUnit || material?.purchaseCost || 0);
}

function zoneSqft(zone: any) {
  const width = Number(zone.widthIn || 0);
  const height = Number(zone.heightIn || 0);
  const count = Number(zone.qtyPerUnit || 1);
  return (width * height * count) / 144;
}

function materialForZone(zone: any, allZones: any[] = []) {
  if (zone.mediaMode === "media_option" && zone.mediaOption?.material) return zone.mediaOption.material;
  if (zone.mediaMode === "same_as_zone") {
    const source = allZones.find((candidate: any) => candidate.id === zone.sameAsZoneId) || allZones.find((candidate: any) => candidate.position === "Front") || allZones.find((candidate: any) => candidate.id !== zone.id);
    if (source) return materialForZone(source, allZones);
  }
  return zone.material;
}

function mediaLabelForZone(zone: any, allZones: any[] = []) {
  if (zone.mediaMode === "same_as_zone") {
    const source = allZones.find((candidate: any) => candidate.id === zone.sameAsZoneId) || allZones.find((candidate: any) => candidate.position === "Front");
    return source ? `Same as ${source.name}` : "Same as front";
  }
  if (zone.mediaMode === "media_option") return zone.mediaOption?.name || "Media option";
  return materialForZone(zone, allZones)?.name || "No material selected";
}

function estimateRecipe(recipe: any, laborRate = 25) {
  const qty = Math.max(1, Number(recipe.defaultQuantity || recipe.minQuantity || 1));
  const activeMaterialRows = (recipe.materials || []).filter((row: any) => row.active !== false);
  const activeZones = (recipe.labelZones || []).filter((zone: any) => zone.active !== false);
  const materialRowCostPerUnit = activeMaterialRows.reduce((sum: number, row: any) => {
    const base = unitCost(row.material);
    const quantity = Number(row.quantity || 0);
    const wasteMultiplier = row.includeWaste ? 1 + (Number(row.wastePct || 0) / 100) : 1;
    return sum + base * quantity * wasteMultiplier;
  }, 0);
  const zones = activeZones;
  const labelSqftPerUnit = zones.reduce((sum: number, zone: any) => sum + zoneSqft(zone), 0);
  const labelMediaCostPerUnit = zones.reduce((sum: number, zone: any) => {
    const base = unitCost(materialForZone(zone, zones));
    const wasteMultiplier = 1 + (Number(recipe.wastePct || 0) / 100);
    return sum + base * zoneSqft(zone) * wasteMultiplier;
  }, 0);
  const labelApplicationSecondsPerUnit = zones.reduce((sum: number, zone: any) => sum + (Number(zone.applicationSecondsPerLabel || 0) * Number(zone.qtyPerUnit || 1)), 0);
  const materialCostPerUnit = materialRowCostPerUnit + labelMediaCostPerUnit;
  const fallbackApplicationSecondsPerUnit = activeZones.length ? 0 : Number(recipe.applicationLaborSecondsPerUnit || 0);
  const perUnitLaborSeconds = fallbackApplicationSecondsPerUnit + Number(recipe.packingLaborSecondsPerUnit || 0) + labelApplicationSecondsPerUnit;
  const perUnitLaborCost = (perUnitLaborSeconds / 3600) * laborRate;
  const perJobLaborCost = ((Number(recipe.laborMinutes || 0) + Number(recipe.prepressMinutes || 0)) / 60) * laborRate / qty;
  const setupCostPerUnit = Number(recipe.setupCost || 0) / qty;
  const unitCostTotal = materialCostPerUnit + perUnitLaborCost + perJobLaborCost + setupCostPerUnit;
  const margin = Number(recipe.targetMarginPct || 50);
  const suggestedPrice = margin >= 99 ? unitCostTotal : unitCostTotal / (1 - margin / 100);
  return { qty, materialCostPerUnit, materialRowCostPerUnit, labelMediaCostPerUnit, labelSqftPerUnit, labelApplicationSecondsPerUnit, perUnitLaborCost, perJobLaborCost, setupCostPerUnit, unitCostTotal, suggestedPrice };
}

function priceFromMargin(cost: number, marginPct: number) {
  if (marginPct >= 99) return cost;
  return cost / (1 - marginPct / 100);
}


function findOption(options: any[], id?: string | null) {
  return (options || []).find((option: any) => option.id === id);
}

function mediaOptionLabel(options: any[], id?: string | null) {
  const option = findOption(options, id);
  return option ? `${option.name} (${option.material?.name || "material"})` : "Default / not selected";
}

function estimateVariantFromRule(recipe: any, rule: any) {
  const baseEstimate = estimateRecipe(recipe);
  const zones = (recipe.labelZones || []).filter((zone: any) => zone.active !== false);
  const frontZone = zones.find((zone: any) => String(zone.position || zone.name || "").toLowerCase().includes("front")) || zones[0];
  const backZone = zones.find((zone: any) => String(zone.position || zone.name || "").toLowerCase().includes("back")) || zones[1];
  const useFront = rule.useFrontZone !== false && frontZone;
  const useBack = rule.useBackZone === true && backZone;
  const selectedZones = [useFront ? frontZone : null, useBack ? backZone : null].filter(Boolean);
  const area = selectedZones.reduce((sum: number, zone: any) => sum + zoneAreaSqft(zone), 0);
  const applySeconds = selectedZones.reduce((sum: number, zone: any) => sum + (Number(zone.applicationSecondsPerLabel || 0) * Number(zone.qtyPerUnit || 1)), 0);
  const mediaOptions = recipe.mediaOptions || [];
  const frontOption = findOption(mediaOptions, rule.frontMediaOptionId) || mediaOptions.find((option: any) => option.defaultOption && option.active !== false) || mediaOptions.find((option: any) => option.active !== false);
  const backOption = rule.backMediaMode === "specific" ? findOption(mediaOptions, rule.backMediaOptionId) : frontOption;
  const mediaCost = selectedZones.reduce((sum: number, zone: any) => {
    const option = zone === backZone ? backOption : frontOption;
    const material = option?.material || zone?.mediaOption?.material || zone?.material;
    return sum + zoneAreaSqft(zone) * unitCost(material);
  }, 0) * (1 + Number(recipe.wastePct || 0) / 100);
  const originalZoneCost = Number(baseEstimate.labelMediaCostPerUnit || 0);
  const originalApplySeconds = Number(baseEstimate.labelApplicationSecondsPerUnit || 0);
  const laborRatePerHour = 20;
  const applyLaborDelta = ((applySeconds - originalApplySeconds) / 3600) * laborRatePerHour;
  const unitCost = Number(baseEstimate.unitCostTotal || 0) - originalZoneCost + mediaCost + applyLaborDelta;
  const price = priceFromMargin(unitCost, Number(recipe.targetMarginPct || 60));
  return { area, applySeconds, mediaCost, unitCost, price };
}


function normalizeVariantText(value: any) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function selectedOptionsText(selectedOptions: any[] = []) {
  return selectedOptions
    .map((option: any) => `${option?.name || ""}: ${option?.value || ""}`)
    .join(" / ");
}

function matchesAny(value: string, terms: string[]) {
  const normalized = normalizeVariantText(value);
  return terms.some((term) => normalized.includes(normalizeVariantText(term)));
}

function pickSideModeFromVariantText(text: string) {
  const normalized = normalizeVariantText(text);
  if (matchesAny(normalized, ["single sided", "single side", "1 sided", "1 side", "one sided", "front only"])) {
    return { sideMode: "single", useFrontZone: true, useBackZone: false, backMediaMode: "none" };
  }
  if (matchesAny(normalized, ["double sided", "double side", "2 sided", "2 side", "two sided", "front and back", "both sides"])) {
    return { sideMode: "double_same", useFrontZone: true, useBackZone: true, backMediaMode: "same_as_front" };
  }
  return { sideMode: "single", useFrontZone: true, useBackZone: false, backMediaMode: "none" };
}

function mediaAliasesForOption(option: any) {
  const name = String(option?.name || "");
  const materialName = String(option?.material?.name || "");
  const aliases = [name, materialName];

  if (/holo|holographic/i.test(`${name} ${materialName}`)) aliases.push("holo", "holographic", "hologram");
  if (/matte|matt/i.test(`${name} ${materialName}`)) aliases.push("matte", "matt");
  if (/gloss/i.test(`${name} ${materialName}`)) aliases.push("gloss", "glossy");
  if (/clear/i.test(`${name} ${materialName}`)) aliases.push("clear", "transparent");
  if (/chrome|silver/i.test(`${name} ${materialName}`)) aliases.push("chrome", "silver");

  return aliases.filter(Boolean);
}

function pickMediaOptionFromVariantText(text: string, mediaOptions: any[] = []) {
  const activeOptions = (mediaOptions || []).filter((option: any) => option.active !== false);
  const normalized = normalizeVariantText(text);

  for (const option of activeOptions) {
    if (mediaAliasesForOption(option).some((alias) => normalized.includes(normalizeVariantText(alias)))) {
      return option;
    }
  }

  return activeOptions.find((option: any) => option.defaultOption) || activeOptions[0] || null;
}

function pickBagColorFromSelectedOptions(selectedOptions: any[] = [], text = "") {
  const colorTerms = [
    "black", "white", "clear", "gold", "silver", "red", "blue", "green", "purple", "pink",
    "orange", "yellow", "brown", "kraft", "mylar", "mixed", "assorted"
  ];

  for (const option of selectedOptions || []) {
    const name = normalizeVariantText(option?.name);
    const value = String(option?.value || "").trim();
    const normalizedValue = normalizeVariantText(value);
    if (!value) continue;
    if (name.includes("color") || name.includes("colour") || name.includes("bag")) return value;
    if (colorTerms.some((color) => normalizedValue === normalizeVariantText(color) || normalizedValue.includes(normalizeVariantText(color)))) return value;
  }

  const normalizedText = normalizeVariantText(text);
  const found = colorTerms.find((color) => normalizedText.includes(normalizeVariantText(color)));
  return found ? found.replace(/\b\w/g, (char) => char.toUpperCase()) : "Any";
}

function autoMapShopifyVariant(variant: any, recipe: any) {
  const selectedOptions = variant?.selectedOptions || [];
  const text = `${variant?.title || ""} / ${selectedOptionsText(selectedOptions)} / ${variant?.sku || ""}`;
  const side = pickSideModeFromVariantText(text);
  const mediaOption = pickMediaOptionFromVariantText(text, recipe?.mediaOptions || []);
  const bagColor = pickBagColorFromSelectedOptions(selectedOptions, text);

  const needsReview: string[] = [];
  if (!mediaOption) needsReview.push("media option");
  if (bagColor === "Any" && matchesAny(text, ["color", "colour", "bag color"])) needsReview.push("bag color");

  return {
    name: variant?.title ? `Auto - ${variant.title}` : "Auto-mapped Shopify variant",
    shopifyVariantTitle: variant?.title || "",
    sku: variant?.sku || "",
    sideMode: side.sideMode,
    bagColor,
    frontMediaOptionId: mediaOption?.id || null,
    backMediaMode: side.backMediaMode,
    backMediaOptionId: null,
    useFrontZone: side.useFrontZone,
    useBackZone: side.useBackZone,
    notes: needsReview.length
      ? `Auto-synced from Shopify. Needs review: ${needsReview.join(", ")}. Quantities are handled by pricing templates, not Shopify variants.`
      : "Auto-synced from Shopify variant options. Quantities are handled by pricing templates, not Shopify variants.",
  };
}

async function fetchShopifyProductVariants(admin: any, productGid: string) {
  const response = await admin.graphql(
    `#graphql
      query ProductRecipeVariantSync($id: ID!) {
        product(id: $id) {
          id
          title
          handle
          options {
            name
            values
          }
          variants(first: 100) {
            edges {
              node {
                id
                title
                sku
                price
                selectedOptions {
                  name
                  value
                }
              }
            }
          }
        }
      }
    `,
    { variables: { id: productGid } }
  );

  const payload = await response.json();
  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error: any) => error.message).join(", "));
  }

  const product = payload?.data?.product;
  return {
    product,
    variants: product?.variants?.edges?.map((edge: any) => edge.node) || [],
  };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const recipeStatus = url.searchParams.get("recipeStatus") || "active";
  const recipeSearch = (url.searchParams.get("recipeSearch") || "").trim();
  const itemStatus = url.searchParams.get("itemStatus") || "active";
  const recipeWhere: any = { shop };
  if (recipeStatus === "active") recipeWhere.active = true;
  if (recipeStatus === "archived") recipeWhere.active = false;
  if (recipeSearch) {
    recipeWhere.OR = [
      { name: { contains: recipeSearch, mode: "insensitive" } },
      { sku: { contains: recipeSearch, mode: "insensitive" } },
      { productFamily: { contains: recipeSearch, mode: "insensitive" } },
    ];
  }

  const [templates, recipes, materials, machines] = await Promise.all([
    db.productTypeProfile.findMany({ where: { shop }, orderBy: [{ active: "desc" }, { name: "asc" }] }),
    db.productRecipe.findMany({
      where: recipeWhere,
      orderBy: [{ active: "desc" }, { updatedAt: "desc" }],
      include: {
        productTypeProfile: true,
        materials: { include: { material: true }, orderBy: { createdAt: "asc" } },
        labelZones: { include: { material: true, mediaOption: { include: { material: true } } }, orderBy: { createdAt: "asc" } },
        mediaOptions: { include: { material: true }, orderBy: [{ active: "desc" }, { name: "asc" }] },
        tiers: { orderBy: { minQty: "asc" } },
        machineRules: { include: { preferredMachine: true } },
        variantRules: { orderBy: [{ active: "desc" }, { name: "asc" }] },
      },
    }),
    db.material.findMany({ where: { shop, active: true, useInRecipes: true }, orderBy: { name: "asc" } }),
    db.machine.findMany({ where: { shop, active: true }, orderBy: { name: "asc" } }),
  ]);

  const activeTemplates = templates.filter((template: any) => template.active);
  return Response.json({ templates, activeTemplates, recipes, materials, machines, recipeStatus, recipeSearch, itemStatus });
}

export async function action({ request }: { request: Request }) {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "seedTemplates") {
    await createDefaultTemplates(shop);
    return Response.json({ ok: true, message: "Approved pricing templates created/refreshed and old duplicates archived." });
  }

  if (intent === "cleanupTemplates") {
    await archiveDuplicateAndUnapprovedTemplates(shop);
    return Response.json({ ok: true, message: "Duplicate and unapproved pricing templates archived." });
  }

  if (intent === "createTemplate") {
    const name = String(formData.get("name") || "New Pricing Template").trim();
    const family = String(formData.get("family") || "Labels");
    const tiers = parseTierText(String(formData.get("tiers") || ""), numberValue(formData.get("defaultMarginPct"), 50));
    const key = `custom_${slugify(family)}_${slugify(name)}_${Date.now()}`.slice(0, 80);
    await db.productTypeProfile.create({
      data: {
        shop,
        key,
        name,
        productionMode: String(formData.get("productionMode") || "in_house"),
        minQuantity: intValue(formData.get("minQuantity"), tiers[0]?.minQty || 1),
        defaultQuantity: intValue(formData.get("defaultQuantity"), 250),
        tierBreakpoints: tiers.map((tier) => tier.minQty).join(","),
        tierTemplate: JSON.stringify(tiers),
        defaultMarginPct: numberValue(formData.get("defaultMarginPct"), 50),
        pricingMethod: "auto_margin",
        notes: String(formData.get("notes") || "") || null,
        active: true,
      },
    });
    return Response.json({ ok: true, message: "Pricing template created." });
  }

  if (intent === "updateTemplate") {
    const id = String(formData.get("templateId") || "");
    const tiers = parseTierText(String(formData.get("tiers") || ""), numberValue(formData.get("defaultMarginPct"), 50));
    await db.productTypeProfile.updateMany({
      where: { shop, id },
      data: {
        name: String(formData.get("name") || "Pricing Template"),
        productionMode: String(formData.get("productionMode") || "in_house"),
        minQuantity: intValue(formData.get("minQuantity"), tiers[0]?.minQty || 1),
        defaultQuantity: intValue(formData.get("defaultQuantity"), 250),
        tierBreakpoints: tiers.map((tier) => tier.minQty).join(","),
        tierTemplate: JSON.stringify(tiers),
        defaultMarginPct: numberValue(formData.get("defaultMarginPct"), 50),
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Pricing template updated." });
  }

  if (intent === "archiveTemplate") {
    await db.productTypeProfile.updateMany({ where: { shop, id: String(formData.get("templateId") || "") }, data: { active: false } });
    return Response.json({ ok: true, message: "Pricing template archived." });
  }

  if (intent === "restoreTemplate") {
    await db.productTypeProfile.updateMany({ where: { shop, id: String(formData.get("templateId") || "") }, data: { active: true } });
    return Response.json({ ok: true, message: "Pricing template restored." });
  }

  if (intent === "deleteTemplate") {
    const templateId = String(formData.get("templateId") || "");
    const usedCount = await db.productRecipe.count({ where: { shop, productTypeProfileId: templateId } });
    if (usedCount > 0) {
      await db.productTypeProfile.updateMany({ where: { shop, id: templateId }, data: { active: false } });
      return Response.json({ ok: true, message: "Template is used by recipes, so it was archived instead of deleted." });
    }
    await db.productTypeProfile.deleteMany({ where: { shop, id: templateId } });
    return Response.json({ ok: true, message: "Unused pricing template deleted." });
  }

  if (intent === "createRecipe") {
    const templateId = String(formData.get("templateId") || "") || null;
    const machineId = String(formData.get("machineId") || "") || null;
    const name = String(formData.get("name") || "New Product Recipe").trim();
    const family = String(formData.get("productFamily") || "Labels");
    const recipe = await db.productRecipe.create({
      data: {
        shop,
        name,
        sku: String(formData.get("sku") || "") || null,
        productType: slugify(family),
        productFamily: family,
        productTypeProfileId: templateId,
        pricingTemplateMode: String(formData.get("pricingTemplateMode") || "template"),
        productionMode: String(formData.get("productionMode") || "in_house"),
        productGid: String(formData.get("productGid") || "") || null,
        variantGid: String(formData.get("variantGid") || "") || null,
        minQuantity: intValue(formData.get("minQuantity"), 64),
        defaultQuantity: intValue(formData.get("defaultQuantity"), 250),
        targetMarginPct: numberValue(formData.get("targetMarginPct"), 60),
        wastePct: numberValue(formData.get("wastePct"), 15),
        setupCost: numberValue(formData.get("setupCost"), 0),
        laborMinutes: numberValue(formData.get("laborMinutes"), 0),
        prepressMinutes: numberValue(formData.get("prepressMinutes"), 0),
        applicationLaborSecondsPerUnit: numberValue(formData.get("applicationLaborSecondsPerUnit"), 0),
        packingLaborSecondsPerUnit: numberValue(formData.get("packingLaborSecondsPerUnit"), 0),
        costReviewNeeded: String(formData.get("costReviewNeeded") || "") === "on",
        useInQuotes: String(formData.get("useInQuotes") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
        active: true,
        machineRules: machineId ? { create: [{ shop, preferredMachineId: machineId, allowOverflow: true }] } : undefined,
      },
    });

    if (templateId) {
      const template = await db.productTypeProfile.findFirst({ where: { shop, id: templateId } });
      const tiers = parseTiers(template?.tierTemplate);
      if (tiers.length) {
        await db.recipeTier.createMany({
          data: tiers.map((tier: any) => ({
            shop,
            recipeId: recipe.id,
            minQty: Number(tier.minQty || 1),
            maxQty: tier.maxQty ? Number(tier.maxQty) : null,
            marginPct: tier.marginPct == null ? null : Number(tier.marginPct),
            fixedPrice: tier.fixedPrice == null ? null : Number(tier.fixedPrice),
          })),
        });
      }
    }

    return Response.json({ ok: true, message: "Product recipe created." });
  }

  if (intent === "updateRecipe") {
    const recipeId = String(formData.get("recipeId") || "");
    const machineId = String(formData.get("machineId") || "") || null;
    await db.productRecipe.updateMany({
      where: { shop, id: recipeId },
      data: {
        name: String(formData.get("name") || "Product Recipe"),
        sku: String(formData.get("sku") || "") || null,
        productFamily: String(formData.get("productFamily") || "Labels"),
        productType: slugify(String(formData.get("productFamily") || "Labels")),
        productTypeProfileId: String(formData.get("templateId") || "") || null,
        pricingTemplateMode: String(formData.get("pricingTemplateMode") || "template"),
        productionMode: String(formData.get("productionMode") || "in_house"),
        productGid: String(formData.get("productGid") || "") || null,
        variantGid: String(formData.get("variantGid") || "") || null,
        minQuantity: intValue(formData.get("minQuantity"), 64),
        defaultQuantity: intValue(formData.get("defaultQuantity"), 250),
        targetMarginPct: numberValue(formData.get("targetMarginPct"), 60),
        wastePct: numberValue(formData.get("wastePct"), 15),
        setupCost: numberValue(formData.get("setupCost"), 0),
        laborMinutes: numberValue(formData.get("laborMinutes"), 0),
        prepressMinutes: numberValue(formData.get("prepressMinutes"), 0),
        applicationLaborSecondsPerUnit: numberValue(formData.get("applicationLaborSecondsPerUnit"), 0),
        packingLaborSecondsPerUnit: numberValue(formData.get("packingLaborSecondsPerUnit"), 0),
        costReviewNeeded: String(formData.get("costReviewNeeded") || "") === "on",
        useInQuotes: String(formData.get("useInQuotes") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
      },
    });
    await db.recipeMachineRule.deleteMany({ where: { shop, recipeId } });
    if (machineId) {
      await db.recipeMachineRule.create({ data: { shop, recipeId, preferredMachineId: machineId, allowOverflow: true } });
    }
    return Response.json({ ok: true, message: "Product recipe updated." });
  }

  if (intent === "archiveRecipe") {
    await db.productRecipe.updateMany({ where: { shop, id: String(formData.get("recipeId") || "") }, data: { active: false, useInQuotes: false } });
    return Response.json({ ok: true, message: "Product recipe archived." });
  }

  if (intent === "restoreRecipe") {
    await db.productRecipe.updateMany({ where: { shop, id: String(formData.get("recipeId") || "") }, data: { active: true } });
    return Response.json({ ok: true, message: "Product recipe restored." });
  }

  if (intent === "deleteRecipeForever") {
    const recipeId = String(formData.get("recipeId") || "");
    await db.recipeMaterial.deleteMany({ where: { shop, recipeId } });
    await db.recipeLabelZone.deleteMany({ where: { shop, recipeId } });
    await db.recipeMediaOption.deleteMany({ where: { shop, recipeId } });
    await db.recipeInkRequirement.deleteMany({ where: { shop, recipeId } });
    await db.recipeMachineRule.deleteMany({ where: { shop, recipeId } });
    await db.recipeTier.deleteMany({ where: { shop, recipeId } });
    await db.recipeAddOn.deleteMany({ where: { shop, recipeId } });
    await db.sourcedCostTier.deleteMany({ where: { shop, recipeId } });
    await db.productRecipe.deleteMany({ where: { shop, id: recipeId } });
    return Response.json({ ok: true, message: "Product recipe permanently deleted." });
  }



  if (intent === "syncShopifyVariants") {
    const recipeId = String(formData.get("recipeId") || "");
    const productGid = String(formData.get("shopifyProductGid") || "").trim();

    if (!recipeId) return Response.json({ ok: false, message: "Missing recipe." }, { status: 400 });
    if (!productGid) return Response.json({ ok: false, message: "Add or paste the Shopify Product GID first." }, { status: 400 });

    const recipe = await db.productRecipe.findFirst({
      where: { shop, id: recipeId },
      include: { mediaOptions: { include: { material: true } } },
    });
    if (!recipe) return Response.json({ ok: false, message: "Recipe not found." }, { status: 404 });

    const { product, variants } = await fetchShopifyProductVariants(admin, productGid);
    if (!product) return Response.json({ ok: false, message: "Shopify product not found. Check the Product GID." }, { status: 404 });

    await db.productRecipe.updateMany({
      where: { shop, id: recipeId },
      data: {
        productGid,
        notes: recipe.notes || "",
      },
    });

    let created = 0;
    let updated = 0;

    for (const variant of variants) {
      const mapped = autoMapShopifyVariant(variant, recipe);
      const existing = await db.recipeVariantRule.findFirst({
        where: { shop, recipeId, shopifyVariantGid: variant.id },
      });

      const data = {
        name: mapped.name,
        shopifyProductGid: product.id,
        shopifyVariantGid: variant.id,
        shopifyVariantTitle: mapped.shopifyVariantTitle,
        sku: mapped.sku,
        sideMode: mapped.sideMode,
        bagColor: mapped.bagColor,
        frontMediaOptionId: mapped.frontMediaOptionId,
        backMediaMode: mapped.backMediaMode,
        backMediaOptionId: mapped.backMediaOptionId,
        useFrontZone: mapped.useFrontZone,
        useBackZone: mapped.useBackZone,
        active: true,
        notes: mapped.notes,
      };

      if (existing) {
        await db.recipeVariantRule.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await db.recipeVariantRule.create({ data: { shop, recipeId, ...data } });
        created += 1;
      }
    }

    return Response.json({
      ok: true,
      message: `Synced ${variants.length} Shopify variant(s): ${created} created, ${updated} updated. Quantities were not parsed because tiers are handled by pricing templates.`,
    });
  }

  if (intent === "autoMapExistingVariantRules") {
    const recipeId = String(formData.get("recipeId") || "");
    const recipe = await db.productRecipe.findFirst({
      where: { shop, id: recipeId },
      include: { mediaOptions: { include: { material: true } } },
    });
    if (!recipe) return Response.json({ ok: false, message: "Recipe not found." }, { status: 404 });

    const rules = await db.recipeVariantRule.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    let updated = 0;

    for (const rule of rules) {
      const mapped = autoMapShopifyVariant(
        {
          title: rule.shopifyVariantTitle || rule.name,
          sku: rule.sku,
          selectedOptions: [],
        },
        recipe
      );

      await db.recipeVariantRule.update({
        where: { id: rule.id },
        data: {
          sideMode: mapped.sideMode,
          bagColor: rule.bagColor || mapped.bagColor,
          frontMediaOptionId: mapped.frontMediaOptionId || rule.frontMediaOptionId,
          backMediaMode: mapped.backMediaMode,
          backMediaOptionId: mapped.backMediaOptionId,
          useFrontZone: mapped.useFrontZone,
          useBackZone: mapped.useBackZone,
          notes: rule.notes || mapped.notes,
        },
      });
      updated += 1;
    }

    return Response.json({ ok: true, message: `Auto-mapped ${updated} existing variant mapping(s). Quantities remain controlled by pricing templates.` });
  }


  if (intent === "addVariantRule") {
    await db.recipeVariantRule.create({
      data: {
        shop,
        recipeId: String(formData.get("recipeId") || ""),
        name: String(formData.get("name") || "New variant rule"),
        shopifyProductGid: String(formData.get("shopifyProductGid") || "") || null,
        shopifyVariantGid: String(formData.get("shopifyVariantGid") || "") || null,
        shopifyVariantTitle: String(formData.get("shopifyVariantTitle") || "") || null,
        sku: String(formData.get("sku") || "") || null,
        sideMode: String(formData.get("sideMode") || "single"),
        bagColor: String(formData.get("bagColor") || "") || null,
        frontMediaOptionId: String(formData.get("frontMediaOptionId") || "") || null,
        backMediaMode: String(formData.get("backMediaMode") || "same_as_front"),
        backMediaOptionId: String(formData.get("backMediaOptionId") || "") || null,
        useFrontZone: String(formData.get("useFrontZone") || "") === "on",
        useBackZone: String(formData.get("useBackZone") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
        active: true,
      },
    });
    return Response.json({ ok: true, message: "Variant pricing rule added." });
  }

  if (intent === "updateVariantRule") {
    await db.recipeVariantRule.updateMany({
      where: { shop, id: String(formData.get("variantRuleId") || "") },
      data: {
        name: String(formData.get("name") || "Variant rule"),
        shopifyProductGid: String(formData.get("shopifyProductGid") || "") || null,
        shopifyVariantGid: String(formData.get("shopifyVariantGid") || "") || null,
        shopifyVariantTitle: String(formData.get("shopifyVariantTitle") || "") || null,
        sku: String(formData.get("sku") || "") || null,
        sideMode: String(formData.get("sideMode") || "single"),
        bagColor: String(formData.get("bagColor") || "") || null,
        frontMediaOptionId: String(formData.get("frontMediaOptionId") || "") || null,
        backMediaMode: String(formData.get("backMediaMode") || "same_as_front"),
        backMediaOptionId: String(formData.get("backMediaOptionId") || "") || null,
        useFrontZone: String(formData.get("useFrontZone") || "") === "on",
        useBackZone: String(formData.get("useBackZone") || "") === "on",
        active: String(formData.get("active") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Variant pricing rule updated." });
  }

  if (intent === "archiveVariantRule") {
    await db.recipeVariantRule.updateMany({ where: { shop, id: String(formData.get("variantRuleId") || "") }, data: { active: false } });
    return Response.json({ ok: true, message: "Variant pricing rule hidden." });
  }

  if (intent === "restoreVariantRule") {
    await db.recipeVariantRule.updateMany({ where: { shop, id: String(formData.get("variantRuleId") || "") }, data: { active: true } });
    return Response.json({ ok: true, message: "Variant pricing rule restored." });
  }

  if (intent === "deleteVariantRule") {
    await db.recipeVariantRule.deleteMany({ where: { shop, id: String(formData.get("variantRuleId") || "") } });
    return Response.json({ ok: true, message: "Variant pricing rule permanently deleted." });
  }

  if (intent === "cleanupDuplicateVariantRules") {
    const recipeId = String(formData.get("recipeId") || "");
    const rows = await db.recipeVariantRule.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seen = new Set<string>();
    const duplicateIds: string[] = [];
    for (const row of rows as any[]) {
      const key = `${row.shopifyVariantGid || row.name}|${row.sideMode}|${row.bagColor || ""}|${row.frontMediaOptionId || ""}|${row.backMediaMode || ""}|${row.backMediaOptionId || ""}`.toLowerCase();
      if (seen.has(key)) duplicateIds.push(row.id);
      else seen.add(key);
    }
    if (duplicateIds.length) await db.recipeVariantRule.deleteMany({ where: { shop, id: { in: duplicateIds } } });
    return Response.json({ ok: true, message: `${duplicateIds.length} duplicate variant rule(s) deleted.` });
  }

  if (intent === "addMaterial") {
    await db.recipeMaterial.create({
      data: {
        shop,
        recipeId: String(formData.get("recipeId") || ""),
        materialId: String(formData.get("materialId") || ""),
        usageType: String(formData.get("usageType") || "media"),
        quantity: numberValue(formData.get("quantity"), 1),
        unit: String(formData.get("unit") || "each"),
        wastePct: numberValue(formData.get("wastePct"), 0),
        includeWaste: String(formData.get("includeWaste") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Material added to recipe." });
  }

  if (intent === "updateMaterialRow") {
    await db.recipeMaterial.updateMany({
      where: { shop, id: String(formData.get("recipeMaterialId") || "") },
      data: {
        materialId: String(formData.get("materialId") || ""),
        usageType: String(formData.get("usageType") || "media"),
        quantity: numberValue(formData.get("quantity"), 1),
        unit: String(formData.get("unit") || "each"),
        wastePct: numberValue(formData.get("wastePct"), 0),
        includeWaste: String(formData.get("includeWaste") || "") === "on",
        active: String(formData.get("active") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Recipe material updated." });
  }

  if (intent === "archiveMaterialRow") {
    await db.recipeMaterial.updateMany({ where: { shop, id: String(formData.get("recipeMaterialId") || "") }, data: { active: false } });
    return Response.json({ ok: true, message: "Recipe material hidden." });
  }

  if (intent === "restoreMaterialRow") {
    await db.recipeMaterial.updateMany({ where: { shop, id: String(formData.get("recipeMaterialId") || "") }, data: { active: true } });
    return Response.json({ ok: true, message: "Recipe material restored." });
  }

  if (intent === "removeMaterial" || intent === "deleteMaterialRow") {
    await db.recipeMaterial.deleteMany({ where: { shop, id: String(formData.get("recipeMaterialId") || "") } });
    return Response.json({ ok: true, message: "Recipe material permanently deleted." });
  }

  if (intent === "cleanupDuplicateMaterials") {
    const recipeId = String(formData.get("recipeId") || "");
    const rows = await db.recipeMaterial.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seen = new Set<string>();
    const duplicateIds: string[] = [];
    for (const row of rows as any[]) {
      const key = `${row.materialId}|${row.usageType}|${row.unit}`;
      if (seen.has(key)) duplicateIds.push(row.id);
      else seen.add(key);
    }
    if (duplicateIds.length) await db.recipeMaterial.deleteMany({ where: { shop, id: { in: duplicateIds } } });
    return Response.json({ ok: true, message: `${duplicateIds.length} duplicate material row(s) deleted.` });
  }

  if (intent === "addMediaOption") {
    const recipeId = String(formData.get("recipeId") || "");
    const materialId = String(formData.get("materialId") || "");
    const makeDefault = String(formData.get("defaultOption") || "") === "on";
    if (makeDefault) await db.recipeMediaOption.updateMany({ where: { shop, recipeId }, data: { defaultOption: false } });
    await db.recipeMediaOption.create({
      data: {
        shop,
        recipeId,
        materialId,
        name: String(formData.get("name") || "Media option"),
        defaultOption: makeDefault,
        premiumOption: String(formData.get("premiumOption") || "") === "on",
        priceAdjustPct: numberValue(formData.get("priceAdjustPct"), 0),
        priceAdjustFlat: numberValue(formData.get("priceAdjustFlat"), 0),
        notes: String(formData.get("notes") || "") || null,
        active: true,
      },
    });
    return Response.json({ ok: true, message: "Media option added." });
  }

  if (intent === "updateMediaOption") {
    const id = String(formData.get("mediaOptionId") || "");
    const recipeId = String(formData.get("recipeId") || "");
    const makeDefault = String(formData.get("defaultOption") || "") === "on";
    if (makeDefault) await db.recipeMediaOption.updateMany({ where: { shop, recipeId }, data: { defaultOption: false } });
    await db.recipeMediaOption.updateMany({
      where: { shop, id },
      data: {
        name: String(formData.get("name") || "Media option"),
        materialId: String(formData.get("materialId") || ""),
        defaultOption: makeDefault,
        premiumOption: String(formData.get("premiumOption") || "") === "on",
        active: String(formData.get("active") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Media option updated." });
  }

  if (intent === "archiveMediaOption") {
    await db.recipeMediaOption.updateMany({ where: { shop, id: String(formData.get("mediaOptionId") || "") }, data: { active: false } });
    return Response.json({ ok: true, message: "Media option archived." });
  }

  if (intent === "restoreMediaOption") {
    await db.recipeMediaOption.updateMany({ where: { shop, id: String(formData.get("mediaOptionId") || "") }, data: { active: true } });
    return Response.json({ ok: true, message: "Media option restored." });
  }

  if (intent === "deleteMediaOption") {
    const id = String(formData.get("mediaOptionId") || "");
    const usedCount = await db.recipeLabelZone.count({ where: { shop, mediaOptionId: id } });
    if (usedCount > 0) {
      await db.recipeMediaOption.updateMany({ where: { shop, id }, data: { active: false } });
      return Response.json({ ok: true, message: "Media option is used by zones, so it was archived instead of deleted." });
    }
    await db.recipeMediaOption.deleteMany({ where: { shop, id } });
    return Response.json({ ok: true, message: "Unused media option deleted." });
  }

  if (intent === "deleteMediaOptionForever") {
    const id = String(formData.get("mediaOptionId") || "");
    await db.recipeLabelZone.updateMany({ where: { shop, mediaOptionId: id }, data: { mediaOptionId: null, mediaMode: "fixed" } });
    await db.recipeMediaOption.deleteMany({ where: { shop, id } });
    return Response.json({ ok: true, message: "Media option permanently deleted and removed from zones." });
  }

  if (intent === "addLabelZone") {
    const recipeId = String(formData.get("recipeId") || "");
    const materialId = String(formData.get("materialId") || "") || null;
    await db.recipeLabelZone.create({
      data: {
        shop,
        recipeId,
        materialId,
        mediaMode: String(formData.get("mediaMode") || "fixed"),
        mediaOptionId: String(formData.get("mediaOptionId") || "") || null,
        sameAsZoneId: String(formData.get("sameAsZoneId") || "") || null,
        name: String(formData.get("name") || "Label zone"),
        position: String(formData.get("position") || "Front"),
        widthIn: numberValue(formData.get("widthIn"), 0),
        heightIn: numberValue(formData.get("heightIn"), 0),
        qtyPerUnit: numberValue(formData.get("qtyPerUnit"), 1),
        applicationSecondsPerLabel: numberValue(formData.get("applicationSecondsPerLabel"), 0),
        required: String(formData.get("required") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
        active: true,
      },
    });
    return Response.json({ ok: true, message: "Label/application zone added." });
  }

  if (intent === "updateLabelZone") {
    await db.recipeLabelZone.updateMany({
      where: { shop, id: String(formData.get("zoneId") || "") },
      data: {
        materialId: String(formData.get("materialId") || "") || null,
        mediaMode: String(formData.get("mediaMode") || "fixed"),
        mediaOptionId: String(formData.get("mediaOptionId") || "") || null,
        sameAsZoneId: String(formData.get("sameAsZoneId") || "") || null,
        name: String(formData.get("name") || "Label zone"),
        position: String(formData.get("position") || "Front"),
        widthIn: numberValue(formData.get("widthIn"), 0),
        heightIn: numberValue(formData.get("heightIn"), 0),
        qtyPerUnit: numberValue(formData.get("qtyPerUnit"), 1),
        applicationSecondsPerLabel: numberValue(formData.get("applicationSecondsPerLabel"), 0),
        required: String(formData.get("required") || "") === "on",
        active: String(formData.get("active") || "") === "on",
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Label/application zone updated." });
  }

  if (intent === "archiveLabelZone") {
    await db.recipeLabelZone.updateMany({ where: { shop, id: String(formData.get("zoneId") || "") }, data: { active: false } });
    return Response.json({ ok: true, message: "Label/application zone hidden." });
  }

  if (intent === "restoreLabelZone") {
    await db.recipeLabelZone.updateMany({ where: { shop, id: String(formData.get("zoneId") || "") }, data: { active: true } });
    return Response.json({ ok: true, message: "Label/application zone restored." });
  }

  if (intent === "duplicateLabelZone") {
    const zoneId = String(formData.get("zoneId") || "");
    const zone = await db.recipeLabelZone.findFirst({ where: { shop, id: zoneId } });
    if (!zone) return Response.json({ ok: false, message: "Label zone not found." }, { status: 404 });
    await db.recipeLabelZone.create({
      data: {
        shop,
        recipeId: zone.recipeId,
        materialId: zone.materialId,
        mediaMode: zone.mediaMode || "fixed",
        mediaOptionId: zone.mediaOptionId,
        sameAsZoneId: zone.sameAsZoneId,
        name: `${zone.name || "Label zone"} copy`,
        position: zone.position === "Front" ? "Back" : zone.position,
        widthIn: zone.widthIn,
        heightIn: zone.heightIn,
        qtyPerUnit: zone.qtyPerUnit,
        applicationSecondsPerLabel: zone.applicationSecondsPerLabel,
        required: zone.required,
        notes: zone.notes,
        active: true,
      },
    });
    return Response.json({ ok: true, message: "Label zone duplicated." });
  }

  if (intent === "removeLabelZone" || intent === "deleteLabelZone") {
    await db.recipeLabelZone.deleteMany({ where: { shop, id: String(formData.get("zoneId") || "") } });
    return Response.json({ ok: true, message: "Label/application zone permanently deleted." });
  }


  if (intent === "cleanupDuplicateMediaOptions") {
    const recipeId = String(formData.get("recipeId") || "");
    const options = await db.recipeMediaOption.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seen = new Map<string, any>();
    let removed = 0;
    for (const option of options as any[]) {
      const key = `${String(option.name || "").trim().toLowerCase()}|${option.materialId || ""}`;
      const keeper = seen.get(key);
      if (!keeper) {
        seen.set(key, option);
        continue;
      }
      await db.recipeLabelZone.updateMany({ where: { shop, mediaOptionId: option.id }, data: { mediaOptionId: keeper.id } });
      if (option.defaultOption && !keeper.defaultOption) {
        await db.recipeMediaOption.updateMany({ where: { shop, id: keeper.id }, data: { defaultOption: true } });
      }
      await db.recipeMediaOption.deleteMany({ where: { shop, id: option.id } });
      removed += 1;
    }
    return Response.json({ ok: true, message: `${removed} duplicate media option(s) merged/deleted.` });
  }

  if (intent === "cleanupDuplicateLabelZones") {
    const recipeId = String(formData.get("recipeId") || "");
    const zones = await db.recipeLabelZone.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seen = new Map<string, any>();
    let removed = 0;
    for (const zone of zones as any[]) {
      const key = [
        String(zone.name || "").trim().toLowerCase(),
        String(zone.position || ""),
        Number(zone.widthIn || 0).toFixed(4),
        Number(zone.heightIn || 0).toFixed(4),
        Number(zone.qtyPerUnit || 0).toFixed(4),
        String(zone.mediaMode || "fixed"),
        String(zone.materialId || ""),
        String(zone.mediaOptionId || ""),
        String(zone.sameAsZoneId || ""),
      ].join("|");
      const keeper = seen.get(key);
      if (!keeper) {
        seen.set(key, zone);
        continue;
      }
      await db.recipeLabelZone.updateMany({ where: { shop, sameAsZoneId: zone.id }, data: { sameAsZoneId: keeper.id } });
      await db.recipeLabelZone.deleteMany({ where: { shop, id: zone.id } });
      removed += 1;
    }
    return Response.json({ ok: true, message: `${removed} duplicate label zone(s) deleted.` });
  }

  if (intent === "cleanupAllRecipeDuplicates") {
    const recipeId = String(formData.get("recipeId") || "");

    const options = await db.recipeMediaOption.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seenOptions = new Map<string, any>();
    let removedOptions = 0;
    for (const option of options as any[]) {
      const key = `${String(option.name || "").trim().toLowerCase()}|${option.materialId || ""}`;
      const keeper = seenOptions.get(key);
      if (!keeper) seenOptions.set(key, option);
      else {
        await db.recipeLabelZone.updateMany({ where: { shop, mediaOptionId: option.id }, data: { mediaOptionId: keeper.id } });
        await db.recipeMediaOption.deleteMany({ where: { shop, id: option.id } });
        removedOptions += 1;
      }
    }

    const zones = await db.recipeLabelZone.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seenZones = new Map<string, any>();
    let removedZones = 0;
    for (const zone of zones as any[]) {
      const key = [String(zone.name || "").trim().toLowerCase(), String(zone.position || ""), Number(zone.widthIn || 0).toFixed(4), Number(zone.heightIn || 0).toFixed(4), Number(zone.qtyPerUnit || 0).toFixed(4), String(zone.mediaMode || "fixed"), String(zone.materialId || ""), String(zone.mediaOptionId || ""), String(zone.sameAsZoneId || "")].join("|");
      const keeper = seenZones.get(key);
      if (!keeper) seenZones.set(key, zone);
      else {
        await db.recipeLabelZone.updateMany({ where: { shop, sameAsZoneId: zone.id }, data: { sameAsZoneId: keeper.id } });
        await db.recipeLabelZone.deleteMany({ where: { shop, id: zone.id } });
        removedZones += 1;
      }
    }

    const rows = await db.recipeMaterial.findMany({ where: { shop, recipeId }, orderBy: { createdAt: "asc" } });
    const seenRows = new Set<string>();
    const duplicateRowIds: string[] = [];
    for (const row of rows as any[]) {
      const key = `${row.materialId}|${row.usageType}|${row.unit}`;
      if (seenRows.has(key)) duplicateRowIds.push(row.id);
      else seenRows.add(key);
    }
    if (duplicateRowIds.length) await db.recipeMaterial.deleteMany({ where: { shop, id: { in: duplicateRowIds } } });

    return Response.json({ ok: true, message: `Cleanup complete: ${removedOptions} media option(s), ${removedZones} zone(s), ${duplicateRowIds.length} material row(s).` });
  }

  if (intent === "syncTiersFromTemplate") {
    const recipeId = String(formData.get("recipeId") || "");
    const recipe = await db.productRecipe.findFirst({ where: { shop, id: recipeId }, include: { productTypeProfile: true } });
    const tiers = parseTiers(recipe?.productTypeProfile?.tierTemplate);
    if (!recipe || !tiers.length) return Response.json({ ok: false, message: "Recipe has no template tiers to sync." }, { status: 400 });
    await db.recipeTier.deleteMany({ where: { shop, recipeId } });
    await db.recipeTier.createMany({ data: tiers.map((tier: any) => ({ shop, recipeId, minQty: Number(tier.minQty || 1), maxQty: tier.maxQty ? Number(tier.maxQty) : null, marginPct: tier.marginPct == null ? null : Number(tier.marginPct), fixedPrice: tier.fixedPrice == null ? null : Number(tier.fixedPrice) })) });
    return Response.json({ ok: true, message: "Recipe tiers synced from pricing template." });
  }

  if (intent === "saveCustomTiers") {
    const recipeId = String(formData.get("recipeId") || "");
    const tiers = parseTierText(String(formData.get("tiers") || ""), numberValue(formData.get("targetMarginPct"), 50));
    await db.recipeTier.deleteMany({ where: { shop, recipeId } });
    if (tiers.length) {
      await db.recipeTier.createMany({ data: tiers.map((tier: any) => ({ shop, recipeId, minQty: tier.minQty, maxQty: tier.maxQty, marginPct: tier.marginPct, fixedPrice: tier.fixedPrice })) });
    }
    await db.productRecipe.updateMany({ where: { shop, id: recipeId }, data: { pricingTemplateMode: "custom" } });
    return Response.json({ ok: true, message: "Custom recipe tiers saved." });
  }

  return Response.json({ ok: false, message: "Unknown product setup action." }, { status: 400 });
}

function NativeInput({ label, name, defaultValue = "", type = "text", step, placeholder }: any) {
  return (
    <label className="field">
      <span>{label}</span>
      <input name={name} type={type} step={step} defaultValue={defaultValue ?? ""} placeholder={placeholder} />
    </label>
  );
}

function NativeSelect({ label, name, defaultValue, children }: any) {
  return (
    <label className="field">
      <span>{label}</span>
      <select name={name} defaultValue={defaultValue ?? ""}>{children}</select>
    </label>
  );
}

function NativeTextarea({ label, name, defaultValue = "", rows = 3, placeholder }: any) {
  return (
    <label className="field wide">
      <span>{label}</span>
      <textarea name={name} rows={rows} defaultValue={defaultValue ?? ""} placeholder={placeholder} />
    </label>
  );
}

function PageStyles() {
  return <style>{`
    .erp-page { max-width: 1480px; margin: 0 auto; padding: 24px; font-family: Arial, sans-serif; color: #202223; }
    .hero { background: linear-gradient(135deg, #111827, #3b0764); color: white; padding: 22px; border-radius: 18px; margin-bottom: 18px; }
    .hero h1 { margin: 0 0 8px; font-size: 30px; }
    .hero p { margin: 0; opacity: .9; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
    .card { background: white; border: 1px solid #d9d9d9; border-radius: 16px; padding: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.04); margin-bottom: 16px; }
    .card h2, .card h3 { margin: 0 0 12px; }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
    .field { display: flex; flex-direction: column; gap: 5px; font-size: 13px; font-weight: 700; }
    .field span { color: #3f3f46; }
    .field input, .field select, .field textarea { border: 1px solid #babfc3; border-radius: 9px; padding: 9px; font: inherit; font-weight: 400; background: white; min-height: 38px; }
    .wide { grid-column: 1 / -1; }
    .button-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; align-items: center; }
    button, .button { border: 0; background: #111827; color: white; padding: 9px 12px; border-radius: 10px; cursor: pointer; font-weight: 700; text-decoration: none; display: inline-block; }
    .secondary { background: #e5e7eb; color: #111827; }
    .danger { background: #b91c1c; }
    .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 9px; background: #eef2ff; color: #3730a3; font-size: 12px; font-weight: 700; margin-right: 6px; margin-bottom: 6px; }
    .badge.green { background:#dcfce7; color:#166534; } .badge.red { background:#fee2e2; color:#991b1b; } .badge.yellow { background:#fef9c3; color:#854d0e; }
    .muted { color: #6b7280; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
    th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }
    th { color:#374151; background:#f9fafb; }
    details { border: 1px solid #e5e7eb; border-radius: 12px; padding: 10px 12px; margin-top: 10px; }
    summary { cursor: pointer; font-weight: 800; }
  `}</style>;
}

export default function ProductSetupRecipeBuilder() {
  const { templates, activeTemplates, recipes, materials, machines, recipeStatus = "active", recipeSearch = "", itemStatus = "active" } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const materialOptions = materials || [];
  const machineOptions = machines || [];
  const templateOptions = templates || [];
  const activeTemplateOptions = activeTemplates || templateOptions.filter((template: any) => template.active);

  return (
    <div className="erp-page">
      <PageStyles />
      <div className="hero">
        <h1>Product Setup / Recipe Builder</h1>
        <p>Build reusable product recipes, assign category pricing templates, preview tier profitability, and keep quotes simple.</p>
      </div>

      {actionData?.message ? <div className="card"><span className={actionData.ok ? "badge green" : "badge red"}>{actionData.message}</span></div> : null}

      <div className="card">
        <h2>Clean pricing workflow</h2>
        <p className="muted">Use category templates for normal tier pricing. Use custom product tiers only when a specific item truly needs special pricing. Material cost changes will be handled later in Margin Review / Price Audit.</p>
        <div>
          <span className="badge green">Templates = pricing rules</span>
          <span className="badge">Recipes = how product is made</span>
          <span className="badge yellow">Margin Review = update Shopify prices later</span>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>Pricing Templates</h2>
          <p className="muted">Use templates for category-level tiered pricing. Most products should use a template instead of custom tiers.</p>
          <div className="button-row">
            <Form method="post">
              <input type="hidden" name="intent" value="seedTemplates" />
              <button type="submit">Create / refresh approved templates</button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="cleanupTemplates" />
              <button type="submit" className="secondary">Archive duplicates / old categories</button>
            </Form>
          </div>
          <p className="muted">Approved templates: Labels, Sticker Bags, DTP Bags, Boxes, and DTF / Apparel. Stock Bags should use Sticker Bags; sourced work is handled by Production Mode, not a family.</p>
          <details open>
            <summary>Add pricing template</summary>
            <Form method="post" className="form-grid">
              <input type="hidden" name="intent" value="createTemplate" />
              <NativeInput label="Template name" name="name" placeholder="Sticker Bags Pricing Template" />
              <NativeSelect label="Product family" name="family" defaultValue="Sticker Bags">
                {PRODUCT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
              </NativeSelect>
              <NativeSelect label="Production mode" name="productionMode" defaultValue="in_house">
                {PRODUCTION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </NativeSelect>
              <NativeInput label="MOQ" name="minQuantity" type="number" defaultValue="64" />
              <NativeInput label="Default qty" name="defaultQuantity" type="number" defaultValue="250" />
              <NativeInput label="Default margin %" name="defaultMarginPct" type="number" step="0.01" defaultValue="60" />
              <NativeTextarea label="Tier rows" name="tiers" rows={7} defaultValue={"64-199: 70%\n200-499: 65%\n500-999: 60%\n1000-2499: 55%\n2500+: 50%"} />
              <NativeTextarea label="Notes" name="notes" />
              <div className="button-row wide"><button type="submit">Save template</button></div>
            </Form>
          </details>
        </div>

        <div className="card">
          <h2>Create Product Recipe</h2>
          <p className="muted">Use this for existing Shopify products, new manual products, or reusable products created from quotes later.</p>
          <Form method="post" className="form-grid">
            <input type="hidden" name="intent" value="createRecipe" />
            <NativeInput label="Recipe / product name" name="name" placeholder="4x5 Sticker Bag" />
            <NativeInput label="SKU / internal code" name="sku" />
            <NativeSelect label="Product family" name="productFamily" defaultValue="Sticker Bags">
              {PRODUCT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
            </NativeSelect>
            <NativeSelect label="Pricing template" name="templateId">
              <option value="">No template / custom</option>
              {activeTemplateOptions.map((template: any) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </NativeSelect>
            <NativeSelect label="Pricing mode" name="pricingTemplateMode" defaultValue="template">
              <option value="template">Use category template</option>
              <option value="custom">Custom product tiers</option>
            </NativeSelect>
            <NativeSelect label="Production mode" name="productionMode" defaultValue="in_house">
              {PRODUCTION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
            </NativeSelect>
            <NativeSelect label="Machine" name="machineId">
              <option value="">None / choose later</option>
              {machineOptions.map((machine: any) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
            </NativeSelect>
            <NativeInput label="Shopify Product GID" name="productGid" placeholder="optional" />
            <NativeInput label="Shopify Variant GID" name="variantGid" placeholder="optional" />
            <NativeInput label="MOQ" name="minQuantity" type="number" defaultValue="64" />
            <NativeInput label="Default qty" name="defaultQuantity" type="number" defaultValue="250" />
            <NativeInput label="Target margin %" name="targetMarginPct" type="number" step="0.01" defaultValue="60" />
            <NativeInput label="Waste %" name="wastePct" type="number" step="0.01" defaultValue="15" />
            <NativeInput label="Setup cost / job" name="setupCost" type="number" step="0.01" defaultValue="0" />
            <NativeInput label="Setup labor min / job" name="laborMinutes" type="number" step="0.01" defaultValue="0" />
            <NativeInput label="Prepress min / job" name="prepressMinutes" type="number" step="0.01" defaultValue="0" />
            <input type="hidden" name="applicationLaborSecondsPerUnit" value="0" />
            <NativeInput label="Packing sec / unit" name="packingLaborSecondsPerUnit" type="number" step="0.01" defaultValue="0" />
            <p className="muted wide">Application labor is entered on label/application zones. This prevents double-counting front/back/lid labels.</p>
            <label className="field"><span>Use in quotes</span><input type="checkbox" name="useInQuotes" defaultChecked /></label>
            <label className="field"><span>Cost review needed</span><input type="checkbox" name="costReviewNeeded" /></label>
            <NativeTextarea label="Notes" name="notes" />
            <div className="button-row wide"><button type="submit">Create recipe</button></div>
          </Form>
        </div>
      </div>

      <div className="card">
        <h2>Saved Pricing Templates</h2>
        {templateOptions.length ? templateOptions.map((template: any) => {
          const tiers = parseTiers(template.tierTemplate);
          return (
            <details key={template.id}>
              <summary>{template.name} {template.active ? <span className="badge green">Active</span> : <span className="badge red">Archived</span>}</summary>
              <Form method="post" className="form-grid">
                <input type="hidden" name="intent" value="updateTemplate" />
                <input type="hidden" name="templateId" value={template.id} />
                <NativeInput label="Template name" name="name" defaultValue={template.name} />
                <NativeSelect label="Production mode" name="productionMode" defaultValue={template.productionMode}>
                  {PRODUCTION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </NativeSelect>
                <NativeInput label="MOQ" name="minQuantity" type="number" defaultValue={template.minQuantity} />
                <NativeInput label="Default qty" name="defaultQuantity" type="number" defaultValue={template.defaultQuantity} />
                <NativeInput label="Default margin %" name="defaultMarginPct" type="number" step="0.01" defaultValue={template.defaultMarginPct} />
                <NativeTextarea label="Tier rows" name="tiers" rows={7} defaultValue={tiersToText(tiers)} />
                <NativeTextarea label="Notes" name="notes" defaultValue={template.notes || ""} />
                <div className="button-row wide">
                  <button type="submit">Save template</button>
                </div>
              </Form>
              <div className="button-row">
                {template.active ? <Form method="post">
                  <input type="hidden" name="intent" value="archiveTemplate" />
                  <input type="hidden" name="templateId" value={template.id} />
                  <button type="submit" className="danger">Archive template</button>
                </Form> : <Form method="post">
                  <input type="hidden" name="intent" value="restoreTemplate" />
                  <input type="hidden" name="templateId" value={template.id} />
                  <button type="submit" className="secondary">Restore template</button>
                </Form>}
                <Form method="post">
                  <input type="hidden" name="intent" value="deleteTemplate" />
                  <input type="hidden" name="templateId" value={template.id} />
                  <button type="submit" className="danger">Delete Forever if unused</button>
                </Form>
              </div>
            </details>
          );
        }) : <p className="muted">No pricing templates yet. Click Create default templates.</p>}
      </div>

      <div className="card">
        <h2>Product Recipes</h2>
        <p className="muted">Recipe cost preview is a working estimate. It uses material unit costs, waste, labor assumptions, setup cost, and target margins.</p>
        <Form method="get" className="form-grid" style={{ marginTop: 10, marginBottom: 12 }}>
          <NativeSelect label="Recipe status" name="recipeStatus" defaultValue={recipeStatus}>
            <option value="active">Active recipes only</option>
            <option value="archived">Archived recipes only</option>
            <option value="all">All recipes</option>
          </NativeSelect>
          <NativeInput label="Search recipes" name="recipeSearch" defaultValue={recipeSearch} placeholder="4x5, label, jar, SKU" />
          <NativeSelect label="Recipe item rows" name="itemStatus" defaultValue={itemStatus}>
            <option value="active">Active items only</option>
            <option value="hidden">Hidden/archived items only</option>
            <option value="all">All items</option>
          </NativeSelect>
          <div className="button-row" style={{ alignItems: "end" }}>
            <button type="submit" className="secondary">Apply filter</button>
            <a className="secondary" href="/app/erp/product-setup">Reset</a>
          </div>
        </Form>
        <p className="muted">Archived recipes are hidden by default. Hidden media options, zones, and material rows are also hidden by default. Use the item row filter to restore or permanently delete hidden/duplicate items.</p>
        {recipes.length ? recipes.map((recipe: any) => {
          const estimate = estimateRecipe(recipe);
          const templateTiers = recipe.pricingTemplateMode === "template" ? parseTiers(recipe.productTypeProfile?.tierTemplate) : [];
          const activeTiers = recipe.tiers?.length ? recipe.tiers : templateTiers;
          const machineId = recipe.machineRules?.[0]?.preferredMachineId || "";
          const visibleMediaOptions = (recipe.mediaOptions || []).filter((option: any) => itemStatus === "all" ? true : itemStatus === "hidden" ? option.active === false : option.active !== false);
          const visibleLabelZones = (recipe.labelZones || []).filter((zone: any) => itemStatus === "all" ? true : itemStatus === "hidden" ? zone.active === false : zone.active !== false);
          const visibleRecipeMaterials = (recipe.materials || []).filter((row: any) => itemStatus === "all" ? true : itemStatus === "hidden" ? row.active === false : row.active !== false);
          return (
            <details key={recipe.id} open={false}>
              <summary>
                {recipe.name} <span className="badge">{recipe.productFamily || recipe.productType}</span>
                {recipe.active ? <span className="badge green">Active</span> : <span className="badge red">Archived</span>}
                {recipe.useInQuotes ? <span className="badge green">Use in Quotes</span> : <span className="badge yellow">Hidden</span>}
                {recipe.costReviewNeeded ? <span className="badge red">Cost Review</span> : null}
              </summary>

              <div className="grid" style={{ marginTop: 12 }}>
                <div>
                  <h3>Recipe Details</h3>
                  <Form method="post" className="form-grid">
                    <input type="hidden" name="intent" value="updateRecipe" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <NativeInput label="Recipe / product name" name="name" defaultValue={recipe.name} />
                    <NativeInput label="SKU / internal code" name="sku" defaultValue={recipe.sku || ""} />
                    <NativeSelect label="Product family" name="productFamily" defaultValue={recipe.productFamily || "Labels"}>
                      {PRODUCT_FAMILIES.map((family) => <option key={family} value={family}>{family}</option>)}
                    </NativeSelect>
                    <NativeSelect label="Pricing template" name="templateId" defaultValue={recipe.productTypeProfileId || ""}>
                      <option value="">No template / custom</option>
                      {activeTemplateOptions.map((template: any) => <option key={template.id} value={template.id}>{template.name}</option>)}
                    </NativeSelect>
                    <NativeSelect label="Pricing mode" name="pricingTemplateMode" defaultValue={recipe.pricingTemplateMode || "template"}>
                      <option value="template">Use category template</option>
                      <option value="custom">Custom product tiers</option>
                    </NativeSelect>
                    <NativeSelect label="Production mode" name="productionMode" defaultValue={recipe.productionMode || "in_house"}>
                      {PRODUCTION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                    </NativeSelect>
                    <NativeSelect label="Machine" name="machineId" defaultValue={machineId}>
                      <option value="">None / choose later</option>
                      {machineOptions.map((machine: any) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}
                    </NativeSelect>
                    <NativeInput label="Shopify Product GID" name="productGid" defaultValue={recipe.productGid || ""} />
                    <NativeInput label="Shopify Variant GID" name="variantGid" defaultValue={recipe.variantGid || ""} />
                    <NativeInput label="MOQ" name="minQuantity" type="number" defaultValue={recipe.minQuantity} />
                    <NativeInput label="Default qty" name="defaultQuantity" type="number" defaultValue={recipe.defaultQuantity} />
                    <NativeInput label="Target margin %" name="targetMarginPct" type="number" step="0.01" defaultValue={recipe.targetMarginPct} />
                    <NativeInput label="Waste %" name="wastePct" type="number" step="0.01" defaultValue={recipe.wastePct} />
                    <NativeInput label="Setup cost / job" name="setupCost" type="number" step="0.01" defaultValue={recipe.setupCost} />
                    <NativeInput label="Setup labor min / job" name="laborMinutes" type="number" step="0.01" defaultValue={recipe.laborMinutes} />
                    <NativeInput label="Prepress min / job" name="prepressMinutes" type="number" step="0.01" defaultValue={recipe.prepressMinutes} />
                    <input type="hidden" name="applicationLaborSecondsPerUnit" value="0" />
                    <NativeInput label="Packing sec / unit" name="packingLaborSecondsPerUnit" type="number" step="0.01" defaultValue={recipe.packingLaborSecondsPerUnit} />
                    <p className="muted wide">Application labor comes from active label/application zones. Recipe-level application seconds are hidden and ignored when zones exist.</p>
                    <label className="field"><span>Use in quotes</span><input type="checkbox" name="useInQuotes" defaultChecked={recipe.useInQuotes} /></label>
                    <label className="field"><span>Cost review needed</span><input type="checkbox" name="costReviewNeeded" defaultChecked={recipe.costReviewNeeded} /></label>
                    <NativeTextarea label="Notes" name="notes" defaultValue={recipe.notes || ""} />
                    <div className="button-row wide"><button type="submit">Save recipe</button></div>
                  </Form>

                  <div className="button-row">
                    {recipe.active ? <Form method="post">
                      <input type="hidden" name="intent" value="archiveRecipe" />
                      <input type="hidden" name="recipeId" value={recipe.id} />
                      <button type="submit" className="danger">Archive recipe</button>
                    </Form> : <Form method="post">
                      <input type="hidden" name="intent" value="restoreRecipe" />
                      <input type="hidden" name="recipeId" value={recipe.id} />
                      <button type="submit" className="secondary">Restore recipe</button>
                    </Form>}
                    <Form method="post">
                      <input type="hidden" name="intent" value="deleteRecipeForever" />
                      <input type="hidden" name="recipeId" value={recipe.id} />
                      <button type="submit" className="danger">Delete forever</button>
                    </Form>
                  </div>
                </div>

                <div>
                  <h3>Cost + Tier Preview</h3>
                  <p><strong>Default quantity:</strong> {estimate.qty}</p>
                  <p><strong>Material cost/unit:</strong> {money(estimate.materialCostPerUnit)}</p>
                  <p><strong>Manual material rows:</strong> {money(estimate.materialRowCostPerUnit || 0)}</p>
                  <p><strong>Label zone media:</strong> {money(estimate.labelMediaCostPerUnit || 0)} | {(estimate.labelSqftPerUnit || 0).toFixed(4)} sqft/unit</p>
                  <p><strong>Label application time:</strong> {(estimate.labelApplicationSecondsPerUnit || 0).toFixed(1)} sec/unit</p>
                  <p><strong>Labor cost/unit:</strong> {money(estimate.perUnitLaborCost + estimate.perJobLaborCost)}</p>
                  <p><strong>Setup cost/unit:</strong> {money(estimate.setupCostPerUnit)}</p>
                  <p><strong>Estimated total cost/unit:</strong> {money(estimate.unitCostTotal)}</p>
                  <p><strong>Suggested price at target margin:</strong> {money(estimate.suggestedPrice)}</p>

                  <table>
                    <thead><tr><th>Tier</th><th>Margin/Price</th><th>Suggested unit price</th><th>Profit/unit</th></tr></thead>
                    <tbody>
                      {(activeTiers || []).map((tier: any, index: number) => {
                        const margin = tier.marginPct ?? recipe.targetMarginPct;
                        const price = tier.fixedPrice || priceFromMargin(estimate.unitCostTotal, Number(margin || 0));
                        return <tr key={index}>
                          <td>{tier.maxQty ? `${tier.minQty}-${tier.maxQty}` : `${tier.minQty}+`}</td>
                          <td>{tier.fixedPrice ? money(tier.fixedPrice) : pct(margin)}</td>
                          <td>{money(price)}</td>
                          <td>{money(Number(price) - estimate.unitCostTotal)}</td>
                        </tr>;
                      })}
                    </tbody>
                  </table>

                  <Form method="post" className="button-row">
                    <input type="hidden" name="intent" value="syncTiersFromTemplate" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <button type="submit" className="secondary">Sync tiers from template</button>
                  </Form>

                  <details>
                    <summary>Custom tiers for this recipe</summary>
                    <Form method="post" className="form-grid">
                      <input type="hidden" name="intent" value="saveCustomTiers" />
                      <input type="hidden" name="recipeId" value={recipe.id} />
                      <input type="hidden" name="targetMarginPct" value={recipe.targetMarginPct} />
                      <NativeTextarea label="Tier rows" name="tiers" rows={7} defaultValue={tiersToText(recipe.tiers)} />
                      <div className="button-row wide"><button type="submit">Save custom tiers</button></div>
                    </Form>
                  </details>
                </div>
              </div>

              <div className="card" style={{ marginTop: 12 }}>
                <h3>Media Options</h3>
                <p className="muted">Use media options when a recipe can be quoted with different label media like matte, gloss, or holographic. Pricing comes automatically from the selected material cost per sqft; Premium is a badge only.</p>
                {visibleMediaOptions.length ? <table>
                  <thead><tr><th>Option</th><th>Material</th><th>Badges</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {visibleMediaOptions.map((option: any) => <tr key={option.id}>
                      <td><strong>{option.name}</strong><br /><span className="muted">{option.defaultOption ? "Default" : ""} {option.premiumOption ? "Premium" : ""}</span></td>
                      <td>{option.material?.name}<br /><span className="muted">{money(unitCost(option.material))}/{option.material?.recipeBaseUnit || option.material?.baseUnit || "unit"}</span></td>
                      <td>{option.premiumOption ? <span className="badge yellow">Premium</span> : <span className="muted">Standard</span>}</td>
                      <td><span className={option.active ? "badge green" : "badge yellow"}>{option.active ? "Active" : "Archived"}</span></td>
                      <td>
                        <details>
                          <summary>Edit</summary>
                          <Form method="post" className="form-grid">
                            <input type="hidden" name="intent" value="updateMediaOption" />
                            <input type="hidden" name="recipeId" value={recipe.id} />
                            <input type="hidden" name="mediaOptionId" value={option.id} />
                            <NativeInput label="Option name" name="name" defaultValue={option.name} />
                            <NativeSelect label="Material" name="materialId" defaultValue={option.materialId}>
                              {materialOptions.filter((material: any) => String(material.materialType || "").toLowerCase().includes("roll") || String(material.materialType || "").toLowerCase().includes("label") || String(material.name || "").toLowerCase().includes("poseidon") || String(material.name || "").toLowerCase().includes("holo")).map((material: any) => <option key={material.id} value={material.id}>{material.name} | {money(unitCost(material))}/{material.recipeBaseUnit || material.baseUnit || "unit"}</option>)}
                            </NativeSelect>
                            <label className="field"><span>Default option</span><input type="checkbox" name="defaultOption" defaultChecked={option.defaultOption} /></label>
                            <label className="field"><span>Premium badge</span><input type="checkbox" name="premiumOption" defaultChecked={option.premiumOption} /></label>
                            <label className="field"><span>Active</span><input type="checkbox" name="active" defaultChecked={option.active} /></label>
                            <NativeTextarea label="Notes" name="notes" defaultValue={option.notes || ""} />
                            <div className="button-row wide"><button type="submit">Save media option</button></div>
                          </Form>
                        </details>
                        <div className="button-row">
                          <Form method="post">
                            <input type="hidden" name="intent" value={option.active ? "archiveMediaOption" : "restoreMediaOption"} />
                            <input type="hidden" name="mediaOptionId" value={option.id} />
                            <button type="submit" className="secondary">{option.active ? "Archive" : "Restore"}</button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="deleteMediaOption" />
                            <input type="hidden" name="mediaOptionId" value={option.id} />
                            <button type="submit" className="danger">Delete if unused</button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="deleteMediaOptionForever" />
                            <input type="hidden" name="mediaOptionId" value={option.id} />
                            <button type="submit" className="danger">Delete forever</button>
                          </Form>
                        </div>
                      </td>
                    </tr>)}
                  </tbody>
                </table> : <p className="muted">No media options match this item filter. Switch item rows to All/Hidden or add a new media option.</p>}

                <div className="button-row">
                  <Form method="post">
                    <input type="hidden" name="intent" value="cleanupDuplicateMediaOptions" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <button type="submit" className="secondary">Delete duplicate media options</button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="cleanupAllRecipeDuplicates" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <button type="submit" className="secondary">Clean all duplicate recipe items</button>
                  </Form>
                </div>

                <details>
                  <summary>Add media option</summary>
                  <Form method="post" className="form-grid">
                    <input type="hidden" name="intent" value="addMediaOption" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <NativeInput label="Option name" name="name" placeholder="Matte" />
                    <NativeSelect label="Material" name="materialId">
                      {materialOptions.filter((material: any) => String(material.materialType || "").toLowerCase().includes("roll") || String(material.materialType || "").toLowerCase().includes("label") || String(material.name || "").toLowerCase().includes("poseidon") || String(material.name || "").toLowerCase().includes("holo")).map((material: any) => <option key={material.id} value={material.id}>{material.name} | {money(unitCost(material))}/{material.recipeBaseUnit || material.baseUnit || "unit"}</option>)}
                    </NativeSelect>
                    <label className="field"><span>Default option</span><input type="checkbox" name="defaultOption" /></label>
                    <label className="field"><span>Premium option</span><input type="checkbox" name="premiumOption" /></label>
                    <NativeTextarea label="Notes" name="notes" placeholder="Example: standard matte media, premium holographic media, check stock before quoting" />
                    <div className="button-row wide"><button type="submit">Add media option</button></div>
                  </Form>
                </details>
              </div>

              <div className="card" style={{ marginTop: 12 }}>
                <h3>Application / Label Zones</h3>
                <p className="muted">Use zones for sticker bags, jars, boxes, and any product with one or more applied labels. Each zone auto-calculates sqft and application labor.</p>
                {visibleLabelZones.length ? <table>
                  <thead><tr><th>Zone</th><th>Size</th><th>Qty</th><th>Material</th><th>Area/unit</th><th>Apply time</th><th></th></tr></thead>
                  <tbody>
                    {visibleLabelZones.map((zone: any) => <tr key={zone.id}>
                      <td><strong>{zone.name}</strong><br /><span className="muted">{zone.position} {zone.required ? "| required" : "| optional"} {zone.active === false ? "| hidden" : ""}</span></td>
                      <td>{zone.widthIn} in x {zone.heightIn} in</td>
                      <td>{zone.qtyPerUnit}</td>
                      <td>{mediaLabelForZone(zone, recipe.labelZones || [])}<br /><span className="muted">{materialForZone(zone, recipe.labelZones || [])?.name || ""}</span></td>
                      <td>{zoneSqft(zone).toFixed(4)} sqft</td>
                      <td>{(Number(zone.applicationSecondsPerLabel || 0) * Number(zone.qtyPerUnit || 1)).toFixed(1)} sec/unit</td>
                      <td>
                        <details>
                          <summary>Edit zone</summary>
                          <Form method="post" className="form-grid">
                            <input type="hidden" name="intent" value="updateLabelZone" />
                            <input type="hidden" name="zoneId" value={zone.id} />
                            <NativeInput label="Zone name" name="name" defaultValue={zone.name} />
                            <NativeSelect label="Position" name="position" defaultValue={zone.position || "Front"}>
                              <option value="Front">Front</option>
                              <option value="Back">Back</option>
                              <option value="Lid">Lid</option>
                              <option value="Side">Side</option>
                              <option value="Bottom">Bottom</option>
                              <option value="Custom">Custom</option>
                            </NativeSelect>
                            <NativeInput label="Width inches" name="widthIn" type="number" step="0.0001" defaultValue={zone.widthIn} />
                            <NativeInput label="Height inches" name="heightIn" type="number" step="0.0001" defaultValue={zone.heightIn} />
                            <NativeInput label="Qty per finished item" name="qtyPerUnit" type="number" step="0.0001" defaultValue={zone.qtyPerUnit} />
                            <NativeInput label="Application sec per label" name="applicationSecondsPerLabel" type="number" step="0.01" defaultValue={zone.applicationSecondsPerLabel} />
                            <NativeSelect label="Media mode" name="mediaMode" defaultValue={zone.mediaMode || "fixed"}>
                              <option value="fixed">Fixed material</option>
                              <option value="media_option">Selectable media option</option>
                              <option value="same_as_zone">Same as another zone</option>
                            </NativeSelect>
                            <NativeSelect label="Fixed material" name="materialId" defaultValue={zone.materialId || ""}>
                              <option value="">No fixed material</option>
                              {materialOptions.filter((material: any) => String(material.materialType || "").toLowerCase().includes("roll") || String(material.materialType || "").toLowerCase().includes("label") || String(material.name || "").toLowerCase().includes("poseidon") || String(material.name || "").toLowerCase().includes("holo")).map((material: any) => <option key={material.id} value={material.id}>{material.name} | {money(unitCost(material))}/{material.recipeBaseUnit || material.baseUnit || "unit"}</option>)}
                            </NativeSelect>
                            <NativeSelect label="Media option" name="mediaOptionId" defaultValue={zone.mediaOptionId || ""}>
                              <option value="">No media option</option>
                              {(recipe.mediaOptions || []).filter((option: any) => option.active || option.id === zone.mediaOptionId).map((option: any) => <option key={option.id} value={option.id}>{option.name} → {option.material?.name}</option>)}
                            </NativeSelect>
                            <NativeSelect label="Same as zone" name="sameAsZoneId" defaultValue={zone.sameAsZoneId || ""}>
                              <option value="">Auto / front zone</option>
                              {(recipe.labelZones || []).filter((candidate: any) => candidate.id !== zone.id).map((candidate: any) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                            </NativeSelect>
                            <label className="field"><span>Required</span><input type="checkbox" name="required" defaultChecked={zone.required} /></label>
                            <label className="field"><span>Active</span><input type="checkbox" name="active" defaultChecked={zone.active !== false} /></label>
                            <NativeTextarea label="Notes" name="notes" defaultValue={zone.notes || ""} />
                            <div className="button-row wide"><button type="submit">Save zone</button></div>
                          </Form>
                        </details>
                        <div className="button-row">
                          <Form method="post">
                            <input type="hidden" name="intent" value="duplicateLabelZone" />
                            <input type="hidden" name="zoneId" value={zone.id} />
                            <button type="submit" className="secondary">Duplicate</button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value={zone.active === false ? "restoreLabelZone" : "archiveLabelZone"} />
                            <input type="hidden" name="zoneId" value={zone.id} />
                            <button type="submit" className="secondary">{zone.active === false ? "Restore" : "Hide"}</button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="deleteLabelZone" />
                            <input type="hidden" name="zoneId" value={zone.id} />
                            <button type="submit" className="danger">Delete forever</button>
                          </Form>
                        </div>
                      </td>
                    </tr>)}
                  </tbody>
                </table> : <p className="muted">No label/application zones match this item filter. Switch item rows to All/Hidden or add a zone.</p>}

                <div className="button-row">
                  <Form method="post">
                    <input type="hidden" name="intent" value="cleanupDuplicateLabelZones" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <button type="submit" className="secondary">Delete duplicate label zones</button>
                  </Form>
                </div>

                <details>
                  <summary>Add label/application zone</summary>
                  <Form method="post" className="form-grid">
                    <input type="hidden" name="intent" value="addLabelZone" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <NativeInput label="Zone name" name="name" placeholder="Front label" />
                    <NativeSelect label="Position" name="position" defaultValue="Front">
                      <option value="Front">Front</option>
                      <option value="Back">Back</option>
                      <option value="Lid">Lid</option>
                      <option value="Side">Side</option>
                      <option value="Bottom">Bottom</option>
                      <option value="Custom">Custom</option>
                    </NativeSelect>
                    <NativeInput label="Width inches" name="widthIn" type="number" step="0.0001" defaultValue="4" />
                    <NativeInput label="Height inches" name="heightIn" type="number" step="0.0001" defaultValue="5" />
                    <NativeInput label="Qty per finished item" name="qtyPerUnit" type="number" step="0.0001" defaultValue="1" />
                    <NativeInput label="Application sec per label" name="applicationSecondsPerLabel" type="number" step="0.01" defaultValue="6" />
                    <NativeSelect label="Media mode" name="mediaMode" defaultValue="fixed">
                      <option value="fixed">Fixed material</option>
                      <option value="media_option">Selectable media option</option>
                      <option value="same_as_zone">Same as another zone</option>
                    </NativeSelect>
                    <NativeSelect label="Fixed material" name="materialId">
                      <option value="">No fixed material</option>
                      {materialOptions.filter((material: any) => String(material.materialType || "").toLowerCase().includes("roll") || String(material.materialType || "").toLowerCase().includes("label") || String(material.name || "").toLowerCase().includes("poseidon") || String(material.name || "").toLowerCase().includes("holo")).map((material: any) => <option key={material.id} value={material.id}>{material.name} | {money(unitCost(material))}/{material.recipeBaseUnit || material.baseUnit || "unit"}</option>)}
                    </NativeSelect>
                    <NativeSelect label="Media option" name="mediaOptionId">
                      <option value="">No media option</option>
                      {(recipe.mediaOptions || []).filter((option: any) => option.active).map((option: any) => <option key={option.id} value={option.id}>{option.name} → {option.material?.name}</option>)}
                    </NativeSelect>
                    <NativeSelect label="Same as zone" name="sameAsZoneId">
                      <option value="">Auto / front zone</option>
                      {(recipe.labelZones || []).map((zone: any) => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
                    </NativeSelect>
                    <label className="field"><span>Required</span><input type="checkbox" name="required" defaultChecked /></label>
                    <NativeTextarea label="Notes" name="notes" placeholder="Example: 4x5 front sticker, Miron jar lid label, back compliance label" />
                    <div className="button-row wide"><button type="submit">Add label zone</button></div>
                  </Form>
                </details>
              </div>


              <div className="card" style={{ marginTop: 12 }}>
                <h3>Shopify Variant Mapping</h3>
                <p className="muted">Sync existing Shopify variants and let the app auto-map side count, bag color, and media from option names. Quantity is not parsed from variants; pricing tiers stay controlled by the selected pricing template.</p>

                <details open>
                  <summary>Sync / auto-map Shopify variants</summary>
                  <Form method="post" className="form-grid">
                    <input type="hidden" name="intent" value="syncShopifyVariants" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <NativeInput label="Shopify Product GID" name="shopifyProductGid" defaultValue={recipe.productGid || ""} placeholder="gid://shopify/Product/..." />
                    <div className="wide muted">
                      Paste or save the Shopify Product GID from the linked product. The sync reads every Shopify variant, then auto-matches:
                      Single/Double sided, Matte/Gloss/Holographic, and Bag Color. Quantity tiers are applied from Pricing Templates, not variants.
                    </div>
                    <div className="button-row wide"><button type="submit">Sync Shopify variants + auto-map</button></div>
                  </Form>
                  <Form method="post" className="button-row">
                    <input type="hidden" name="intent" value="autoMapExistingVariantRules" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <button type="submit" className="secondary">Auto-map existing saved mappings</button>
                  </Form>
                </details>

                {(() => {
                  const visibleRules = (recipe.variantRules || []).filter((rule: any) => itemStatus === "all" ? true : itemStatus === "hidden" ? rule.active === false : rule.active !== false);
                  return visibleRules.length ? <table>
                    <thead><tr><th>Variant rule</th><th>Shopify / SKU</th><th>Cost drivers</th><th>Preview</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      {visibleRules.map((rule: any) => {
                        const variantEstimate = estimateVariantFromRule(recipe, rule);
                        return <tr key={rule.id}>
                          <td><strong>{rule.name}</strong><br/><span className="muted">{rule.shopifyVariantTitle || "Manual mapping"}</span></td>
                          <td>{rule.shopifyVariantGid ? <span className="muted">{rule.shopifyVariantGid}</span> : "No Shopify variant GID"}<br/>{rule.sku ? <span>SKU: {rule.sku}</span> : null}</td>
                          <td>
                            Side: {rule.sideMode}<br/>
                            Bag color: {rule.bagColor || "Any"}<br/>
                            Front: {mediaOptionLabel(recipe.mediaOptions || [], rule.frontMediaOptionId)}<br/>
                            Back: {rule.backMediaMode === "specific" ? mediaOptionLabel(recipe.mediaOptions || [], rule.backMediaOptionId) : "Same as front"}
                          </td>
                          <td>
                            Area: {variantEstimate.area.toFixed(4)} sqft<br/>
                            Apply: {variantEstimate.applySeconds.toFixed(1)} sec<br/>
                            Est cost: {money(variantEstimate.unitCost)}<br/>
                            Target price: {money(variantEstimate.price)}
                          </td>
                          <td><span className={rule.active === false ? "badge yellow" : "badge green"}>{rule.active === false ? "Hidden" : "Active"}</span></td>
                          <td>
                            <details>
                              <summary>Edit mapping</summary>
                              <Form method="post" className="form-grid">
                                <input type="hidden" name="intent" value="updateVariantRule" />
                                <input type="hidden" name="variantRuleId" value={rule.id} />
                                <input type="hidden" name="recipeId" value={recipe.id} />
                                <NativeInput label="Rule name" name="name" defaultValue={rule.name} />
                                <NativeInput label="Shopify variant title" name="shopifyVariantTitle" defaultValue={rule.shopifyVariantTitle || ""} placeholder="Single Sided / Black / Matte" />
                                <NativeInput label="Shopify Variant GID" name="shopifyVariantGid" defaultValue={rule.shopifyVariantGid || ""} />
                                <NativeInput label="Shopify Product GID" name="shopifyProductGid" defaultValue={rule.shopifyProductGid || recipe.productGid || ""} />
                                <NativeInput label="SKU" name="sku" defaultValue={rule.sku || ""} />
                                <NativeSelect label="Side rule" name="sideMode" defaultValue={rule.sideMode || "single"}>
                                  <option value="single">Single sided / front only</option>
                                  <option value="double_same">Double sided / same media</option>
                                  <option value="double_mixed">Double sided / mixed media</option>
                                  <option value="custom">Custom</option>
                                </NativeSelect>
                                <NativeInput label="Bag color / option" name="bagColor" defaultValue={rule.bagColor || ""} placeholder="Black, White, Clear, Any" />
                                <NativeSelect label="Front media" name="frontMediaOptionId" defaultValue={rule.frontMediaOptionId || ""}>
                                  <option value="">Default media</option>
                                  {(recipe.mediaOptions || []).filter((option: any) => option.active !== false).map((option: any) => <option key={option.id} value={option.id}>{option.name} → {option.material?.name}</option>)}
                                </NativeSelect>
                                <NativeSelect label="Back media mode" name="backMediaMode" defaultValue={rule.backMediaMode || "same_as_front"}>
                                  <option value="same_as_front">Same as front</option>
                                  <option value="specific">Specific back media</option>
                                  <option value="none">No back label</option>
                                </NativeSelect>
                                <NativeSelect label="Specific back media" name="backMediaOptionId" defaultValue={rule.backMediaOptionId || ""}>
                                  <option value="">Default / same as front</option>
                                  {(recipe.mediaOptions || []).filter((option: any) => option.active !== false).map((option: any) => <option key={option.id} value={option.id}>{option.name} → {option.material?.name}</option>)}
                                </NativeSelect>
                                <label className="field"><span>Use front zone</span><input type="checkbox" name="useFrontZone" defaultChecked={rule.useFrontZone !== false} /></label>
                                <label className="field"><span>Use back zone</span><input type="checkbox" name="useBackZone" defaultChecked={rule.useBackZone === true} /></label>
                                <label className="field"><span>Active</span><input type="checkbox" name="active" defaultChecked={rule.active !== false} /></label>
                                <NativeTextarea label="Notes" name="notes" defaultValue={rule.notes || ""} />
                                <div className="button-row wide"><button type="submit">Save variant mapping</button></div>
                              </Form>
                            </details>
                            <div className="button-row">
                              <Form method="post"><input type="hidden" name="intent" value={rule.active === false ? "restoreVariantRule" : "archiveVariantRule"} /><input type="hidden" name="variantRuleId" value={rule.id} /><button type="submit" className="secondary">{rule.active === false ? "Restore" : "Hide"}</button></Form>
                              <Form method="post"><input type="hidden" name="intent" value="deleteVariantRule" /><input type="hidden" name="variantRuleId" value={rule.id} /><button type="submit" className="danger">Delete forever</button></Form>
                            </div>
                          </td>
                        </tr>;
                      })}
                    </tbody>
                  </table> : <p className="muted">No variant mappings match this item filter. Add mappings for existing Shopify variants like Single Sided / Matte / Black or Double Sided / Holographic.</p>;
                })()}

                <Form method="post" className="button-row">
                  <input type="hidden" name="intent" value="cleanupDuplicateVariantRules" />
                  <input type="hidden" name="recipeId" value={recipe.id} />
                  <button type="submit" className="secondary">Delete duplicate variant mappings</button>
                </Form>

                <details>
                  <summary>Add manual Shopify variant / option mapping</summary>
                  <Form method="post" className="form-grid">
                    <input type="hidden" name="intent" value="addVariantRule" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <NativeInput label="Rule name" name="name" placeholder="Single Sided - Matte - Black" />
                    <NativeInput label="Shopify variant title" name="shopifyVariantTitle" placeholder="Single Sided / Black / Matte" />
                    <NativeInput label="Shopify Variant GID" name="shopifyVariantGid" placeholder="optional for now" />
                    <NativeInput label="Shopify Product GID" name="shopifyProductGid" defaultValue={recipe.productGid || ""} placeholder="optional for now" />
                    <NativeInput label="SKU" name="sku" />
                    <NativeSelect label="Side rule" name="sideMode" defaultValue="single">
                      <option value="single">Single sided / front only</option>
                      <option value="double_same">Double sided / same media</option>
                      <option value="double_mixed">Double sided / mixed media</option>
                      <option value="custom">Custom</option>
                    </NativeSelect>
                    <NativeInput label="Bag color / option" name="bagColor" placeholder="Black, White, Clear, Any" />
                    <NativeSelect label="Front media" name="frontMediaOptionId">
                      <option value="">Default media</option>
                      {(recipe.mediaOptions || []).filter((option: any) => option.active !== false).map((option: any) => <option key={option.id} value={option.id}>{option.name} → {option.material?.name}</option>)}
                    </NativeSelect>
                    <NativeSelect label="Back media mode" name="backMediaMode" defaultValue="same_as_front">
                      <option value="same_as_front">Same as front</option>
                      <option value="specific">Specific back media</option>
                      <option value="none">No back label</option>
                    </NativeSelect>
                    <NativeSelect label="Specific back media" name="backMediaOptionId">
                      <option value="">Default / same as front</option>
                      {(recipe.mediaOptions || []).filter((option: any) => option.active !== false).map((option: any) => <option key={option.id} value={option.id}>{option.name} → {option.material?.name}</option>)}
                    </NativeSelect>
                    <label className="field"><span>Use front zone</span><input type="checkbox" name="useFrontZone" defaultChecked /></label>
                    <label className="field"><span>Use back zone</span><input type="checkbox" name="useBackZone" /></label>
                    <NativeTextarea label="Notes" name="notes" placeholder="Manual fallback only. Normal variants should come from Shopify sync. Quantity tiers are controlled by pricing templates." />
                    <div className="button-row wide"><button type="submit">Add variant mapping</button></div>
                  </Form>
                </details>
              </div>

              <div className="card" style={{ marginTop: 12 }}>
                <h3>Recipe Materials</h3>
                {visibleRecipeMaterials.length ? <table>
                  <thead><tr><th>Material</th><th>Type</th><th>Qty / unit</th><th>Waste</th><th>Status</th><th>Cost/unit</th><th></th></tr></thead>
                  <tbody>
                    {visibleRecipeMaterials.map((row: any) => <tr key={row.id}>
                      <td>{row.material?.name}</td>
                      <td>{row.usageType}</td>
                      <td>{row.quantity} {row.unit}</td>
                      <td>{row.includeWaste ? `${row.wastePct || 0}%` : "No waste"}</td>
                      <td><span className={row.active === false ? "badge yellow" : "badge green"}>{row.active === false ? "Hidden" : "Active"}</span></td>
                      <td>{row.active === false ? <span className="muted">Not counted</span> : money(unitCost(row.material) * Number(row.quantity || 0) * (row.includeWaste ? 1 + Number(row.wastePct || 0) / 100 : 1))}</td>
                      <td>
                        <details>
                          <summary>Edit row</summary>
                          <Form method="post" className="form-grid">
                            <input type="hidden" name="intent" value="updateMaterialRow" />
                            <input type="hidden" name="recipeMaterialId" value={row.id} />
                            <NativeSelect label="Material" name="materialId" defaultValue={row.materialId}>
                              {materialOptions.map((material: any) => <option key={material.id} value={material.id}>{material.name} | {material.materialType} | {material.productFamilies}</option>)}
                            </NativeSelect>
                            <NativeSelect label="Usage type" name="usageType" defaultValue={row.usageType}>
                              <option value="media">Media</option>
                              <option value="ink">Ink / coating</option>
                              <option value="blank">Blank / base item</option>
                              <option value="laminate">Laminate</option>
                              <option value="packaging">Packaging</option>
                              <option value="sourced">Sourced</option>
                              <option value="other">Other</option>
                            </NativeSelect>
                            <NativeInput label="Qty used per unit" name="quantity" type="number" step="0.0001" defaultValue={row.quantity} />
                            <NativeSelect label="Unit" name="unit" defaultValue={row.unit}>
                              {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                            </NativeSelect>
                            <NativeInput label="Waste %" name="wastePct" type="number" step="0.01" defaultValue={row.wastePct} />
                            <label className="field"><span>Include waste</span><input type="checkbox" name="includeWaste" defaultChecked={row.includeWaste} /></label>
                            <label className="field"><span>Active / counted in cost</span><input type="checkbox" name="active" defaultChecked={row.active !== false} /></label>
                            <NativeTextarea label="Notes" name="notes" defaultValue={row.notes || ""} />
                            <div className="button-row wide"><button type="submit">Save material row</button></div>
                          </Form>
                        </details>
                        <div className="button-row">
                          <Form method="post">
                            <input type="hidden" name="intent" value={row.active === false ? "restoreMaterialRow" : "archiveMaterialRow"} />
                            <input type="hidden" name="recipeMaterialId" value={row.id} />
                            <button type="submit" className="secondary">{row.active === false ? "Restore" : "Hide"}</button>
                          </Form>
                          <Form method="post">
                            <input type="hidden" name="intent" value="deleteMaterialRow" />
                            <input type="hidden" name="recipeMaterialId" value={row.id} />
                            <button type="submit" className="danger">Delete forever</button>
                          </Form>
                        </div>
                      </td>
                    </tr>)}
                  </tbody>
                </table> : <p className="muted">No recipe material rows match this item filter. Switch item rows to All/Hidden or add a material row.</p>}

                <Form method="post" className="button-row">
                  <input type="hidden" name="intent" value="cleanupDuplicateMaterials" />
                  <input type="hidden" name="recipeId" value={recipe.id} />
                  <button type="submit" className="secondary">Delete duplicate material rows</button>
                </Form>

                <details>
                  <summary>Add material to recipe</summary>
                  {activeZonesForRecipe.length ? <p className="muted">This recipe already calculates label media from zones. Add only fixed/base materials here, like blank bags, jars, boxes, packaging, or sourced base items. Do not add Matte/Gloss/Holographic media here unless it is an extra fixed material.</p> : null}
                  <Form method="post" className="form-grid">
                    <input type="hidden" name="intent" value="addMaterial" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <NativeSelect label="Material" name="materialId">
                      {materialOptions.map((material: any) => <option key={material.id} value={material.id}>{material.name} | {material.materialType} | {material.productFamilies}</option>)}
                    </NativeSelect>
                    <NativeSelect label="Usage type" name="usageType" defaultValue="blank">
                      <option value="media">Media</option>
                      <option value="ink">Ink / coating</option>
                      <option value="blank">Blank / base item</option>
                      <option value="laminate">Laminate</option>
                      <option value="packaging">Packaging</option>
                      <option value="sourced">Sourced</option>
                      <option value="other">Other</option>
                    </NativeSelect>
                    <NativeInput label="Qty used per unit" name="quantity" type="number" step="0.0001" defaultValue="1" />
                    <NativeSelect label="Unit" name="unit" defaultValue="each">
                      {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                    </NativeSelect>
                    <NativeInput label="Waste %" name="wastePct" type="number" step="0.01" defaultValue="0" />
                    <label className="field"><span>Include waste</span><input type="checkbox" name="includeWaste" /></label>
                    <NativeTextarea label="Notes" name="notes" />
                    <div className="button-row wide"><button type="submit">Add material</button></div>
                  </Form>
                </details>
              </div>
            </details>
          );
        }) : <p className="muted">No recipes match this filter. Create a recipe above or switch the status filter to Archived/All.</p>}
      </div>
    </div>
  );
}
