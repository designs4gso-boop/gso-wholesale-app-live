import {
  Badge,
  BlockStack,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { useState } from "react";
import { Form, redirect, useActionData, useLoaderData } from "react-router";
import { officialMoqForFamily, salesRulesForFamily } from "../lib/product-family-sales-rules";
import { findLikelyDuplicates } from "../lib/product-family-registry";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const WIZARD_MODES = [
  { value: "existing-family", label: "Add product from existing family/template" },
  { value: "related-label", label: "Create related label/sticker product from existing Shopify product" },
  { value: "new-family", label: "Create new product family" },
  { value: "link-existing-shopify", label: "Link existing Shopify product to ERP" },
];

const SHOPIFY_SETUPS = [
  { value: "existing-shopify", label: "Existing Shopify product" },
  { value: "create-shopify-draft-later", label: "Create Shopify draft product later" },
  { value: "simple-product", label: "Simple product" },
  { value: "shopify-variants", label: "Shopify variants" },
  { value: "gso-configurator-options", label: "GSO configurator options" },
];

const LABEL_MODES = [
  { value: "none", label: "No related label product" },
  { value: "label-only", label: "Label-only product" },
  { value: "label-application", label: "Label + application option" },
  { value: "finished-package", label: "Finished product/package" },
];

const APPLICATION_MODES = ["None", "Hand apply", "Machine apply", "Outsourced apply"];
const BASE_ITEM_SOURCES = ["GSO supplies", "Customer supplies", "Vendor/outsource supplies"];
const LABEL_ZONES = ["Side", "Lid", "Front", "Back", "Full wrap", "Custom"];
const NEW_FAMILY_PRICING = ["auto_margin", "fixed_price", "markup_over_cost", "manual_review"];
const UNIT_OPTIONS = ["each", "sqft", "sqin", "linear_ft", "roll", "sheet"];

const PRODUCT_FAMILIES = [
  {
    value: "jars",
    label: "Jars",
    summary: [
      "Uses vendor/source jar cost",
      "Can support label zones like side, lid, or side + lid",
      "Can support jar color, material, and finish options",
      "Usually copies tiers and margin from an existing jar setup",
    ],
  },
  {
    value: "sticker-bags",
    label: "Sticker Bags",
    summary: [
      "Uses blank bag cost plus label, print, and application logic",
      "Can support material, finish, and quantity options",
    ],
  },
  {
    value: "dtp-pouches",
    label: "DTP Pouches",
    summary: [
      "Uses pouch material, printing, finishing, or sourced cost logic",
      "Can support stock or custom shape and MOQ tiers",
    ],
  },
  {
    value: "boxes",
    label: "Boxes",
    summary: [
      "Uses board, material, print, finish, cut, and assembly logic",
      "Can support size, finish, and quantity tiers",
    ],
  },
  {
    value: "labels-stickers",
    label: "Labels / Stickers",
    summary: [
      "Uses material, ink, machine, cut, and labor logic",
      "Can support dimensions, finish, cut type, and tiers",
    ],
  },
  {
    value: "banners",
    label: "Banners",
    summary: [
      "Uses square-foot material, printer/machine, and finishing labor",
      "Can support Mimaki/Roland routing, hem/grommets, and indoor/outdoor setup",
    ],
  },
  {
    value: "apparel-dtf",
    label: "Apparel / DTF",
    summary: [
      "Uses blank garment or transfer cost plus print/application labor",
      "Can support size, color, and garment variants",
    ],
  },
  {
    value: "sourced-blank-resale",
    label: "Sourced / Blank Resale",
    summary: [
      "Uses vendor/source item cost plus markup",
      "Can support MOQ and cost tiers",
    ],
  },
  {
    value: "custom-other",
    label: "Custom / Other",
    summary: [
      "Planning-only custom family",
      "Choose pricing method and cost components later",
    ],
  },
];

function clean(value: string | null, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function formText(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key);
  const text = String(value || "").trim();
  return text || fallback;
}

function safeChoice(value: string, options: { value: string }[], fallback: string) {
  return options.some((option) => option.value === value) ? value : fallback;
}

function familyLabel(value: string) {
  return PRODUCT_FAMILIES.find((family) => family.value === value)?.label || "Custom / Other";
}

function familySummary(value: string) {
  return PRODUCT_FAMILIES.find((family) => family.value === value)?.summary || PRODUCT_FAMILIES[PRODUCT_FAMILIES.length - 1].summary;
}

function normalizeGid(value: string) {
  const text = value.trim();
  if (text.startsWith("gid://shopify/")) return text;
  const digitsOnly = text.replace(/[^0-9]/g, "");
  return digitsOnly ? `gid://shopify/Product/${digitsOnly}` : "";
}

function parseTiers(value: string) {
  return value
    .split(",")
    .map((part) => parseInt(part.trim(), 10))
    .filter((qty) => Number.isFinite(qty) && qty > 0)
    .sort((a, b) => a - b);
}

function intValue(value: string, fallback = 0) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveInt(value: string, fallback = 1) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Math.max(1, fallback);
}

function numberValue(value: string, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function slugify(value: string) {
  return String(value || "product")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "product";
}

function inferKind(profile: any) {
  const text = `${profile?.calculatorKind || ""} ${profile?.key || ""} ${profile?.name || ""}`.toLowerCase();
  if (text.includes("jar")) return "Jars";
  if (text.includes("banner")) return "Banners";
  if (text.includes("label") || text.includes("sticker")) return text.includes("bag") ? "Sticker Bags" : "Labels / Stickers";
  if (text.includes("box")) return "Boxes";
  if (text.includes("dtp") || text.includes("pouch")) return "DTP / Pouches";
  if (text.includes("source") || text.includes("outsourc")) return "Sourced";
  return "General";
}

function familyForProfile(profile: any) {
  const text = `${profile?.calculatorKind || ""} ${profile?.key || ""} ${profile?.name || ""}`.toLowerCase();
  if (text.includes("jar")) return "jars";
  if (text.includes("banner")) return "banners";
  if (text.includes("dtf") || text.includes("apparel") || text.includes("garment")) return "apparel-dtf";
  if (text.includes("box")) return "boxes";
  if (text.includes("dtp") || text.includes("pouch")) return "dtp-pouches";
  if (text.includes("source") || text.includes("outsourc") || text.includes("resale")) return "sourced-blank-resale";
  if (text.includes("label") || text.includes("sticker")) return text.includes("bag") ? "sticker-bags" : "labels-stickers";
  return "custom-other";
}

function termsForKind(kind: string) {
  if (kind === "Jars") return ["jar"];
  if (kind === "Banners") return ["banner"];
  if (kind === "Labels / Stickers" || kind === "Sticker Bags") return ["label", "sticker", "roll"];
  if (kind === "Boxes") return ["box"];
  if (kind === "DTP / Pouches") return ["dtp", "pouch", "bag"];
  return [];
}

function termsForFamily(value: string) {
  if (value === "jars") return ["jar"];
  if (value === "banners") return ["banner"];
  if (value === "labels-stickers") return ["label", "sticker", "roll"];
  if (value === "sticker-bags") return ["sticker", "label", "bag"];
  if (value === "boxes") return ["box"];
  if (value === "dtp-pouches") return ["dtp", "pouch"];
  if (value === "apparel-dtf") return ["apparel", "dtf", "garment"];
  if (value === "sourced-blank-resale") return ["source", "vendor", "blank"];
  return [];
}

function parseTemplateTiers(value: string, fallbackMargin: number) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .map((tier) => ({
          minQty: positiveInt(String(tier?.minQty || tier?.min || 0), 0),
          maxQty: tier?.maxQty || tier?.max ? positiveInt(String(tier.maxQty || tier.max), 0) : null,
          marginPct: tier?.marginPct == null ? fallbackMargin : numberValue(String(tier.marginPct), fallbackMargin),
          fixedPrice: tier?.fixedPrice == null ? null : numberValue(String(tier.fixedPrice), 0),
          notes: "Copied from product family template.",
        }))
        .filter((tier) => tier.minQty > 0);
    }
  } catch (_error) {
    return [];
  }
  return [];
}

function tiersFromBreakpoints(value: string, marginPct: number) {
  return parseTiers(value).map((minQty, index, rows) => ({
    minQty,
    maxQty: rows[index + 1] ? rows[index + 1] - 1 : null,
    marginPct,
    fixedPrice: null,
    notes: "Created from Product Builder quantity tiers.",
  }));
}

function recommendedAuthority(params: any, selectedKind: string) {
  if (params.shopifySetup === "gso-configurator-options") {
    return {
      label: "GSO configurator records",
      detail: "Use ConfiguratorProduct, ConfiguratorOption, and ConfiguratorPricingRule when customer choices affect price, quantity tiers, material, finish, jar color, or other options.",
    };
  }
  if (params.wizardMode === "related-label") {
    return {
      label: "Recipe cost engine for related label product",
      detail: "Use ProductRecipe with material, machine, label-zone, application labor, and margin inputs. The related label should usually be its own Shopify product linked to the base item.",
    };
  }
  if (params.wizardMode === "new-family") {
    return {
      label: "New family/template planning",
      detail: "Plan the ProductTypeProfile and first ProductRecipe, then review cost components before any ERP records are created.",
    };
  }
  if (params.wizardMode === "link-existing-shopify") {
    return {
      label: "ERP mapping first",
      detail: "Map the existing Shopify product to a recipe or configurator product before changing pricing or production behavior.",
    };
  }
  return {
    label: "Family/template recipe pricing",
    detail: `${selectedKind || "The selected family"} should inherit ProductRecipe and RecipeTier patterns unless the product is intentionally promoted to GSO configurator options.`,
  };
}

function statusFor(params: any, duplicateCount: number, warnings: string[]) {
  if (duplicateCount > 0) return "Duplicate risk";
  if (warnings.some((warning) => warning.includes("cost") || warning.includes("margin") || warning.includes("tier"))) return "Needs cost setup";
  if (warnings.some((warning) => warning.includes("Shopify"))) return "Needs Shopify mapping";
  if (warnings.length) return "Needs more info";
  return "Ready for ERP draft planning";
}

function statusTone(status: string) {
  if (status === "Ready for ERP draft planning") return "success";
  if (status === "Duplicate risk") return "warning";
  return "attention";
}

function inputStyle() {
  return { minHeight: 36, padding: "6px 10px", border: "1px solid #8c9196", borderRadius: 4, width: "100%" };
}

function fieldGrid(columns = 3) {
  return { display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 12 };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <Text as="span" tone="subdued">{label}</Text>
      {children}
    </label>
  );
}

function StepHeader({ number, title, help }: { number: number; title: string; help?: string }) {
  return (
    <BlockStack gap="100">
      <InlineStack gap="200" blockAlign="center">
        <Badge>{`Step ${number}`}</Badge>
        <Text as="h2" variant="headingMd">{title}</Text>
      </InlineStack>
      {help ? <Text as="p" tone="subdued">{help}</Text> : null}
    </BlockStack>
  );
}

function DuplicateList({ title, rows, render }: { title: string; rows: any[]; render: (row: any) => string }) {
  return (
    <BlockStack gap="100">
      <Text as="h3" variant="headingSm">{title}</Text>
      {rows.length ? (
        <BlockStack gap="050">
          {rows.map((row) => <Text as="p" key={row.id}>{render(row)}</Text>)}
        </BlockStack>
      ) : (
        <Text as="p" tone="subdued">No matches found.</Text>
      )}
    </BlockStack>
  );
}

function readinessSentence(status: string, warnings: string[], duplicateCount: number) {
  if (duplicateCount > 0) return "Duplicate risk found. Review Advanced ERP checks before creating anything.";
  if (status === "Ready for ERP draft planning") return "This plan looks ready for an ERP draft, but Shopify creation will come later.";
  if (warnings.length) {
    const missing = warnings
      .slice(0, 3)
      .map((warning) => warning.replace(/\.$/, "").toLowerCase())
      .join(", ");
    return `This product is not ready yet because it is missing or needs review: ${missing}.`;
  }
  return "This plan needs more review before any records are created.";
}

function RecipeSummary({ recipes }: { recipes: any[] }) {
  if (!recipes.length) return <Text as="p" tone="subdued">No example recipes found for this template yet.</Text>;
  return (
    <BlockStack gap="100">
      {recipes.slice(0, 3).map((recipe) => (
        <Text as="p" key={recipe.id}>
          {recipe.name} · {recipe._count.tiers} tier(s), {recipe._count.materials} material row(s), {recipe._count.labelZones} label zone(s)
        </Text>
      ))}
    </BlockStack>
  );
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formText(formData, "intent");

  if (intent !== "createErpDraft") {
    return Response.json({ ok: false, message: "Unsupported Product Builder action." }, { status: 400 });
  }

  const name = formText(formData, "title");
  const sku = formText(formData, "sku");
  const explicitProductType = formText(formData, "productType");
  const templateId = formText(formData, "templateId");
  const productFamily = safeChoice(formText(formData, "productFamily"), PRODUCT_FAMILIES, "custom-other");
  const shopifyProductGid = normalizeGid(formText(formData, "shopifyHandle"));
  const errors: string[] = [];

  if (!name) errors.push("Product name is required.");
  if (!sku && !explicitProductType) errors.push("Add either a SKU/product key or an ERP product type key.");

  const selectedTemplate = templateId
    ? await db.productTypeProfile.findFirst({
        where: { shop, id: templateId, active: true },
        select: {
          id: true,
          key: true,
          name: true,
          productionMode: true,
          minQuantity: true,
          defaultQuantity: true,
          defaultMarginPct: true,
          tierBreakpoints: true,
          tierTemplate: true,
        },
      })
    : null;

  if (templateId && !selectedTemplate) {
    errors.push("Selected copy-from example was not found for this shop.");
  }

  const officialMoq = officialMoqForFamily(productFamily);
  const moq = positiveInt(formText(formData, "moq"), officialMoq || selectedTemplate?.minQuantity || selectedTemplate?.defaultQuantity || 1);
  const targetMargin = numberValue(formText(formData, "targetMargin"), Number(selectedTemplate?.defaultMarginPct || 40));
  numberValue(formText(formData, "markup"), 0);
  const productType = explicitProductType || selectedTemplate?.key || slugify(name);

  const duplicateChecks: Promise<any>[] = [];
  if (sku) {
    duplicateChecks.push(db.productRecipe.findFirst({ where: { shop, sku }, select: { id: true, name: true, sku: true } }));
  } else {
    duplicateChecks.push(Promise.resolve(null));
  }
  if (explicitProductType) {
    duplicateChecks.push(db.productRecipe.findFirst({ where: { shop, productType: explicitProductType }, select: { id: true, name: true, productType: true } }));
  } else {
    duplicateChecks.push(Promise.resolve(null));
  }
  if (name) {
    duplicateChecks.push(db.productRecipe.findFirst({ where: { shop, name: { equals: name, mode: "insensitive" } }, select: { id: true, name: true } }));
  } else {
    duplicateChecks.push(Promise.resolve(null));
  }
  if (shopifyProductGid) {
    duplicateChecks.push(db.productRecipe.findFirst({ where: { shop, productGid: shopifyProductGid }, select: { id: true, name: true, productGid: true } }));
    duplicateChecks.push(db.configuratorProduct.findFirst({ where: { shop, shopifyProductGid }, select: { id: true, title: true, shopifyProductGid: true } }));
    duplicateChecks.push(db.recipeVariantRule.findFirst({ where: { shop, shopifyProductGid }, select: { id: true, name: true, shopifyProductGid: true } }));
  }

  const [skuDuplicate, productTypeDuplicate, nameDuplicate, recipeGidDuplicate, configuratorGidDuplicate, variantRuleGidDuplicate] = await Promise.all(duplicateChecks);
  if (skuDuplicate) errors.push(`A ProductRecipe already uses SKU ${sku}.`);
  if (productTypeDuplicate) errors.push(`A ProductRecipe already uses ERP product type ${explicitProductType}.`);
  if (nameDuplicate) errors.push(`A ProductRecipe already uses the name ${name}.`);
  if (recipeGidDuplicate || configuratorGidDuplicate || variantRuleGidDuplicate) errors.push("That Shopify Product GID is already mapped in ERP.");

  if (errors.length) {
    return Response.json({ ok: false, message: "ERP draft was not created.", errors }, { status: 400 });
  }

  const exampleRecipe = selectedTemplate
    ? await db.productRecipe.findFirst({
        where: {
          shop,
          active: true,
          OR: [
            { productTypeProfileId: selectedTemplate.id },
            { productType: selectedTemplate.key },
          ],
        },
        select: {
          id: true,
          tiers: {
            orderBy: { minQty: "asc" },
            select: { minQty: true, maxQty: true, marginPct: true, fixedPrice: true, notes: true },
          },
        },
      })
    : null;

  const sourceTiers = exampleRecipe?.tiers?.length
    ? exampleRecipe.tiers.map((tier) => ({
        minQty: tier.minQty,
        maxQty: tier.maxQty,
        marginPct: tier.marginPct,
        fixedPrice: tier.fixedPrice,
        notes: tier.notes || "Copied from Product Builder example recipe.",
      }))
    : parseTemplateTiers(String(selectedTemplate?.tierTemplate || ""), targetMargin).length
      ? parseTemplateTiers(String(selectedTemplate?.tierTemplate || ""), targetMargin)
      : tiersFromBreakpoints(formText(formData, "tiers") || String(selectedTemplate?.tierBreakpoints || ""), targetMargin);

  // 15B duplicate prevention: WARN (never silently merge). Same normalized
  // name/SKU as an existing recipe blocks creation unless explicitly confirmed.
  const confirmDuplicate = String(formData.get("confirmDuplicate") || "") === "1";
  const existingRecipes = await db.productRecipe.findMany({ where: { shop }, select: { id: true, name: true, sku: true }, orderBy: { updatedAt: "desc" }, take: 400 });
  const likelyDuplicates = findLikelyDuplicates(
    { name, vendorSku: sku || "" },
    existingRecipes.map((row) => ({ id: row.id, name: row.name, vendorSku: row.sku })),
  );
  if (likelyDuplicates.length && !confirmDuplicate) {
    return Response.json({
      ok: false,
      message: `Likely duplicate product record(s) already exist: ${likelyDuplicates.slice(0, 5).map((row) => row.name).join("; ")}. Nothing was created or merged — tick "Create anyway (not a duplicate)" to confirm this is a genuinely new product.`,
    }, { status: 409 });
  }
  const recipe = await db.$transaction(async (tx) => {
    const draft = await tx.productRecipe.create({
      data: {
        shop,
        name,
        sku: sku || null,
        productType,
        productFamily: familyLabel(productFamily),
        productTypeProfileId: selectedTemplate?.id || null,
        pricingTemplateMode: "template",
        productionMode: selectedTemplate?.productionMode || "in_house",
        minQuantity: moq,
        defaultQuantity: moq,
        targetMarginPct: targetMargin,
        notes: "Created by Product Builder as inactive ERP draft. Review costs, materials, tiers, and Shopify mapping before activation.",
        active: false,
        useInQuotes: false,
        costReviewNeeded: true,
        costReviewReasons: "Draft created from Product Builder. Complete cost setup before activating.",
        costReviewSource: "product_builder",
      },
      select: { id: true },
    });

    if (sourceTiers.length) {
      await tx.recipeTier.createMany({
        data: sourceTiers.map((tier) => ({
          shop,
          recipeId: draft.id,
          minQty: tier.minQty,
          maxQty: tier.maxQty,
          marginPct: tier.marginPct,
          fixedPrice: tier.fixedPrice,
          notes: tier.notes,
        })),
      });
    }

    return draft;
  });

  return redirect(`/app/erp/product-setup?recipeStatus=archived&recipeId=${recipe.id}`);
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);

  const params = {
    wizardMode: safeChoice(clean(url.searchParams.get("wizardMode"), "existing-family"), WIZARD_MODES, "existing-family"),
    productFamily: clean(url.searchParams.get("productFamily")),
    templateId: clean(url.searchParams.get("templateId")),
    title: clean(url.searchParams.get("title")),
    productType: clean(url.searchParams.get("productType")),
    sku: clean(url.searchParams.get("sku")),
    shopifyHandle: clean(url.searchParams.get("shopifyHandle")),
    moq: clean(url.searchParams.get("moq")),
    tiers: clean(url.searchParams.get("tiers")),
    targetMargin: clean(url.searchParams.get("targetMargin")),
    markup: clean(url.searchParams.get("markup")),
    shopifySetup: safeChoice(clean(url.searchParams.get("shopifySetup"), "existing-shopify"), SHOPIFY_SETUPS, "existing-shopify"),
    variantOption1Name: clean(url.searchParams.get("variantOption1Name")),
    variantOption1Values: clean(url.searchParams.get("variantOption1Values")),
    variantOption2Name: clean(url.searchParams.get("variantOption2Name")),
    variantOption2Values: clean(url.searchParams.get("variantOption2Values")),
    variantOption3Name: clean(url.searchParams.get("variantOption3Name")),
    variantOption3Values: clean(url.searchParams.get("variantOption3Values")),
    labelMode: safeChoice(clean(url.searchParams.get("labelMode"), "none"), LABEL_MODES, "none"),
    baseProduct: clean(url.searchParams.get("baseProduct")),
    labelName: clean(url.searchParams.get("labelName")),
    labelZones: url.searchParams.getAll("labelZones").map((value) => String(value)),
    applicationMode: clean(url.searchParams.get("applicationMode"), "None"),
    baseItemSource: clean(url.searchParams.get("baseItemSource"), "GSO supplies"),
    width: clean(url.searchParams.get("width")),
    height: clean(url.searchParams.get("height")),
    material: clean(url.searchParams.get("material")),
    finish: clean(url.searchParams.get("finish")),
    cutType: clean(url.searchParams.get("cutType")),
    bannerFinishing: clean(url.searchParams.get("bannerFinishing")),
    costSource: clean(url.searchParams.get("costSource")),
    jarSize: clean(url.searchParams.get("jarSize")),
    jarColors: clean(url.searchParams.get("jarColors")),
    blankCost: clean(url.searchParams.get("blankCost")),
    labelPrintMaterial: clean(url.searchParams.get("labelPrintMaterial")),
    applicationNote: clean(url.searchParams.get("applicationNote")),
    sizeShape: clean(url.searchParams.get("sizeShape")),
    boardMaterial: clean(url.searchParams.get("boardMaterial")),
    machineRoute: clean(url.searchParams.get("machineRoute")),
    vendorSource: clean(url.searchParams.get("vendorSource")),
    tierNote: clean(url.searchParams.get("tierNote")),
    newFamilyName: clean(url.searchParams.get("newFamilyName")),
    newFamilyKey: clean(url.searchParams.get("newFamilyKey")),
    newPricingMethod: clean(url.searchParams.get("newPricingMethod"), "auto_margin"),
    unitOfMeasure: clean(url.searchParams.get("unitOfMeasure"), "each"),
    costComponents: clean(url.searchParams.get("costComponents")),
  };

  const templates = await db.productTypeProfile.findMany({
    where: { shop, active: true },
    select: {
      id: true,
      key: true,
      name: true,
      calculatorKind: true,
      minQuantity: true,
      defaultQuantity: true,
      tierBreakpoints: true,
      defaultMarginPct: true,
      pricingMethod: true,
      productionMode: true,
      _count: { select: { recipes: true } },
    },
    orderBy: [{ name: "asc" }],
    take: 100,
  });

  const requestedTemplate = templates.find((template) => template.id === params.templateId) || null;
  const productFamily = safeChoice(params.productFamily, PRODUCT_FAMILIES, requestedTemplate ? familyForProfile(requestedTemplate) : "jars");
  const exampleTemplates = templates.filter((template) => familyForProfile(template) === productFamily);
  const selectedTemplate =
    (requestedTemplate && familyForProfile(requestedTemplate) === productFamily ? requestedTemplate : null) ||
    exampleTemplates[0] ||
    null;
  const selectedKind = selectedTemplate ? inferKind(selectedTemplate) : "";
  const selectedTemplateId = selectedTemplate?.id || "";
  params.productFamily = productFamily;
  const shopifyProductGid = normalizeGid(params.shopifyHandle);
  const tiers = parseTiers(params.tiers || selectedTemplate?.tierBreakpoints || "");
  const hasInput = Boolean(params.title || params.productType || params.sku || params.shopifyHandle || params.newFamilyName);

  const profileOr: any[] = [];
  if (params.productType) profileOr.push({ key: params.productType });
  if (params.title) profileOr.push({ name: { equals: params.title, mode: "insensitive" } });
  if (params.newFamilyKey) profileOr.push({ key: params.newFamilyKey });
  if (params.newFamilyName) profileOr.push({ name: { equals: params.newFamilyName, mode: "insensitive" } });

  const recipeOr: any[] = [];
  if (params.title) recipeOr.push({ name: { equals: params.title, mode: "insensitive" } });
  if (params.productType) recipeOr.push({ productType: params.productType });
  if (params.sku) recipeOr.push({ sku: params.sku });

  const configuratorOr: any[] = [];
  if (params.title) configuratorOr.push({ title: { equals: params.title, mode: "insensitive" } });
  if (params.productType) configuratorOr.push({ productType: params.productType });
  if (params.shopifyHandle) configuratorOr.push({ shopifyHandle: params.shopifyHandle });
  if (shopifyProductGid) configuratorOr.push({ shopifyProductGid });

  const variantRuleOr: any[] = [];
  if (params.sku) variantRuleOr.push({ sku: params.sku });
  if (shopifyProductGid) variantRuleOr.push({ shopifyProductGid });

  const relatedRecipeWhere = selectedTemplate
    ? {
        shop,
        active: true,
        OR: [
          { productTypeProfileId: selectedTemplate.id },
          { productType: selectedTemplate.key },
        ],
      }
    : { shop, active: true, id: "__none__" };

  const terms = termsForFamily(productFamily).length ? termsForFamily(productFamily) : termsForKind(selectedKind);
  const materialWhere: any = { shop, active: true };
  if (terms.length) {
    materialWhere.OR = terms.flatMap((term) => [
      { name: { contains: term, mode: "insensitive" } },
      { materialType: { contains: term, mode: "insensitive" } },
      { productFamilies: { contains: term, mode: "insensitive" } },
    ]);
  }

  const vendorWhere: any = { shop, status: "active" };
  if (terms.length) {
    vendorWhere.OR = terms.flatMap((term) => [
      { itemName: { contains: term, mode: "insensitive" } },
      { itemType: { contains: term, mode: "insensitive" } },
      { vendorName: { contains: term, mode: "insensitive" } },
    ]);
  }

  const [
    relatedRecipeCount,
    relatedRecipes,
    materialCount,
    machineCount,
    vendorCostCount,
    configuratorOptionCount,
    configuratorRuleCount,
    duplicateProfiles,
    duplicateRecipes,
    duplicateConfiguratorProducts,
    duplicateVariantRules,
  ] = await Promise.all([
    db.productRecipe.count({ where: relatedRecipeWhere }),
    db.productRecipe.findMany({
      where: relatedRecipeWhere,
      select: {
        id: true,
        name: true,
        sku: true,
        productType: true,
        productFamily: true,
        _count: { select: { tiers: true, materials: true, labelZones: true, machineRules: true, variantRules: true } },
      },
      orderBy: [{ updatedAt: "desc" }],
      take: 3,
    }),
    db.material.count({ where: materialWhere }),
    db.machine.count({ where: { shop, active: true } }),
    db.vendorCostBookItem.count({ where: vendorWhere }),
    selectedTemplate ? db.configuratorOption.count({ where: { shop, active: true, productType: selectedTemplate.key } }) : Promise.resolve(0),
    selectedTemplate ? db.configuratorPricingRule.count({ where: { shop, active: true, productType: selectedTemplate.key } }) : Promise.resolve(0),
    profileOr.length
      ? db.productTypeProfile.findMany({ where: { shop, OR: profileOr }, select: { id: true, key: true, name: true, active: true }, take: 10 })
      : Promise.resolve([]),
    recipeOr.length
      ? db.productRecipe.findMany({ where: { shop, OR: recipeOr }, select: { id: true, name: true, sku: true, productType: true, productFamily: true, active: true }, take: 10 })
      : Promise.resolve([]),
    configuratorOr.length
      ? db.configuratorProduct.findMany({ where: { shop, OR: configuratorOr }, select: { id: true, title: true, productType: true, shopifyHandle: true, shopifyProductGid: true, active: true }, take: 10 })
      : Promise.resolve([]),
    variantRuleOr.length
      ? db.recipeVariantRule.findMany({ where: { shop, OR: variantRuleOr }, select: { id: true, name: true, sku: true, shopifyProductGid: true, shopifyVariantGid: true, active: true }, take: 10 })
      : Promise.resolve([]),
  ]);

  const duplicateCount = duplicateProfiles.length + duplicateRecipes.length + duplicateConfiguratorProducts.length + duplicateVariantRules.length;
  const authority = recommendedAuthority(params, familyLabel(productFamily));
  const relatedLabelSelected = params.labelMode !== "none" || params.wizardMode === "related-label";
  const officialMoq = officialMoqForFamily(productFamily);
  const defaultMoq = params.moq || String(officialMoq || selectedTemplate?.minQuantity || selectedTemplate?.defaultQuantity || "");
  const warnings = [
    params.wizardMode !== "new-family" && !selectedTemplate ? "Choose a family/template before planning ERP records." : null,
    params.wizardMode === "new-family" && !params.newFamilyName ? "Add a new family name." : null,
    params.wizardMode === "new-family" && !params.newFamilyKey ? "Add a new family key." : null,
    !params.title && params.wizardMode !== "new-family" ? "Add the new product name." : null,
    !params.sku && !params.productType && params.wizardMode !== "new-family" ? "Add a SKU or product key." : null,
    !intValue(params.moq, selectedTemplate?.minQuantity || 0) ? "Add MOQ/default quantity." : null,
    !tiers.length ? "Add quantity tiers." : null,
    !params.targetMargin && !params.markup && params.wizardMode !== "link-existing-shopify" ? "Add target margin or markup for pricing review." : null,
    params.shopifySetup === "existing-shopify" && !params.shopifyHandle ? "Enter a Shopify handle or product GID for existing Shopify setup." : null,
    params.shopifySetup === "shopify-variants" && !params.variantOption1Name ? "Add at least one Shopify variant option name." : null,
    relatedLabelSelected && !params.baseProduct ? "Add the base Shopify product title, handle, or GID for the related label plan." : null,
    relatedLabelSelected && !params.labelName ? "Add the related label product name." : null,
    productFamily === "labels-stickers" && (!params.width || !params.height) ? "Add label/sticker width and height for cost planning." : null,
    productFamily === "banners" && (!params.width || !params.height) ? "Add banner width and height for square-foot cost planning." : null,
    materialCount === 0 ? "No matching material cost inputs found for this template kind." : null,
  ].filter(Boolean);

  const status = statusFor(params, duplicateCount, warnings as string[]);

  return Response.json({
    shop,
    params,
    productFamilies: PRODUCT_FAMILIES,
    productFamilyLabel: familyLabel(productFamily),
    productFamilySummary: familySummary(productFamily),
    productFamilySalesRules: salesRulesForFamily(productFamily),
    officialMoq,
    defaultMoq,
    exampleTemplates,
    templates,
    selectedTemplate,
    selectedTemplateId,
    selectedKind,
    relatedRecipeCount,
    relatedRecipes,
    tiers,
    hasInput,
    authority,
    costFoundation: {
      materialCount,
      machineCount,
      vendorCostCount,
      configuratorOptionCount,
      configuratorRuleCount,
    },
    warnings,
    status,
    duplicates: {
      profiles: duplicateProfiles,
      recipes: duplicateRecipes,
      configuratorProducts: duplicateConfiguratorProducts,
      variantRules: duplicateVariantRules,
    },
  });
}

export default function ProductBuilderPlan() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as any;
  const { params } = data;
  const [wizardMode, setWizardMode] = useState(params.wizardMode);
  const [shopifySetup, setShopifySetup] = useState(params.shopifySetup);
  const [labelMode, setLabelMode] = useState(params.labelMode);
  const groupedTemplates = data.templates.reduce((groups: Record<string, any[]>, template: any) => {
    const kind = familyLabel(familyForProfile(template));
    groups[kind] = groups[kind] || [];
    groups[kind].push(template);
    return groups;
  }, {});

  const relatedLabelActive = wizardMode === "related-label" || labelMode !== "none";
  const duplicateCount = data.duplicates.profiles.length + data.duplicates.recipes.length + data.duplicates.configuratorProducts.length + data.duplicates.variantRules.length;
  const canCreateDraft = Boolean(params.title && (params.sku || params.productType));
  const erpRecords = wizardMode === "new-family"
    ? ["Product family/template", "First product recipe", "Quantity tiers", "Material/vendor/machine cost inputs", "Pricing health review"]
    : shopifySetup === "gso-configurator-options"
      ? ["Configurator product", "Configurator options", "Configurator pricing rules", "Shopify mapping", "Storefront test", "Production test"]
      : relatedLabelActive
        ? ["Related label product recipe", "Label zones", "Material and machine cost rows", "Application labor rule", "Shopify link or mapping"]
        : ["Product recipe", "Recipe tiers", "Material/vendor cost source", "Machine or production route", "Shopify link if needed"];

  const shopifyRecords = shopifySetup === "existing-shopify"
    ? ["Use existing Shopify product", "Map handle/Product GID", "Sync variants only if needed"]
    : shopifySetup === "create-shopify-draft-later"
      ? ["Draft Shopify product later", "Review title, SKU, and variants before publish"]
      : shopifySetup === "shopify-variants"
        ? ["Shopify product", "Variant options and values", "ERP variant mapping"]
        : shopifySetup === "gso-configurator-options"
          ? ["Shopify product shell", "Theme app block", "GSO configurator mapping"]
          : ["Simple Shopify product", "SKU/handle mapping"];

  const links = [
    { label: "Cost Calculator", url: "/app/erp/cost-calculator" },
    { label: "Product Setup", url: "/app/erp/product-setup" },
    { label: "Materials", url: "/app/erp/materials" },
    { label: "Machines", url: "/app/erp/machines" },
    { label: "Vendors", url: "/app/erp/vendors" },
    { label: "Vendor Cost Book", url: "/app/erp/vendor-cost-book" },
    { label: "Pricing Health", url: "/app/erp/pricing-health" },
    { label: "Shopify Links", url: "/app/erp/shopify-links" },
    { label: "Configurator Mapping", url: "/app/erp/configurator-mapping" },
  ];

  const readinessText = readinessSentence(data.status, data.warnings as string[], duplicateCount);
  const willCreateLater = [
    "1 inactive ProductRecipe",
    "Copied RecipeTier rows from the selected example/template if available",
    "Product name, SKU/key, MOQ, and margin fields",
    "Cost review flag or equivalent review status if the model supports it",
  ];
  const willNotCreateYet = [
    "No Shopify product",
    "No live storefront product",
    "No ConfiguratorProduct",
    "No ConfiguratorPricingRule",
    "No material/vendor/machine records",
    "No production jobs",
    "No live price changes",
  ];

  const costSetupFields = (() => {
    if (params.productFamily === "jars") {
      return (
        <div style={fieldGrid(2)}>
          <Field label="Vendor/source jar cost"><input name="costSource" defaultValue={params.costSource} placeholder="Vendor tier, landed cost, or cost book item" style={inputStyle()} /></Field>
          <Field label="Jar size/type"><input name="jarSize" defaultValue={params.jarSize} placeholder="100ml tall, 3oz, 4oz" style={inputStyle()} /></Field>
          <Field label="Jar color/options"><input name="jarColors" defaultValue={params.jarColors} placeholder="Clear, Black, White, or none" style={inputStyle()} /></Field>
          <Field label="Label zones/options">
            <select name="labelZones" multiple defaultValue={params.labelZones.length ? params.labelZones : ["Side", "Lid"]} style={{ ...inputStyle(), minHeight: 104 }}>
              {LABEL_ZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          </Field>
        </div>
      );
    }
    if (params.productFamily === "sticker-bags") {
      return (
        <div style={fieldGrid(2)}>
          <Field label="Blank bag cost/source"><input name="blankCost" defaultValue={params.blankCost} placeholder="Blank bag vendor or internal cost" style={inputStyle()} /></Field>
          <Field label="Label/print material"><input name="labelPrintMaterial" defaultValue={params.labelPrintMaterial || params.material} placeholder="Label stock, print media, or film" style={inputStyle()} /></Field>
          <Field label="Finish"><input name="finish" defaultValue={params.finish} placeholder="Matte, gloss, laminate" style={inputStyle()} /></Field>
          <Field label="Application/labor note"><input name="applicationNote" defaultValue={params.applicationNote} placeholder="Hand apply, machine apply, outsource" style={inputStyle()} /></Field>
        </div>
      );
    }
    if (params.productFamily === "dtp-pouches") {
      return (
        <div style={fieldGrid(2)}>
          <Field label="Pouch material or sourced cost"><input name="costSource" defaultValue={params.costSource || params.material} placeholder="Pouch material, blank, or vendor cost" style={inputStyle()} /></Field>
          <Field label="Size/shape"><input name="sizeShape" defaultValue={params.sizeShape} placeholder="Stock size, custom shape, gusset, zipper" style={inputStyle()} /></Field>
          <Field label="Finish"><input name="finish" defaultValue={params.finish} placeholder="Matte, gloss, soft touch" style={inputStyle()} /></Field>
          <Field label="MOQ/tier note"><input name="tierNote" defaultValue={params.tierNote} placeholder="MOQ limits, tier breaks, setup notes" style={inputStyle()} /></Field>
        </div>
      );
    }
    if (params.productFamily === "boxes") {
      return (
        <div style={fieldGrid(2)}>
          <Field label="Board/material"><input name="boardMaterial" defaultValue={params.boardMaterial || params.material} placeholder="Board, corrugate, stock" style={inputStyle()} /></Field>
          <Field label="Size"><input name="sizeShape" defaultValue={params.sizeShape} placeholder="L x W x H or dieline size" style={inputStyle()} /></Field>
          <Field label="Finish"><input name="finish" defaultValue={params.finish} placeholder="Coating, laminate, varnish" style={inputStyle()} /></Field>
          <Field label="Cut/assembly/finishing"><input name="cutType" defaultValue={params.cutType} placeholder="Die cut, score, glue, assemble" style={inputStyle()} /></Field>
        </div>
      );
    }
    if (params.productFamily === "labels-stickers") {
      return (
        <div style={fieldGrid(2)}>
          <Field label="Width inches"><input name="width" defaultValue={params.width} placeholder="3" style={inputStyle()} /></Field>
          <Field label="Height inches"><input name="height" defaultValue={params.height} placeholder="2" style={inputStyle()} /></Field>
          <Field label="Material"><input name="material" defaultValue={params.material} placeholder="Vinyl, paper, clear, roll stock" style={inputStyle()} /></Field>
          <Field label="Finish"><input name="finish" defaultValue={params.finish} placeholder="Matte, gloss, laminate" style={inputStyle()} /></Field>
          <Field label="Cut type"><input name="cutType" defaultValue={params.cutType} placeholder="Die cut, kiss cut, sheet, roll" style={inputStyle()} /></Field>
        </div>
      );
    }
    if (params.productFamily === "banners") {
      return (
        <div style={fieldGrid(2)}>
          <Field label="Width feet"><input name="width" defaultValue={params.width} placeholder="4" style={inputStyle()} /></Field>
          <Field label="Height feet"><input name="height" defaultValue={params.height} placeholder="8" style={inputStyle()} /></Field>
          <Field label="Banner material"><input name="material" defaultValue={params.material} placeholder="13oz vinyl, mesh, fabric" style={inputStyle()} /></Field>
          <Field label="Printer/machine route"><input name="machineRoute" defaultValue={params.machineRoute} placeholder="Mimaki, Roland, outsource" style={inputStyle()} /></Field>
          <Field label="Finishing, hem/grommets"><input name="bannerFinishing" defaultValue={params.bannerFinishing || params.cutType} placeholder="Hem, grommets, pole pocket" style={inputStyle()} /></Field>
        </div>
      );
    }
    if (params.productFamily === "apparel-dtf") {
      return (
        <div style={fieldGrid(2)}>
          <Field label="Blank garment/source"><input name="blankCost" defaultValue={params.blankCost} placeholder="Garment vendor, blank cost, or SKU" style={inputStyle()} /></Field>
          <Field label="Transfer/print material"><input name="labelPrintMaterial" defaultValue={params.labelPrintMaterial || params.material} placeholder="DTF transfer, vinyl, ink" style={inputStyle()} /></Field>
          <Field label="Size/color variant note"><input name="sizeShape" defaultValue={params.sizeShape} placeholder="Sizes, colors, garment variants" style={inputStyle()} /></Field>
          <Field label="Application labor"><input name="applicationNote" defaultValue={params.applicationNote} placeholder="Press time, placement, setup" style={inputStyle()} /></Field>
        </div>
      );
    }
    if (params.productFamily === "sourced-blank-resale") {
      return (
        <div style={fieldGrid(2)}>
          <Field label="Vendor/source item cost"><input name="costSource" defaultValue={params.costSource} placeholder="Unit cost, landed cost, or cost book tier" style={inputStyle()} /></Field>
          <Field label="Vendor/source"><input name="vendorSource" defaultValue={params.vendorSource} placeholder="Vendor, manufacturer, supplier" style={inputStyle()} /></Field>
          <Field label="MOQ/cost tier note"><input name="tierNote" defaultValue={params.tierNote} placeholder="Vendor MOQ, case pack, cost tiers" style={inputStyle()} /></Field>
        </div>
      );
    }
    return (
      <div style={fieldGrid(2)}>
        <Field label="Pricing method">
          <select name="newPricingMethod" defaultValue={params.newPricingMethod} style={inputStyle()}>
            {NEW_FAMILY_PRICING.map((method) => <option key={method} value={method}>{method}</option>)}
          </select>
        </Field>
        <Field label="Unit of measure">
          <select name="unitOfMeasure" defaultValue={params.unitOfMeasure} style={inputStyle()}>
            {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
          </select>
        </Field>
        <Field label="Needed cost components"><input name="costComponents" defaultValue={params.costComponents} placeholder="material, labor, machine, vendor cost, finishing" style={inputStyle()} /></Field>
      </div>
    );
  })();

  return (
    <Page title="Product Builder" subtitle="New Product Wizard">
      <Form method="get">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="p" tone="subdued">
                  This wizard is read-only right now. It helps plan ERP setup, pricing, Shopify options, and related products before anything is created.
                </Text>
                <InlineStack gap="200" wrap>
                  <Badge tone="success">No writes</Badge>
                  <Badge tone="success">No Shopify Admin calls</Badge>
                  <Badge tone={statusTone(data.status) as any}>{data.status}</Badge>
                  <Badge>Shop: {data.shop}</Badge>
                </InlineStack>
                {actionData && !actionData.ok ? (
                  <div style={{ border: "1px solid #e0b3b2", background: "#fff4f4", borderRadius: 8, padding: 12 }}>
                    <BlockStack gap="100">
                      <Text as="p" tone="critical">{actionData.message || "ERP draft was not created."}</Text>
                      {Array.isArray(actionData.errors) && actionData.errors.length ? (
                        <ul style={{ margin: 0, paddingLeft: 20 }}>
                          {actionData.errors.map((error: string) => <li key={error}>{error}</li>)}
                        </ul>
                      ) : null}
                    </BlockStack>
                  </div>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <StepHeader number={1} title="Choose what you are doing" />
                <div style={fieldGrid(2)}>
                  {WIZARD_MODES.map((mode) => (
                    <label key={mode.value} style={{ border: "1px solid #d9dde6", borderRadius: 8, padding: 12, display: "flex", gap: 8 }}>
                      <input type="radio" name="wizardMode" value={mode.value} checked={wizardMode === mode.value} onChange={() => setWizardMode(mode.value)} />
                      <span>{mode.label}</span>
                    </label>
                  ))}
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <StepHeader
                  number={2}
                  title="Choose product family"
                  help="Choose the broad product family first. Individual sizes or similar products are only used as examples to copy setup from."
                />
                {wizardMode === "new-family" ? (
                  <div style={fieldGrid(2)}>
                    <Field label="New family name"><input name="newFamilyName" defaultValue={params.newFamilyName} placeholder="Banners" style={inputStyle()} /></Field>
                    <Field label="New family key"><input name="newFamilyKey" defaultValue={params.newFamilyKey} placeholder="banners" style={inputStyle()} /></Field>
                    <Field label="Pricing method">
                      <select name="newPricingMethod" defaultValue={params.newPricingMethod} style={inputStyle()}>
                        {NEW_FAMILY_PRICING.map((method) => <option key={method} value={method}>{method}</option>)}
                      </select>
                    </Field>
                    <Field label="Unit of measure">
                      <select name="unitOfMeasure" defaultValue={params.unitOfMeasure} style={inputStyle()}>
                        {UNIT_OPTIONS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                      </select>
                    </Field>
                    <Field label="Needed cost components">
                      <input name="costComponents" defaultValue={params.costComponents} placeholder="material, ink, machine time, finishing, packout" style={inputStyle()} />
                    </Field>
                    <Text as="p" tone="subdued">Planning only. This will not create a family/template yet.</Text>
                  </div>
                ) : (
                  <BlockStack gap="300">
                    <div style={fieldGrid(2)}>
                      <Field label="Product family">
                        <select name="productFamily" defaultValue={params.productFamily} style={inputStyle()}>
                          {data.productFamilies.map((family: any) => <option key={family.value} value={family.value}>{family.label}</option>)}
                        </select>
                      </Field>
                      <Field label="Copy setup from example">
                        <select name="templateId" defaultValue={data.selectedTemplateId} style={inputStyle()}>
                          <option value="">No example selected yet</option>
                          {data.exampleTemplates.length ? data.exampleTemplates.map((template: any) => (
                            <option key={template.id} value={template.id}>{template.name} ({template.key})</option>
                          )) : data.templates.map((template: any) => (
                            <option key={template.id} value={template.id}>{template.name} ({template.key})</option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">{data.productFamilyLabel}</Text>
                      <ul style={{ margin: 0, paddingLeft: 20 }}>
                        {data.productFamilySummary.map((line: string) => <li key={line}>{line}</li>)}
                      </ul>
                    </BlockStack>
                    <BlockStack gap="100">
                      <Text as="h3" variant="headingSm">Sales rules / MOQ source of truth</Text>
                      <Text as="p" tone="subdued">Staff and future agent-safe sales workflows should use these rules before quoting.</Text>
                      <ul style={{ margin: 0, paddingLeft: 20 }}>
                        {data.productFamilySalesRules.map((line: string) => <li key={line}>{line}</li>)}
                      </ul>
                    </BlockStack>
                    {data.exampleTemplates.length ? null : (
                      <Text as="p" tone="subdued">
                        No matching example setups were found for this broad family yet. You can still plan the product, or use Product Setup to create the first reusable example later.
                      </Text>
                    )}
                    <details>
                      <summary style={{ cursor: "pointer", fontWeight: 700 }}>View all existing example setups</summary>
                      <select aria-label="All example setups" disabled style={{ ...inputStyle(), marginTop: 12 }}>
                        {Object.entries(groupedTemplates).map(([kind, templates]: any) => (
                          <optgroup key={kind} label={kind}>
                            {templates.map((template: any) => (
                              <option key={template.id} value={template.id}>{template.name} ({template.key})</option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                    </details>
                    {data.selectedTemplate ? (
                      <div style={fieldGrid(2)}>
                        <BlockStack gap="100">
                          <Text as="h3" variant="headingSm">Example setup: {data.selectedTemplate.name}</Text>
                          <Text as="p">Internal key: {data.selectedTemplate.key}</Text>
                          <Text as="p">Calculator kind: {data.selectedTemplate.calculatorKind || data.selectedKind}</Text>
                          <Text as="p">MOQ/default: {data.selectedTemplate.minQuantity} / {data.selectedTemplate.defaultQuantity}</Text>
                        </BlockStack>
                        <BlockStack gap="100">
                          <Text as="p">Tier breakpoints: {data.selectedTemplate.tierBreakpoints || "Not set"}</Text>
                          <Text as="p">Default margin: {Number(data.selectedTemplate.defaultMarginPct || 0).toFixed(1)}%</Text>
                          <Text as="p">Pricing method: {data.selectedTemplate.pricingMethod}</Text>
                          <Text as="p">Related recipes: {data.relatedRecipeCount}</Text>
                        </BlockStack>
                      </div>
                    ) : <Text as="p" tone="subdued">No active family templates found.</Text>}
                    <RecipeSummary recipes={data.relatedRecipes} />
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <StepHeader number={3} title="Choose Shopify setup" />
                <div style={fieldGrid(2)}>
                  <Field label="Shopify setup">
                    <select name="shopifySetup" value={shopifySetup} onChange={(event) => setShopifySetup(event.currentTarget.value)} style={inputStyle()}>
                      {SHOPIFY_SETUPS.map((setup) => <option key={setup.value} value={setup.value}>{setup.label}</option>)}
                    </select>
                  </Field>
                  <Field label="Shopify handle/GID">
                    <input name="shopifyHandle" defaultValue={params.shopifyHandle} placeholder="shopify-handle or gid://shopify/Product/..." style={inputStyle()} />
                  </Field>
                </div>
                {shopifySetup === "shopify-variants" ? (
                  <div style={fieldGrid(3)}>
                    <Field label="Variant option 1 name"><input name="variantOption1Name" defaultValue={params.variantOption1Name} placeholder="Size" style={inputStyle()} /></Field>
                    <Field label="Variant option 1 values"><input name="variantOption1Values" defaultValue={params.variantOption1Values} placeholder="Small, Medium, Large" style={inputStyle()} /></Field>
                    <Field label="Variant option 2 name"><input name="variantOption2Name" defaultValue={params.variantOption2Name} placeholder="Color" style={inputStyle()} /></Field>
                    <Field label="Variant option 2 values"><input name="variantOption2Values" defaultValue={params.variantOption2Values} placeholder="Clear, Black, White" style={inputStyle()} /></Field>
                    <Field label="Variant option 3 name"><input name="variantOption3Name" defaultValue={params.variantOption3Name} placeholder="Finish" style={inputStyle()} /></Field>
                    <Field label="Variant option 3 values"><input name="variantOption3Values" defaultValue={params.variantOption3Values} placeholder="Matte, Gloss" style={inputStyle()} /></Field>
                  </div>
                ) : null}
                <Text as="p" tone="subdued">
                  Use Shopify variants for simple customer choices. Use GSO configurator options for complex pricing like dimensions, material, finish, or quantity.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <StepHeader number={4} title="Choose related label options" />
                <Field label="Related label option">
                  <select name="labelMode" value={labelMode} onChange={(event) => setLabelMode(event.currentTarget.value)} style={inputStyle()}>
                    {LABEL_MODES.map((mode) => <option key={mode.value} value={mode.value}>{mode.label}</option>)}
                  </select>
                </Field>
                {relatedLabelActive ? (
                  <BlockStack gap="300">
                    <Text as="p" tone="subdued">Related label products should usually be separate Shopify products linked to the base item.</Text>
                    <div style={fieldGrid(3)}>
                      <Field label="Existing base product title/handle/GID"><input name="baseProduct" defaultValue={params.baseProduct} placeholder="Base jar, package, or product" style={inputStyle()} /></Field>
                      <Field label="Label product name"><input name="labelName" defaultValue={params.labelName} placeholder="100ml Tall Jar Label Set" style={inputStyle()} /></Field>
                      <Field label="Application mode">
                        <select name="applicationMode" defaultValue={params.applicationMode} style={inputStyle()}>
                          {APPLICATION_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                        </select>
                      </Field>
                      <Field label="Base item source">
                        <select name="baseItemSource" defaultValue={params.baseItemSource} style={inputStyle()}>
                          {BASE_ITEM_SOURCES.map((source) => <option key={source} value={source}>{source}</option>)}
                        </select>
                      </Field>
                      <Field label="Label zones/options">
                        <select name="labelZones" multiple defaultValue={params.labelZones.length ? params.labelZones : ["Side"]} style={{ ...inputStyle(), minHeight: 104 }}>
                          {LABEL_ZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
                        </select>
                      </Field>
                    </div>
                  </BlockStack>
                ) : <Text as="p" tone="subdued">No related label product will be planned unless this is changed.</Text>}
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <StepHeader number={5} title="Product details" />
                <div style={fieldGrid(3)}>
                  <Field label="Product name"><input name="title" defaultValue={params.title} placeholder="New product name" style={inputStyle()} /></Field>
                  <Field label="SKU / product key"><input name="sku" defaultValue={params.sku} placeholder="SKU-123" style={inputStyle()} /></Field>
                  <Field label="ERP product type key"><input name="productType" defaultValue={params.productType} placeholder="product_type_key" style={inputStyle()} /></Field>
                  <Field label="MOQ / default quantity">
                    <input name="moq" type="number" min="1" defaultValue={data.defaultMoq} style={inputStyle()} />
                    <Text as="p" tone="subdued">Defaults to the official family MOQ when set. Staff can override only if approved.</Text>
                  </Field>
                  <Field label="Quantity tiers"><input name="tiers" defaultValue={params.tiers || data.selectedTemplate?.tierBreakpoints || ""} placeholder="64,128,256,640" style={inputStyle()} /></Field>
                  <Field label="Target margin %"><input name="targetMargin" type="number" step="0.01" defaultValue={params.targetMargin || data.selectedTemplate?.defaultMarginPct || ""} style={inputStyle()} /></Field>
                  <Field label="Markup %"><input name="markup" type="number" step="0.01" defaultValue={params.markup} style={inputStyle()} /></Field>
                </div>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <StepHeader number={6} title="Cost setup" />
                <Text as="p"><strong>{data.authority.label}</strong></Text>
                <Text as="p" tone="subdued">{data.authority.detail}</Text>
                {costSetupFields}
                <InlineStack gap="200" wrap>
                  <Badge>Materials: {data.costFoundation.materialCount}</Badge>
                  <Badge>Machines: {data.costFoundation.machineCount}</Badge>
                  <Badge>Vendor cost items: {data.costFoundation.vendorCostCount}</Badge>
                  <Badge>Configurator options: {data.costFoundation.configuratorOptionCount}</Badge>
                  <Badge>Configurator rules: {data.costFoundation.configuratorRuleCount}</Badge>
                </InlineStack>
                <InlineStack gap="200" wrap>
                  {links.map((link) => <Button key={link.url} url={link.url}>{link.label}</Button>)}
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <StepHeader number={7} title="Review" />
                <InlineStack gap="200" wrap>
                  <Badge tone={statusTone(data.status) as any}>{data.status}</Badge>
                  <Badge>Family selected: {data.productFamilyLabel}</Badge>
                  {data.selectedTemplate ? <Badge>Copy setup from: {data.selectedTemplate.name}</Badge> : null}
                  <Badge tone={duplicateCount ? "warning" : "success"}>{duplicateCount ? `${duplicateCount} duplicate match(es)` : "No duplicate matches"}</Badge>
                </InlineStack>
                <Text as="p">{readinessText}</Text>
                <div style={fieldGrid(2)}>
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingSm">ERP records needed</Text>
                    <ul style={{ margin: 0, paddingLeft: 20 }}>{erpRecords.map((record) => <li key={record}>{record}</li>)}</ul>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingSm">Shopify records needed</Text>
                    <ul style={{ margin: 0, paddingLeft: 20 }}>{shopifyRecords.map((record) => <li key={record}>{record}</li>)}</ul>
                  </BlockStack>
                </div>
                <div style={fieldGrid(2)}>
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingSm">What will be created later</Text>
                    <Text as="p" tone="subdued">When Create ERP Draft is enabled, it should create a reviewed draft only.</Text>
                    <ul style={{ margin: 0, paddingLeft: 20 }}>{willCreateLater.map((record) => <li key={record}>{record}</li>)}</ul>
                  </BlockStack>
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingSm">What will NOT be created yet</Text>
                    <ul style={{ margin: 0, paddingLeft: 20 }}>{willNotCreateYet.map((record) => <li key={record}>{record}</li>)}</ul>
                  </BlockStack>
                </div>
                {data.warnings.length ? (
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingSm">Missing setup</Text>
                    {data.warnings.map((warning: string) => <Badge key={warning} tone="warning">{warning}</Badge>)}
                  </BlockStack>
                ) : <Badge tone="success">No missing setup warnings</Badge>}
                {duplicateCount ? (
                  <Text as="p" tone="subdued">Duplicate warnings are shown in Advanced ERP checks below. Review them before creating records in a future version.</Text>
                ) : null}
                <InlineStack gap="200" wrap>
                  <Button submit variant="primary">Preview Plan</Button>
                  <Button url="/app/erp/products/new">Clear</Button>
                  <label style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input type="checkbox" name="confirmDuplicate" value="1" /> Create anyway (not a duplicate)
                  </label>
                  <button
                    type="submit"
                    name="intent"
                    value="createErpDraft"
                    formMethod="post"
                    disabled={!canCreateDraft}
                    style={{
                      minHeight: 36,
                      padding: "7px 14px",
                      borderRadius: 8,
                      border: "1px solid #1f6f43",
                      background: canCreateDraft ? "#008060" : "#f1f2f3",
                      color: canCreateDraft ? "#ffffff" : "#6d7175",
                      cursor: canCreateDraft ? "pointer" : "not-allowed",
                      fontWeight: 600,
                    }}
                  >
                    Create ERP Draft
                  </button>
                  <Button disabled>Create Shopify Draft Product — coming later</Button>
                  {relatedLabelActive ? <Button disabled>Create Related Label Product — coming later</Button> : null}
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            <Card>
              <details>
                <summary style={{ cursor: "pointer", fontWeight: 700 }}>Advanced ERP checks</summary>
                <div style={{ marginTop: 16 }}>
                  <BlockStack gap="300">
                    <Text as="p" tone="subdued">
                      Technical duplicate checks are read-only. They search existing ERP templates, recipes, configurator products, and Shopify mapping rows.
                    </Text>
                    <div style={fieldGrid(2)}>
                      <DuplicateList title="Product family/template matches" rows={data.duplicates.profiles} render={(row) => `${row.key} - ${row.name} (${row.active ? "active" : "inactive"})`} />
                      <DuplicateList title="Recipe matches" rows={data.duplicates.recipes} render={(row) => `${row.name} / ${row.productType} / ${row.sku || "no SKU"} (${row.active ? "active" : "inactive"})`} />
                      <DuplicateList title="Configurator product matches" rows={data.duplicates.configuratorProducts} render={(row) => `${row.title} / ${row.productType} / ${row.shopifyHandle || row.shopifyProductGid || "no Shopify mapping"} (${row.active ? "active" : "inactive"})`} />
                      <DuplicateList title="Shopify variant mapping matches" rows={data.duplicates.variantRules} render={(row) => `${row.name} / ${row.sku || "no SKU"} / ${row.shopifyProductGid || "no Product GID"} (${row.active ? "active" : "inactive"})`} />
                    </div>
                  </BlockStack>
                </div>
              </details>
            </Card>
          </Layout.Section>
        </Layout>
      </Form>
    </Page>
  );
}
