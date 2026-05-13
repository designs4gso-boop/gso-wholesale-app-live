import { Form, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
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

function estimateRecipe(recipe: any, laborRate = 25) {
  const qty = Math.max(1, Number(recipe.defaultQuantity || recipe.minQuantity || 1));
  const materialCostPerUnit = (recipe.materials || []).reduce((sum: number, row: any) => {
    const base = unitCost(row.material);
    const quantity = Number(row.quantity || 0);
    const wasteMultiplier = row.includeWaste ? 1 + (Number(row.wastePct || 0) / 100) : 1;
    return sum + base * quantity * wasteMultiplier;
  }, 0);
  const perUnitLaborSeconds = Number(recipe.applicationLaborSecondsPerUnit || 0) + Number(recipe.packingLaborSecondsPerUnit || 0);
  const perUnitLaborCost = (perUnitLaborSeconds / 3600) * laborRate;
  const perJobLaborCost = ((Number(recipe.laborMinutes || 0) + Number(recipe.prepressMinutes || 0)) / 60) * laborRate / qty;
  const setupCostPerUnit = Number(recipe.setupCost || 0) / qty;
  const wasteMultiplier = 1 + (Number(recipe.wastePct || 0) / 100);
  const unitCostBeforeWaste = materialCostPerUnit + perUnitLaborCost + perJobLaborCost + setupCostPerUnit;
  const unitCostTotal = unitCostBeforeWaste * wasteMultiplier;
  const margin = Number(recipe.targetMarginPct || 50);
  const suggestedPrice = margin >= 99 ? unitCostTotal : unitCostTotal / (1 - margin / 100);
  return { qty, materialCostPerUnit, perUnitLaborCost, perJobLaborCost, setupCostPerUnit, unitCostTotal, suggestedPrice };
}

function priceFromMargin(cost: number, marginPct: number) {
  if (marginPct >= 99) return cost;
  return cost / (1 - marginPct / 100);
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [templates, recipes, materials, machines] = await Promise.all([
    db.productTypeProfile.findMany({ where: { shop }, orderBy: [{ active: "desc" }, { name: "asc" }] }),
    db.productRecipe.findMany({
      where: { shop },
      orderBy: [{ active: "desc" }, { updatedAt: "desc" }],
      include: {
        productTypeProfile: true,
        materials: { include: { material: true }, orderBy: { createdAt: "asc" } },
        tiers: { orderBy: { minQty: "asc" } },
        machineRules: { include: { preferredMachine: true } },
      },
    }),
    db.material.findMany({ where: { shop, active: true, useInRecipes: true }, orderBy: { name: "asc" } }),
    db.machine.findMany({ where: { shop, active: true }, orderBy: { name: "asc" } }),
  ]);

  const activeTemplates = templates.filter((template: any) => template.active);
  return Response.json({ templates, activeTemplates, recipes, materials, machines });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
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

    return redirect("/app/erp/product-setup?created=recipe");
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

  if (intent === "removeMaterial") {
    await db.recipeMaterial.deleteMany({ where: { shop, id: String(formData.get("recipeMaterialId") || "") } });
    return Response.json({ ok: true, message: "Material removed from recipe." });
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
  const { templates, activeTemplates, recipes, materials, machines } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const [searchParams] = useSearchParams();
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

      {searchParams.get("created") === "recipe" ? <div className="card"><span className="badge green">Product recipe created. Scroll to Product Recipes to add materials.</span></div> : null}
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
            <NativeInput label="Application sec / unit" name="applicationLaborSecondsPerUnit" type="number" step="0.01" defaultValue="0" />
            <NativeInput label="Packing sec / unit" name="packingLaborSecondsPerUnit" type="number" step="0.01" defaultValue="0" />
            <label className="field"><span>Use in quotes</span><input type="checkbox" name="useInQuotes" defaultChecked /></label>
            <label className="field"><span>Cost review needed</span><input type="checkbox" name="costReviewNeeded" /></label>
            <NativeTextarea label="Notes" name="notes" />
            <div className="button-row wide"><button type="submit" name="intent" value="createRecipe">Create recipe</button></div>
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
        {recipes.length ? recipes.map((recipe: any) => {
          const estimate = estimateRecipe(recipe);
          const templateTiers = recipe.pricingTemplateMode === "template" ? parseTiers(recipe.productTypeProfile?.tierTemplate) : [];
          const activeTiers = recipe.tiers?.length ? recipe.tiers : templateTiers;
          const machineId = recipe.machineRules?.[0]?.preferredMachineId || "";
          return (
            <details key={recipe.id} open={false}>
              <summary>
                {recipe.name} <span className="badge">{recipe.productFamily || recipe.productType}</span>
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
                    <NativeInput label="Application sec / unit" name="applicationLaborSecondsPerUnit" type="number" step="0.01" defaultValue={recipe.applicationLaborSecondsPerUnit} />
                    <NativeInput label="Packing sec / unit" name="packingLaborSecondsPerUnit" type="number" step="0.01" defaultValue={recipe.packingLaborSecondsPerUnit} />
                    <label className="field"><span>Use in quotes</span><input type="checkbox" name="useInQuotes" defaultChecked={recipe.useInQuotes} /></label>
                    <label className="field"><span>Cost review needed</span><input type="checkbox" name="costReviewNeeded" defaultChecked={recipe.costReviewNeeded} /></label>
                    <NativeTextarea label="Notes" name="notes" defaultValue={recipe.notes || ""} />
                    <div className="button-row wide"><button type="submit">Save recipe</button></div>
                  </Form>

                  <Form method="post" className="button-row">
                    <input type="hidden" name="intent" value="archiveRecipe" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <button type="submit" className="danger">Archive recipe</button>
                  </Form>
                </div>

                <div>
                  <h3>Cost + Tier Preview</h3>
                  <p><strong>Default quantity:</strong> {estimate.qty}</p>
                  <p><strong>Material cost/unit:</strong> {money(estimate.materialCostPerUnit)}</p>
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
                <h3>Recipe Materials</h3>
                {recipe.materials?.length ? <table>
                  <thead><tr><th>Material</th><th>Type</th><th>Qty / unit</th><th>Waste</th><th>Cost/unit</th><th></th></tr></thead>
                  <tbody>
                    {recipe.materials.map((row: any) => <tr key={row.id}>
                      <td>{row.material?.name}</td>
                      <td>{row.usageType}</td>
                      <td>{row.quantity} {row.unit}</td>
                      <td>{row.includeWaste ? `${row.wastePct || 0}%` : "No waste"}</td>
                      <td>{money(unitCost(row.material) * Number(row.quantity || 0) * (row.includeWaste ? 1 + Number(row.wastePct || 0) / 100 : 1))}</td>
                      <td>
                        <Form method="post">
                          <input type="hidden" name="intent" value="removeMaterial" />
                          <input type="hidden" name="recipeMaterialId" value={row.id} />
                          <button type="submit" className="danger">Remove</button>
                        </Form>
                      </td>
                    </tr>)}
                  </tbody>
                </table> : <p className="muted">No materials added yet.</p>}

                <details>
                  <summary>Add material to recipe</summary>
                  <Form method="post" className="form-grid">
                    <input type="hidden" name="intent" value="addMaterial" />
                    <input type="hidden" name="recipeId" value={recipe.id} />
                    <NativeSelect label="Material" name="materialId">
                      {materialOptions.map((material: any) => <option key={material.id} value={material.id}>{material.name} | {material.materialType} | {material.productFamilies}</option>)}
                    </NativeSelect>
                    <NativeSelect label="Usage type" name="usageType" defaultValue="media">
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
                    <label className="field"><span>Include waste</span><input type="checkbox" name="includeWaste" defaultChecked /></label>
                    <NativeTextarea label="Notes" name="notes" />
                    <div className="button-row wide"><button type="submit">Add material</button></div>
                  </Form>
                </details>
              </div>
            </details>
          );
        }) : <p className="muted">No recipes yet. Create your first product recipe above.</p>}
      </div>
    </div>
  );
}
