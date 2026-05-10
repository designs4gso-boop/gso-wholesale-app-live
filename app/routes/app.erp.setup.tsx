import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Divider,
} from "@shopify/polaris";
import { Form, useActionData, useLoaderData, useNavigation, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type TierTemplateRow = {
  minQty: number;
  maxQty: number | null;
  marginPct: number;
  fixedPrice?: string;
};

type ProductTypeSeed = {
  key: string;
  name: string;
  productType: string;
  productionMode: string;
  minQuantity: number;
  defaultQuantity: number;
  tierBreakpoints: string;
  defaultMarginPct: number;
  pricingMethod: string;
  defaultTags: string;
  notes: string;
  tierTemplate: TierTemplateRow[];
};

type MaterialSeed = {
  name: string;
  materialType: string;
  purchaseUnit: string;
  purchaseCost: number;
  baseUnit: string;
  unit: string;
  costPerUnit: number;
  calculatedUnitCost: number;
  rollWidthIn?: number;
  rollLengthFt?: number;
  volumeMl?: number;
  caseQuantity?: number;
  vendor?: string;
  sku?: string;
  notes: string;
};

type VendorTemplateSeed = {
  name: string;
  productType: string;
  vendor: string;
  vendorSku: string;
  moq: number;
  defaultUnitCost: number;
  leadTimeDays: number;
  notes: string;
  tiers: { minQty: number; maxQty: number | null; unitCost: number; notes?: string }[];
  addOns: { name: string; pricingType: string; amount: number; notes?: string }[];
};

type InkSlotSeed = {
  slotNumber: number;
  inkName: string;
  inkType: string;
  cartridgeCost: number;
  cartridgeMl: number;
  mlPerSqft1Pct: number;
  enabled?: boolean;
};

type MachineSeed = {
  name: string;
  machineType: string;
  maxWidthIn: number;
  costPerHour: number;
  sqftPerHour: number;
  setupWastePct: number;
  allowOverflow: boolean;
  notes: string;
  inkSlots: InkSlotSeed[];
};

const COST_REVIEW = "NEEDS_COST_REVIEW";
const ROLAND_POUCH_COST = 156.99;
const ROLAND_POUCH_ML = 750;
const MIMAKI_BOTTLE_COST_ESTIMATE = 190;
const MIMAKI_BOTTLE_ML = 1000;
const DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL = 0.0075;
const DEFAULT_WHITE_GLOSS_ML_PER_SQFT_1PCT_PER_CHANNEL = 0.0075;

function rangeRows(minQty: number, marginPct: number): TierTemplateRow[] {
  if (minQty >= 1000) {
    return [
      { minQty, maxQty: 1999, marginPct },
      { minQty: 2000, maxQty: 2499, marginPct: marginPct - 2 },
      { minQty: 2500, maxQty: 4999, marginPct: marginPct - 4 },
      { minQty: 5000, maxQty: 7499, marginPct: marginPct - 6 },
      { minQty: 7500, maxQty: 9999, marginPct: marginPct - 8 },
      { minQty: 10000, maxQty: null, marginPct: marginPct - 10 },
    ];
  }
  if (minQty >= 500) {
    return [
      { minQty, maxQty: 999, marginPct },
      { minQty: 1000, maxQty: 1999, marginPct: marginPct - 2 },
      { minQty: 2000, maxQty: 2499, marginPct: marginPct - 4 },
      { minQty: 2500, maxQty: 4999, marginPct: marginPct - 6 },
      { minQty: 5000, maxQty: 7499, marginPct: marginPct - 8 },
      { minQty: 7500, maxQty: 9999, marginPct: marginPct - 10 },
      { minQty: 10000, maxQty: null, marginPct: marginPct - 12 },
    ];
  }
  return [
    { minQty, maxQty: 199, marginPct },
    { minQty: 200, maxQty: 499, marginPct: marginPct - 3 },
    { minQty: 500, maxQty: 749, marginPct: marginPct - 5 },
    { minQty: 750, maxQty: 999, marginPct: marginPct - 7 },
    { minQty: 1000, maxQty: 1999, marginPct: marginPct - 9 },
    { minQty: 2000, maxQty: null, marginPct: marginPct - 12 },
  ];
}

const productTypeSeeds: ProductTypeSeed[] = [
  {
    key: "labels",
    name: "Labels",
    productType: "label",
    productionMode: "in_house",
    minQuantity: 64,
    defaultQuantity: 250,
    tierBreakpoints: "64,200,500,750,1000,2000",
    defaultMarginPct: 60,
    pricingMethod: "auto_margin",
    defaultTags: "gso:labels,gso:in-house,gso:wholesale",
    notes: "Default profile for in-house printed labels. Tune margins by tier once real production data is reviewed.",
    tierTemplate: rangeRows(64, 60),
  },
  {
    key: "sticker_bags",
    name: "Sticker Bags",
    productType: "stock_bag",
    productionMode: "outsourced",
    minQuantity: 64,
    defaultQuantity: 250,
    tierBreakpoints: "64,200,500,750,1000,2000",
    defaultMarginPct: 58,
    pricingMethod: "auto_margin",
    defaultTags: "gso:sticker-bags,gso:outsourced,gso:wholesale",
    notes: "Low-MOQ sticker bag / stock bag profile. Vendor costs should be entered per product.",
    tierTemplate: rangeRows(64, 58),
  },
  {
    key: "stock_bags",
    name: "Stock Bags",
    productType: "stock_bag",
    productionMode: "outsourced",
    minQuantity: 64,
    defaultQuantity: 250,
    tierBreakpoints: "64,200,500,750,1000,2000",
    defaultMarginPct: 55,
    pricingMethod: "auto_margin",
    defaultTags: "gso:stock-bags,gso:outsourced,gso:wholesale",
    notes: "Default outsourced stock bag profile. Use vendor tiers for actual cost.",
    tierTemplate: rangeRows(64, 55),
  },
  {
    key: "dtp_bags",
    name: "DTP Bags",
    productType: "dtp_bag",
    productionMode: "in_house",
    minQuantity: 100,
    defaultQuantity: 250,
    tierBreakpoints: "100,250,500,1000,2000,5000,10000",
    defaultMarginPct: 55,
    pricingMethod: "auto_margin",
    defaultTags: "gso:dtp-bags,gso:in-house,gso:wholesale",
    notes: "Default direct-to-pouch bag profile. Use in-house costing when bags are printed by GSO.",
    tierTemplate: rangeRows(100, 55),
  },
  {
    key: "boxes",
    name: "Boxes",
    productType: "box",
    productionMode: "outsourced",
    minQuantity: 500,
    defaultQuantity: 1000,
    tierBreakpoints: "500,1000,2000,2500,5000,7500,10000",
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: "gso:boxes,gso:outsourced,gso:wholesale",
    notes: "Default sourced box profile. Vendor product tiers and add-ons drive cost.",
    tierTemplate: rangeRows(500, 50),
  },
  {
    key: "die_cut_bags",
    name: "Die Cut Bags",
    productType: "die_cut_bag",
    productionMode: "hybrid",
    minQuantity: 500,
    defaultQuantity: 1000,
    tierBreakpoints: "500,1000,2500,5000,10000",
    defaultMarginPct: 55,
    pricingMethod: "auto_margin",
    defaultTags: "gso:die-cut-bags,gso:hybrid,gso:wholesale",
    notes: "Default die-cut bag profile. Adjust production mode depending on source and finishing steps.",
    tierTemplate: rangeRows(500, 55),
  },
  {
    key: "sourced_products",
    name: "Sourced Products",
    productType: "sourced_product",
    productionMode: "outsourced",
    minQuantity: 64,
    defaultQuantity: 250,
    tierBreakpoints: "64,200,500,750,1000,2000",
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: "gso:sourced,gso:outsourced,gso:wholesale",
    notes: "General vendor-produced product profile.",
    tierTemplate: rangeRows(64, 50),
  },
  {
    key: "general",
    name: "General",
    productType: "general",
    productionMode: "hybrid",
    minQuantity: 64,
    defaultQuantity: 250,
    tierBreakpoints: "64,200,500,750,1000,2000",
    defaultMarginPct: 50,
    pricingMethod: "auto_margin",
    defaultTags: "gso:wholesale",
    notes: "Fallback profile for products that do not fit a core category.",
    tierTemplate: rangeRows(64, 50),
  },
];

const starterMaterials: MaterialSeed[] = [
  {
    name: "Matte Label Media - Cost Review Needed",
    materialType: "roll_media",
    purchaseUnit: "roll",
    purchaseCost: 0,
    baseUnit: "sqft",
    unit: "sqft",
    costPerUnit: 0,
    calculatedUnitCost: 0,
    rollWidthIn: 54,
    rollLengthFt: 150,
    vendor: "Cost review needed",
    sku: "LABEL-MATTE-TBD",
    notes: `${COST_REVIEW}: Replace with actual invoice cost, roll width, and roll length before quoting live label jobs.`,
  },
  {
    name: "Gloss Label Media - Cost Review Needed",
    materialType: "roll_media",
    purchaseUnit: "roll",
    purchaseCost: 0,
    baseUnit: "sqft",
    unit: "sqft",
    costPerUnit: 0,
    calculatedUnitCost: 0,
    rollWidthIn: 54,
    rollLengthFt: 150,
    vendor: "Cost review needed",
    sku: "LABEL-GLOSS-TBD",
    notes: `${COST_REVIEW}: Replace with actual gloss label media cost before quoting live jobs.`,
  },
  {
    name: "Clear Label Media - Cost Review Needed",
    materialType: "roll_media",
    purchaseUnit: "roll",
    purchaseCost: 0,
    baseUnit: "sqft",
    unit: "sqft",
    costPerUnit: 0,
    calculatedUnitCost: 0,
    rollWidthIn: 54,
    rollLengthFt: 150,
    vendor: "Cost review needed",
    sku: "LABEL-CLEAR-TBD",
    notes: `${COST_REVIEW}: Replace with actual clear media cost before quoting live jobs.`,
  },
  {
    name: "Gloss Laminate - Cost Review Needed",
    materialType: "roll_media",
    purchaseUnit: "roll",
    purchaseCost: 0,
    baseUnit: "sqft",
    unit: "sqft",
    costPerUnit: 0,
    calculatedUnitCost: 0,
    rollWidthIn: 54,
    rollLengthFt: 150,
    vendor: "Cost review needed",
    sku: "LAM-GLOSS-TBD",
    notes: `${COST_REVIEW}: Replace with actual laminate roll cost before using laminated label recipes.`,
  },
  {
    name: "Matte Laminate - Cost Review Needed",
    materialType: "roll_media",
    purchaseUnit: "roll",
    purchaseCost: 0,
    baseUnit: "sqft",
    unit: "sqft",
    costPerUnit: 0,
    calculatedUnitCost: 0,
    rollWidthIn: 54,
    rollLengthFt: 150,
    vendor: "Cost review needed",
    sku: "LAM-MATTE-TBD",
    notes: `${COST_REVIEW}: Replace with actual matte laminate roll cost before using laminated label recipes.`,
  },
  {
    name: "Packaging Supplies - Cost Review Needed",
    materialType: "packaging_supplies",
    purchaseUnit: "case",
    purchaseCost: 0,
    baseUnit: "each",
    unit: "each",
    costPerUnit: 0,
    calculatedUnitCost: 0,
    caseQuantity: 1,
    vendor: "Cost review needed",
    sku: "PACK-SUPPLIES-TBD",
    notes: `${COST_REVIEW}: Optional packaging supply placeholder. Replace with real case cost and quantity if used in recipes.`,
  },
];

const vendorTemplateSeeds: VendorTemplateSeed[] = [
  {
    name: "Template - 4x5 Outsourced Stock Bag",
    productType: "stock_bag",
    vendor: "Vendor TBD",
    vendorSku: "STOCK-BAG-4X5-TBD",
    moq: 64,
    defaultUnitCost: 0,
    leadTimeDays: 10,
    notes: `${COST_REVIEW}: Template only. Enter real vendor costs before quoting.`,
    tiers: [
      { minQty: 64, maxQty: 199, unitCost: 0 },
      { minQty: 200, maxQty: 499, unitCost: 0 },
      { minQty: 500, maxQty: 749, unitCost: 0 },
      { minQty: 750, maxQty: 999, unitCost: 0 },
      { minQty: 1000, maxQty: 1999, unitCost: 0 },
      { minQty: 2000, maxQty: null, unitCost: 0 },
    ],
    addOns: [
      { name: "Gloss finish", pricingType: "per_unit", amount: 0, notes: "Enter vendor per-unit gloss upcharge." },
      { name: "Setup fee", pricingType: "flat_fee", amount: 0, notes: "Enter vendor setup fee when applicable." },
      { name: "Freight", pricingType: "flat_fee", amount: 0, notes: "Enter estimated freight when applicable." },
    ],
  },
  {
    name: "Template - Outsourced Box",
    productType: "box",
    vendor: "Vendor TBD",
    vendorSku: "BOX-TBD",
    moq: 500,
    defaultUnitCost: 0,
    leadTimeDays: 14,
    notes: `${COST_REVIEW}: Template only. Enter real vendor costs and fees before quoting.`,
    tiers: [
      { minQty: 500, maxQty: 999, unitCost: 0 },
      { minQty: 1000, maxQty: 1999, unitCost: 0 },
      { minQty: 2000, maxQty: 2499, unitCost: 0 },
      { minQty: 2500, maxQty: 4999, unitCost: 0 },
      { minQty: 5000, maxQty: 7499, unitCost: 0 },
      { minQty: 7500, maxQty: 9999, unitCost: 0 },
      { minQty: 10000, maxQty: null, unitCost: 0 },
    ],
    addOns: [
      { name: "Gloss finish", pricingType: "per_unit", amount: 0, notes: "Enter vendor per-unit gloss upcharge." },
      { name: "Plate / setup fee", pricingType: "flat_fee", amount: 0, notes: "Enter vendor plate or setup fee." },
      { name: "Freight", pricingType: "flat_fee", amount: 0, notes: "Enter estimated freight." },
    ],
  },
];

const machineSeeds: MachineSeed[] = [
  {
    name: "Roland TrueVIS LG-540",
    machineType: "printer",
    maxWidthIn: 52.9,
    costPerHour: 5,
    sqftPerHour: 150,
    setupWastePct: 10,
    allowOverflow: true,
    notes:
      "GSO default for white/gloss/emboss label work. Tune with VersaWorks / Roland DG Connect job logs.",
    inkSlots: [
      { slotNumber: 1, inkName: "Cyan", inkType: "cmyk", cartridgeCost: ROLAND_POUCH_COST, cartridgeMl: ROLAND_POUCH_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 2, inkName: "Magenta", inkType: "cmyk", cartridgeCost: ROLAND_POUCH_COST, cartridgeMl: ROLAND_POUCH_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 3, inkName: "Yellow", inkType: "cmyk", cartridgeCost: ROLAND_POUCH_COST, cartridgeMl: ROLAND_POUCH_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 4, inkName: "Black", inkType: "cmyk", cartridgeCost: ROLAND_POUCH_COST, cartridgeMl: ROLAND_POUCH_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 5, inkName: "White", inkType: "white", cartridgeCost: ROLAND_POUCH_COST, cartridgeMl: ROLAND_POUCH_ML, mlPerSqft1Pct: DEFAULT_WHITE_GLOSS_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 6, inkName: "White", inkType: "white", cartridgeCost: ROLAND_POUCH_COST, cartridgeMl: ROLAND_POUCH_ML, mlPerSqft1Pct: DEFAULT_WHITE_GLOSS_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 7, inkName: "Gloss", inkType: "gloss", cartridgeCost: ROLAND_POUCH_COST, cartridgeMl: ROLAND_POUCH_ML, mlPerSqft1Pct: DEFAULT_WHITE_GLOSS_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 8, inkName: "Gloss", inkType: "gloss", cartridgeCost: ROLAND_POUCH_COST, cartridgeMl: ROLAND_POUCH_ML, mlPerSqft1Pct: DEFAULT_WHITE_GLOSS_ML_PER_SQFT_1PCT_PER_CHANNEL },
    ],
  },
  {
    name: "Mimaki UCJV300-130",
    machineType: "printer",
    maxWidthIn: 53.6,
    costPerHour: 5,
    sqftPerHour: 150,
    setupWastePct: 10,
    allowOverflow: false,
    notes:
      "GSO default for CMYK and white-only jobs. Gloss/emboss should route to Roland unless manually changed.",
    inkSlots: [
      { slotNumber: 1, inkName: "Cyan", inkType: "cmyk", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 2, inkName: "Magenta", inkType: "cmyk", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 3, inkName: "Yellow", inkType: "cmyk", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 4, inkName: "Black", inkType: "cmyk", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 5, inkName: "White", inkType: "white", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_WHITE_GLOSS_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 6, inkName: "White", inkType: "white", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_WHITE_GLOSS_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 7, inkName: "Unused - gloss routed to Roland", inkType: "gloss", cartridgeCost: 0, cartridgeMl: 0, mlPerSqft1Pct: 0, enabled: false },
      { slotNumber: 8, inkName: "Unused - gloss routed to Roland", inkType: "gloss", cartridgeCost: 0, cartridgeMl: 0, mlPerSqft1Pct: 0, enabled: false },
    ],
  },
];

function costPerMl(cost: number, ml: number) {
  return ml > 0 ? cost / ml : 0;
}

async function installProductTypes(shop: string) {
  for (const profile of productTypeSeeds) {
    await db.productTypeProfile.upsert({
      where: { shop_key: { shop, key: profile.key } },
      update: {
        name: profile.name,
        productionMode: profile.productionMode,
        minQuantity: profile.minQuantity,
        defaultQuantity: profile.defaultQuantity,
        tierBreakpoints: profile.tierBreakpoints,
        tierTemplate: JSON.stringify(profile.tierTemplate),
        defaultMarginPct: profile.defaultMarginPct,
        pricingMethod: profile.pricingMethod,
        defaultTags: profile.defaultTags,
        notes: profile.notes,
        active: true,
      },
      create: {
        shop,
        key: profile.key,
        name: profile.name,
        productionMode: profile.productionMode,
        minQuantity: profile.minQuantity,
        defaultQuantity: profile.defaultQuantity,
        tierBreakpoints: profile.tierBreakpoints,
        tierTemplate: JSON.stringify(profile.tierTemplate),
        defaultMarginPct: profile.defaultMarginPct,
        pricingMethod: profile.pricingMethod,
        defaultTags: profile.defaultTags,
        notes: profile.notes,
        active: true,
      },
    });
  }
}

async function installStarterMaterials(shop: string) {
  for (const material of starterMaterials) {
    const existing = await db.material.findFirst({ where: { shop, name: material.name } });
    const data = { ...material, shop, active: true };
    if (existing) {
      await db.material.update({ where: { id: existing.id }, data });
    } else {
      await db.material.create({ data });
    }
  }
}

async function installVendorTemplates(shop: string) {
  for (const seed of vendorTemplateSeeds) {
    const existing = await db.vendorProduct.findFirst({ where: { shop, name: seed.name } });
    if (existing) {
      await db.vendorProduct.update({
        where: { id: existing.id },
        data: {
          productType: seed.productType,
          vendor: seed.vendor,
          vendorSku: seed.vendorSku,
          moq: seed.moq,
          defaultUnitCost: seed.defaultUnitCost,
          leadTimeDays: seed.leadTimeDays,
          notes: seed.notes,
          active: true,
        },
      });
      await db.vendorProductTier.deleteMany({ where: { vendorProductId: existing.id } });
      await db.vendorProductAddOn.deleteMany({ where: { vendorProductId: existing.id } });
      await db.vendorProductTier.createMany({
        data: seed.tiers.map((tier) => ({ ...tier, shop, vendorProductId: existing.id })),
      });
      await db.vendorProductAddOn.createMany({
        data: seed.addOns.map((addOn) => ({ ...addOn, shop, vendorProductId: existing.id, enabled: true })),
      });
    } else {
      await db.vendorProduct.create({
        data: {
          shop,
          name: seed.name,
          productType: seed.productType,
          vendor: seed.vendor,
          vendorSku: seed.vendorSku,
          moq: seed.moq,
          defaultUnitCost: seed.defaultUnitCost,
          leadTimeDays: seed.leadTimeDays,
          notes: seed.notes,
          active: true,
          tiers: { create: seed.tiers.map((tier) => ({ ...tier, shop })) },
          addOns: { create: seed.addOns.map((addOn) => ({ ...addOn, shop, enabled: true })) },
        },
      });
    }
  }
}

async function installMissingMachines(shop: string) {
  for (const seed of machineSeeds) {
    const existing = await db.machine.findFirst({ where: { shop, name: seed.name } });
    if (existing) continue;
    await db.machine.create({
      data: {
        shop,
        name: seed.name,
        machineType: seed.machineType,
        maxWidthIn: seed.maxWidthIn,
        costPerHour: seed.costPerHour,
        sqftPerHour: seed.sqftPerHour,
        setupWastePct: seed.setupWastePct,
        allowOverflow: seed.allowOverflow,
        active: true,
        inkChannels: {
          create: seed.inkSlots.map((slot) => ({
            shop,
            slotNumber: slot.slotNumber,
            inkName: slot.inkName,
            inkType: slot.inkType,
            cartridgeCost: slot.cartridgeCost,
            cartridgeMl: slot.cartridgeMl,
            costPerMl: costPerMl(slot.cartridgeCost, slot.cartridgeMl),
            mlPerSqft1Pct: slot.mlPerSqft1Pct,
            mlPerSqft100: slot.mlPerSqft1Pct * 100,
            enabled: slot.enabled ?? true,
          })),
        },
      },
    });
  }
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [
    machines,
    materials,
    costReviewMaterials,
    productTypes,
    vendorProducts,
    recipes,
    quotes,
  ] = await Promise.all([
    db.machine.count({ where: { shop, active: true } }),
    db.material.count({ where: { shop, active: true } }),
    db.material.count({ where: { shop, active: true, notes: { contains: COST_REVIEW } } }),
    db.productTypeProfile.count({ where: { shop, active: true } }),
    db.vendorProduct.count({ where: { shop, active: true } }),
    db.productRecipe.count({ where: { shop, active: true } }),
    db.quote.count({ where: { shop } }),
  ]);

  return Response.json({
    machines,
    materials,
    costReviewMaterials,
    productTypes,
    vendorProducts,
    recipes,
    quotes,
    requiredProductTypes: productTypeSeeds.length,
    requiredMachines: machineSeeds.length,
    requiredStarterMaterials: starterMaterials.length,
    requiredVendorTemplates: vendorTemplateSeeds.length,
  });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "installMachines") {
    await installMissingMachines(shop);
    return Response.json({ ok: true, message: "Default printer profiles installed or already present." });
  }

  if (intent === "installMaterials") {
    await installStarterMaterials(shop);
    return Response.json({ ok: true, message: "Starter materials installed. Review costs before using them for live quotes." });
  }

  if (intent === "installProductTypes") {
    await installProductTypes(shop);
    return Response.json({ ok: true, message: "GSO product type defaults installed." });
  }

  if (intent === "installVendorTemplates") {
    await installVendorTemplates(shop);
    return Response.json({ ok: true, message: "Vendor product templates installed. Enter real costs before quoting outsourced work." });
  }

  if (intent === "installAll") {
    await installMissingMachines(shop);
    await installProductTypes(shop);
    await installStarterMaterials(shop);
    await installVendorTemplates(shop);
    return Response.json({ ok: true, message: "GSO setup foundation installed. Review costs, then create your first Product Setup." });
  }

  return Response.json({ ok: false, message: "Unknown setup action." }, { status: 400 });
}

function StatusBadge({ ready }: { ready: boolean }) {
  return ready ? <Badge tone="success">Ready</Badge> : <Badge tone="warning">Needs setup</Badge>;
}

function SetupCard({
  title,
  helper,
  count,
  target,
  intent,
  buttonLabel,
  linkLabel,
  linkPath,
}: {
  title: string;
  helper: string;
  count: number;
  target?: number;
  intent: string;
  buttonLabel: string;
  linkLabel: string;
  linkPath: string;
}) {
  const navigate = useNavigate();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const ready = target ? count >= target : count > 0;

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text as="h3" variant="headingMd">{title}</Text>
            <Text as="p" tone="subdued">{helper}</Text>
          </BlockStack>
          <StatusBadge ready={ready} />
        </InlineStack>

        <Text as="p">
          Current: <strong>{count}</strong>{target ? ` / ${target}+ recommended` : ""}
        </Text>

        <InlineStack gap="200">
          <Form method="post">
            <input type="hidden" name="intent" value={intent} />
            <Button submit loading={busy}>{buttonLabel}</Button>
          </Form>
          <Button variant="plain" onClick={() => navigate(linkPath)}>{linkLabel}</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function GsoSetupCenter() {
  const data = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const setupReady =
    data.machines >= data.requiredMachines &&
    data.materials > 0 &&
    data.productTypes >= data.requiredProductTypes &&
    data.vendorProducts > 0;

  return (
    <Page
      title="GSO Setup Center"
      subtitle="Install and review the foundation needed before Product Setup, Quotes, and Production run smoothly."
      primaryAction={{ content: "Go to Product Setup", onAction: () => navigate("/app/erp/product-setup") }}
      secondaryActions={[{ content: "Create Quote", onAction: () => navigate("/app/quotes") }]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">ERP launch checklist</Text>
                  <Text as="p" tone="subdued">
                    Use this page when the app feels empty. It installs the default machines, starter materials, product type profiles, and vendor templates needed to create accurate product setups.
                  </Text>
                </BlockStack>
                {setupReady ? <Badge tone="success">Foundation ready</Badge> : <Badge tone="warning">Setup needed</Badge>}
              </InlineStack>

              {actionData?.message ? (
                <Text as="p" tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Text>
              ) : null}

              <InlineStack gap="200" wrap>
                <Form method="post">
                  <input type="hidden" name="intent" value="installAll" />
                  <Button variant="primary" submit loading={busy}>Install / refresh GSO defaults</Button>
                </Form>
                <Button onClick={() => navigate("/app/erp/product-setup")}>Start product setup</Button>
                <Button onClick={() => navigate("/app/quotes")}>Open quotes</Button>
              </InlineStack>

              <Divider />

              <Text as="p">
                Important: starter materials and vendor templates install with zero-cost placeholders and <strong>{COST_REVIEW}</strong> notes. Update real costs before quoting live orders.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="300" wrap>
            <div style={{ minWidth: 240, flex: 1 }}>
              <SetupCard
                title="Machines"
                helper="Roland LG-540 and Mimaki UCJV300-130 printer profiles."
                count={data.machines}
                target={data.requiredMachines}
                intent="installMachines"
                buttonLabel="Install missing machines"
                linkLabel="Review machines"
                linkPath="/app/erp/machines"
              />
            </div>
            <div style={{ minWidth: 240, flex: 1 }}>
              <SetupCard
                title="Product Type Profiles"
                helper="Defaults for Labels, Stock Bags, Boxes, DTP Bags, and more."
                count={data.productTypes}
                target={data.requiredProductTypes}
                intent="installProductTypes"
                buttonLabel="Install product types"
                linkLabel="Edit product types"
                linkPath="/app/erp/product-types"
              />
            </div>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <InlineStack gap="300" wrap>
            <div style={{ minWidth: 240, flex: 1 }}>
              <SetupCard
                title="Starter Materials"
                helper="Roll media, laminate, and packaging placeholders for in-house recipes."
                count={data.materials}
                target={data.requiredStarterMaterials}
                intent="installMaterials"
                buttonLabel="Install starter materials"
                linkLabel="Review materials"
                linkPath="/app/erp/materials"
              />
            </div>
            <div style={{ minWidth: 240, flex: 1 }}>
              <SetupCard
                title="Vendor Templates"
                helper="Outsourced stock bag and box templates with tier/add-on rows."
                count={data.vendorProducts}
                target={data.requiredVendorTemplates}
                intent="installVendorTemplates"
                buttonLabel="Install vendor templates"
                linkLabel="Review vendor products"
                linkPath="/app/erp/vendor-products"
              />
            </div>
          </InlineStack>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Cost review warnings</Text>
              <Text as="p">
                Materials needing cost review: <strong>{data.costReviewMaterials}</strong>
              </Text>
              <Text as="p" tone="subdued">
                These are safe placeholders so the app has dropdown options. They should not be trusted for live quoting until purchase cost, yield, roll size, case quantity, or vendor cost tiers are updated.
              </Text>
              <InlineStack gap="200">
                <Button onClick={() => navigate("/app/erp/materials")}>Fix material costs</Button>
                <Button onClick={() => navigate("/app/erp/vendor-products")}>Fix vendor costs</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Recommended order</Text>
              <Text as="p">1. Install defaults here.</Text>
              <Text as="p">2. Update real material and vendor costs.</Text>
              <Text as="p">3. Create Product Setup records for real products.</Text>
              <Text as="p">4. Quote from ERP recipes instead of manual line items.</Text>
              <Text as="p">5. Next milestone: paid quote to production job workflow.</Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
