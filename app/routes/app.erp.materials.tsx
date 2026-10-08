import {
  Page,
  Layout,
  Card,
  Text,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Select,
  Badge,
  Divider,
} from "@shopify/polaris";
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { updateOwnedRecord } from "../lib/security-guards-shared";

const defaultMaterialTypes = [
  { label: "Ink / Coating", value: "ink_coating" },
  { label: "Roll Media", value: "roll_media" },
  { label: "Blank Bags", value: "blank_bags" },
  { label: "Zipper", value: "zipper" },
  { label: "Card Stock", value: "card_stock" },
  { label: "Packaging Supplies", value: "packaging_supplies" },
  { label: "Outsourced Cost", value: "outsourced_cost" },
  { label: "General", value: "general" },
];

const defaultProductFamilies = [
  { label: "Labels", value: "labels" },
  { label: "Sticker Bags", value: "sticker_bags" },
  { label: "DTP Bags", value: "dtp_bags" },
  { label: "Boxes", value: "boxes" },
  { label: "DTF / Apparel", value: "dtf_apparel" },
];

function makeOption(labelOrValue: string) {
  const raw = String(labelOrValue || "").trim();
  const value = raw.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return { label: raw || "General", value: value || "general" };
}

function uniqueOptions(base: { label: string; value: string }[], extraValues: string[] = []) {
  const map = new Map<string, { label: string; value: string }>();
  for (const option of base) map.set(option.value, option);
  for (const value of extraValues) {
    if (!value) continue;
    const option = makeOption(value);
    if (!map.has(option.value)) map.set(option.value, option);
  }
  return Array.from(map.values()).sort((a, b) => {
    const ai = base.findIndex((option) => option.value === a.value);
    const bi = base.findIndex((option) => option.value === b.value);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.label.localeCompare(b.label);
  });
}

function parseFamilies(value: string | null | undefined) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function familyLabel(value: string) {
  const match = defaultProductFamilies.find((option) => option.value === value);
  if (match) return match.label;
  return String(value || "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeType(value: string | null | undefined) {
  const type = String(value || "general").toLowerCase().trim().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["ink", "ink_coating", "coating", "gloss", "white_ink", "cmyk_ink", "uv_ink"].includes(type)) return "ink_coating";
  if (["label", "labels", "roll_media", "roll", "media", "vinyl", "sticker", "stickers", "film"].includes(type)) return "roll_media";
  if (["blank_bag", "blank_bags", "bag", "bags", "pouch", "pouches", "stock_bag", "sticker_bag", "dtp", "dtp_bag"].includes(type)) return "blank_bags";
  if (["zip", "zipper", "zippers"].includes(type)) return "zipper";
  if (["card", "cardstock", "card_stock", "paperboard", "paper_board"].includes(type)) return "card_stock";
  if (["box", "boxes", "carton", "cartons"].includes(type)) return "boxes";
  if (["laminate", "lamination", "lam"].includes(type)) return "laminate";
  if (["shipping", "freight", "packing", "packaging", "packaging_supplies", "supplies"].includes(type)) return "packaging_supplies";
  if (["outsourced", "outsourced_cost", "sourced", "vendor", "vendor_product"].includes(type)) return "outsourced_cost";
  return type || "general";
}

function materialTypeLabel(value: string | null | undefined) {
  const normalized = normalizeType(value);
  const match = defaultMaterialTypes.find((option) => option.value === normalized);
  if (match) return match.label;
  return String(value || "General").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

const smartUnitRules: Record<string, { purchaseUnits: { label: string; value: string }[]; baseUnits: { label: string; value: string }[]; defaultPurchaseUnit: string; defaultBaseUnit: string; defaultVolumeMl?: string }> = {
  ink_coating: {
    purchaseUnits: [
      { label: "Cartridge / pouch", value: "cartridge" },
      { label: "Bottle", value: "bottle" },
      { label: "Pouch", value: "pouch" },
    ],
    baseUnits: [{ label: "ml", value: "ml" }],
    defaultPurchaseUnit: "cartridge",
    defaultBaseUnit: "ml",
    defaultVolumeMl: "750",
  },
  roll_media: {
    purchaseUnits: [{ label: "Roll", value: "roll" }],
    baseUnits: [
      { label: "Sq Ft", value: "sqft" },
      { label: "Sq In", value: "sqin" },
    ],
    defaultPurchaseUnit: "roll",
    defaultBaseUnit: "sqft",
  },
  laminate: {
    purchaseUnits: [{ label: "Roll", value: "roll" }],
    baseUnits: [
      { label: "Sq Ft", value: "sqft" },
      { label: "Sq In", value: "sqin" },
    ],
    defaultPurchaseUnit: "roll",
    defaultBaseUnit: "sqft",
  },
  blank_bags: {
    purchaseUnits: [
      { label: "Case", value: "case" },
      { label: "Box", value: "box" },
      { label: "Each", value: "each" },
    ],
    baseUnits: [{ label: "Each", value: "each" }],
    defaultPurchaseUnit: "case",
    defaultBaseUnit: "each",
  },
  boxes: {
    purchaseUnits: [
      { label: "Case", value: "case" },
      { label: "Box", value: "box" },
      { label: "Each", value: "each" },
    ],
    baseUnits: [{ label: "Each", value: "each" }],
    defaultPurchaseUnit: "case",
    defaultBaseUnit: "each",
  },
  die_cut: {
    purchaseUnits: [
      { label: "Case", value: "case" },
      { label: "Box", value: "box" },
      { label: "Each", value: "each" },
      { label: "Roll", value: "roll" },
    ],
    baseUnits: [
      { label: "Each", value: "each" },
      { label: "Sq Ft", value: "sqft" },
      { label: "Sq In", value: "sqin" },
    ],
    defaultPurchaseUnit: "case",
    defaultBaseUnit: "each",
  },
  labor: {
    purchaseUnits: [
      { label: "Hour", value: "hour" },
      { label: "Each", value: "each" },
    ],
    baseUnits: [
      { label: "Hour", value: "hour" },
      { label: "Each", value: "each" },
    ],
    defaultPurchaseUnit: "hour",
    defaultBaseUnit: "hour",
  },
  machine: {
    purchaseUnits: [
      { label: "Hour", value: "hour" },
      { label: "Each", value: "each" },
    ],
    baseUnits: [
      { label: "Hour", value: "hour" },
      { label: "Each", value: "each" },
    ],
    defaultPurchaseUnit: "hour",
    defaultBaseUnit: "hour",
  },
  packaging_supplies: {
    purchaseUnits: [
      { label: "Each", value: "each" },
      { label: "Box", value: "box" },
      { label: "Case", value: "case" },
    ],
    baseUnits: [{ label: "Each", value: "each" }],
    defaultPurchaseUnit: "each",
    defaultBaseUnit: "each",
  },
  zipper: {
    purchaseUnits: [
      { label: "Case", value: "case" },
      { label: "Box", value: "box" },
      { label: "Each", value: "each" },
      { label: "Roll", value: "roll" },
    ],
    baseUnits: [{ label: "Each", value: "each" }],
    defaultPurchaseUnit: "each",
    defaultBaseUnit: "each",
  },
  card_stock: {
    purchaseUnits: [
      { label: "Case", value: "case" },
      { label: "Box", value: "box" },
      { label: "Each", value: "each" },
      { label: "Roll", value: "roll" },
    ],
    baseUnits: [
      { label: "Each", value: "each" },
      { label: "Sq Ft", value: "sqft" },
      { label: "Sq In", value: "sqin" },
    ],
    defaultPurchaseUnit: "each",
    defaultBaseUnit: "each",
  },
  outsourced_cost: {
    purchaseUnits: [
      { label: "Each", value: "each" },
      { label: "Case", value: "case" },
      { label: "Box", value: "box" },
    ],
    baseUnits: [{ label: "Each", value: "each" }],
    defaultPurchaseUnit: "each",
    defaultBaseUnit: "each",
  },
  general: {
    purchaseUnits: [
      { label: "Each", value: "each" },
      { label: "Case", value: "case" },
      { label: "Box", value: "box" },
      { label: "Roll", value: "roll" },
      { label: "Hour", value: "hour" },
    ],
    baseUnits: [
      { label: "Each", value: "each" },
      { label: "Sq Ft", value: "sqft" },
      { label: "Sq In", value: "sqin" },
      { label: "ml", value: "ml" },
      { label: "Hour", value: "hour" },
    ],
    defaultPurchaseUnit: "each",
    defaultBaseUnit: "each",
  },
};

function getUnitRule(materialType: string) {
  return smartUnitRules[normalizeType(materialType)] || smartUnitRules.general;
}

function calculateAvailableUnits(material: any) {
  const stock = Number(material.stockOnHand) || 0;
  const purchaseUnit = material.purchaseUnit || "each";

  if (purchaseUnit === "roll") {
    const widthIn = Number(material.rollWidthIn) || 0;
    const lengthFt = Number(material.rollLengthFt) || 0;
    const totalSqFt = (widthIn * lengthFt * 12) / 144;
    return stock * totalSqFt;
  }

  if (["cartridge", "bottle", "pouch"].includes(purchaseUnit)) {
    return stock * (Number(material.volumeMl) || 0);
  }

  if (["case", "box"].includes(purchaseUnit)) {
    return stock * (Number(material.caseQuantity) || 0);
  }

  return stock;
}

function formatBaseUnitLabel(unit: string) {
  if (unit === "sqft") return "sqft";
  if (unit === "sqin") return "sq in";
  if (unit === "ml") return "ml";
  return unit || "each";
}

// Display-only: "$0.001234 per sqft" style money labels (no rounding changes).
function moneyPer(value: any, unit: string, decimals = 6) {
  return `$${Number(value || 0).toFixed(decimals)} per ${formatBaseUnitLabel(unit)}`;
}

function formatDate(value: any) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

function NativeInput({ label, value, onChange, type = "text", prefix, suffix, helpText }: any) {
  return (
    <label style={{ display: "block", flex: 1, minWidth: 180 }}>
      <span style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {prefix ? <span>{prefix}</span> : null}
        <input
          type={type}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          style={{ width: "100%", padding: "7px 9px", border: "1px solid #8a8a8a", borderRadius: 6 }}
        />
        {suffix ? <span>{suffix}</span> : null}
      </div>
      {helpText ? <span style={{ display: "block", color: "#6d7175", fontSize: 11, marginTop: 4 }}>{helpText}</span> : null}
    </label>
  );
}

function NativeSelect({ label, value, onChange, options, helpText }: any) {
  return (
    <label style={{ display: "block", flex: 1, minWidth: 180 }}>
      <span style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        style={{ width: "100%", padding: "7px 9px", border: "1px solid #8a8a8a", borderRadius: 6, background: "white" }}
      >
        {options.map((option: any) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {helpText ? <span style={{ display: "block", color: "#6d7175", fontSize: 11, marginTop: 4 }}>{helpText}</span> : null}
    </label>
  );
}

function NativeTextarea({ label, value, onChange, helpText }: any) {
  return (
    <label style={{ display: "block" }}>
      <span style={{ display: "block", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        rows={3}
        style={{ width: "100%", padding: "7px 9px", border: "1px solid #8a8a8a", borderRadius: 6 }}
      />
      {helpText ? <span style={{ display: "block", color: "#6d7175", fontSize: 11, marginTop: 4 }}>{helpText}</span> : null}
    </label>
  );
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const [materials, vendors] = await Promise.all([
    db.material.findMany({
    where: { shop: session.shop },
    orderBy: { updatedAt: "desc" },
    include: {
      primaryVendor: true,
      vendors: true,
      costHistory: {
        orderBy: { createdAt: "desc" },
        take: 5,
      },
      variants: { orderBy: [{ active: "desc" }, { name: "asc" }] },
    },
  }),
    db.vendor.findMany({
      where: { shop: session.shop, active: true },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      include: { contacts: { where: { active: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] } },
    }),
  ]);

  const customMaterialTypes = Array.from(new Set(materials.map((material: any) => normalizeType(material.materialType)).filter(Boolean)));
  const customProductFamilies = Array.from(
    new Set(
      materials.flatMap((material: any) => parseFamilies(material.productFamilies)).filter(Boolean)
    )
  );

  return Response.json({ materials, vendors, customMaterialTypes, customProductFamilies });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const payload = await request.json();

  async function selectedVendorRecord(vendorId: string | null | undefined) {
    if (!vendorId) return null;
    return db.vendor.findFirst({ where: { shop, id: vendorId, active: true } });
  }

  if (payload.intent === "saveMaterial") {
    const selectedVendor = await selectedVendorRecord(payload.primaryVendorId);
    const vendorName = selectedVendor?.name || payload.vendor || null;
    const vendorLeadTime = selectedVendor?.leadTimeDays ?? null;

    const oldMaterial = payload.id
  ? await db.material.findFirst({ where: { id: payload.id, shop } })
  : null;

    // 15G.1: never update a record the authenticated shop does not own.
    if (payload.id && !oldMaterial) {
      return Response.json({ ok: false, error: "Material not found for this shop." }, { status: 404 });
    }

const calculatedUnitCost = calculateMaterialUnitCost(payload);

    let material;

    if (payload.id) {
      material = await db.material.update({
        where: { id: payload.id },
        data: {
          name: payload.name,
          materialType: normalizeType(payload.materialType),
          productFamilies: payload.productFamilies || "",
          costReviewNeeded: Boolean(payload.costReviewNeeded),
          useInRecipes: payload.useInRecipes !== false,
          vendor: vendorName,
          primaryVendorId: selectedVendor?.id || null,
          sku: payload.sku || null,
          stockOnHand: payload.stockOnHand ? Number(payload.stockOnHand) : null,
          reorderPoint: payload.reorderPoint ? Number(payload.reorderPoint) : null,
          leadTimeDays: payload.leadTimeDays ? Number(payload.leadTimeDays) : vendorLeadTime,
          notes: payload.notes || null,
          active: payload.active !== false,
          purchaseUnit: payload.purchaseUnit || "each",
          purchaseCost: Number(payload.purchaseCost) || 0,
          baseUnit: payload.baseUnit || "each",
          rollWidthIn: payload.rollWidthIn ? Number(payload.rollWidthIn) : null,
          rollLengthFt: payload.rollLengthFt ? Number(payload.rollLengthFt) : null,
          volumeMl: payload.volumeMl ? Number(payload.volumeMl) : null,
          caseQuantity: payload.caseQuantity ? Number(payload.caseQuantity) : null,
          calculatedUnitCost,
          costPerUnit: calculatedUnitCost,
          unit: payload.baseUnit || "each",
        },
      });

      if (
        oldMaterial &&
        Number(oldMaterial.costPerUnit) !== Number(calculatedUnitCost)
    )
       {
        await db.materialCostHistory.create({
          data: {
            shop,
            materialId: material.id,
            oldCost: Number(oldMaterial.costPerUnit) || 0,
            newCost: calculatedUnitCost,            vendor: vendorName,
            reason: payload.reason || "Cost updated",
            changedBy: session.shop,
          },
        });
      }
    } else {
      material = await db.material.create({
        data: {
          shop,
          name: payload.name,
          materialType: normalizeType(payload.materialType),
          productFamilies: payload.productFamilies || "",
          costReviewNeeded: Boolean(payload.costReviewNeeded),
          useInRecipes: payload.useInRecipes !== false,
          vendor: vendorName,
          primaryVendorId: selectedVendor?.id || null,
          sku: payload.sku || null,
          stockOnHand: payload.stockOnHand ? Number(payload.stockOnHand) : null,
          reorderPoint: payload.reorderPoint ? Number(payload.reorderPoint) : null,
          leadTimeDays: payload.leadTimeDays ? Number(payload.leadTimeDays) : vendorLeadTime,
          notes: payload.notes || null,
          active: true,
          purchaseUnit: payload.purchaseUnit || "each",
          purchaseCost: Number(payload.purchaseCost) || 0,
          baseUnit: payload.baseUnit || "each",
          rollWidthIn: payload.rollWidthIn ? Number(payload.rollWidthIn) : null,
          rollLengthFt: payload.rollLengthFt ? Number(payload.rollLengthFt) : null,
          volumeMl: payload.volumeMl ? Number(payload.volumeMl) : null,
          caseQuantity: payload.caseQuantity ? Number(payload.caseQuantity) : null,
          calculatedUnitCost,
          costPerUnit: calculatedUnitCost,
          unit: payload.baseUnit || "each",
        },
      });

      await db.materialCostHistory.create({
        data: {
          shop,
          materialId: material.id,
          oldCost: 0,
          newCost: calculatedUnitCost,          
          vendor: vendorName,
          reason: "Material created",
          changedBy: session.shop,
        },
      });
    }

    const materials = await db.material.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        primaryVendor: true,
        vendors: true,
        costHistory: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
        variants: { orderBy: [{ active: "desc" }, { name: "asc" }] },
      },
    });

    return Response.json({ ok: true, materials });
  }

  if (payload.intent === "addMaterialVariant") {
    const material = await db.material.findFirst({ where: { shop, id: payload.materialId } });
    if (!material) return Response.json({ ok: false, error: "Material not found." }, { status: 404 });

    await db.materialVariant.create({
      data: {
        shop,
        materialId: material.id,
        name: payload.variantName || payload.color || "Variant",
        color: payload.color || null,
        sku: payload.variantSku || null,
        stockOnHand: payload.variantStockOnHand ? Number(payload.variantStockOnHand) : null,
        reorderPoint: payload.variantReorderPoint ? Number(payload.variantReorderPoint) : null,
        notes: payload.variantNotes || null,
        active: true,
      },
    });

    const materials = await db.material.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        primaryVendor: true,
        vendors: true,
        costHistory: { orderBy: { createdAt: "desc" }, take: 5 },
        variants: { orderBy: [{ active: "desc" }, { name: "asc" }] },
      },
    });

    return Response.json({ ok: true, materials, message: "Material variant added." });
  }

  if (payload.intent === "archiveMaterialVariant" || payload.intent === "restoreMaterialVariant") {
    await db.materialVariant.updateMany({
      where: { shop, id: payload.variantId },
      data: { active: payload.intent === "restoreMaterialVariant" },
    });

    const materials = await db.material.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        primaryVendor: true,
        vendors: true,
        costHistory: { orderBy: { createdAt: "desc" }, take: 5 },
        variants: { orderBy: [{ active: "desc" }, { name: "asc" }] },
      },
    });

    return Response.json({ ok: true, materials, message: payload.intent === "restoreMaterialVariant" ? "Variant restored." : "Variant archived." });
  }

  if (payload.intent === "deleteMaterial" || payload.intent === "archiveMaterial") {
    const result = await updateOwnedRecord(db.material, shop, payload.id, { active: false });
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });

    const materials = await db.material.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        primaryVendor: true,
        vendors: true,
        costHistory: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
        variants: { orderBy: [{ active: "desc" }, { name: "asc" }] },
      },
    });

    return Response.json({ ok: true, materials, message: "Material archived." });
  }

  if (payload.intent === "restoreMaterial") {
    const result = await updateOwnedRecord(db.material, shop, payload.id, { active: true });
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });

    const materials = await db.material.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        primaryVendor: true,
        vendors: true,
        costHistory: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
        variants: { orderBy: [{ active: "desc" }, { name: "asc" }] },
      },
    });

    return Response.json({ ok: true, materials, message: "Material restored." });
  }

  if (payload.intent === "permanentDeleteMaterial") {
    const material = await db.material.findFirst({ where: { id: payload.id, shop } });
    if (!material) return Response.json({ ok: false, error: "Material not found." }, { status: 404 });

    const [recipeCount, productionUsageCount, movementCount, purchaseRequestCount, costBookCount] = await Promise.all([
      db.recipeMaterial.count({ where: { materialId: payload.id, shop } }),
      db.productionMaterialUsage.count({ where: { materialId: payload.id, shop } }),
      db.materialInventoryMovement.count({ where: { materialId: payload.id, shop } }),
      db.purchaseRequest.count({ where: { materialId: payload.id, shop } }),
      db.vendorCostBookItem.count({ where: { materialId: payload.id, shop } }).catch(() => 0),
    ]);

    const usedCount = recipeCount + productionUsageCount + movementCount + purchaseRequestCount + costBookCount;
    if (usedCount > 0) {
      await db.material.updateMany({ where: { id: payload.id, shop }, data: { active: false } });
      const materials = await db.material.findMany({
        where: { shop },
        orderBy: { updatedAt: "desc" },
        include: { primaryVendor: true, vendors: true, costHistory: { orderBy: { createdAt: "desc" }, take: 5 } },
      });
      return Response.json({ ok: false, materials, error: "This material is used by recipes, production, inventory, purchase requests, or cost book records, so it was archived instead of permanently deleted." });
    }

    await db.material.deleteMany({ where: { id: payload.id, shop } });

    const materials = await db.material.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        primaryVendor: true,
        vendors: true,
        costHistory: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
        variants: { orderBy: [{ active: "desc" }, { name: "asc" }] },
      },
    });

    return Response.json({ ok: true, materials, message: "Material permanently deleted." });
  }

  if (payload.intent === "addVendor") {
    // 15G.1: verify the parent material belongs to the authenticated shop.
    const parentMaterial = await db.material.findFirst({ where: { id: payload.materialId, shop }, select: { id: true } });
    if (!parentMaterial) return Response.json({ ok: false, error: "Material not found for this shop." }, { status: 404 });

    await db.materialVendor.create({
      data: {
        shop,
        materialId: parentMaterial.id,
        vendorName: payload.vendorName,
        vendorSku: payload.vendorSku || null,
        unitCost: Number(payload.unitCost) || 0,
        unit: payload.unit || "each",
        moq: payload.moq ? Number(payload.moq) : null,
        leadTimeDays: payload.leadTimeDays ? Number(payload.leadTimeDays) : vendorLeadTime,
        notes: payload.notes || null,
        preferred: false,
        active: true,
      },
    });

    const materials = await db.material.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        primaryVendor: true,
        vendors: true,
        costHistory: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
        variants: { orderBy: [{ active: "desc" }, { name: "asc" }] },
      },
    });

    return Response.json({ ok: true, materials });
  }

  const materials = await db.material.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    include: {
      vendors: true,
      costHistory: {
        orderBy: { createdAt: "desc" },
        take: 5,
      },
      variants: { orderBy: [{ active: "desc" }, { name: "asc" }] },
    },
  });

  return Response.json({ ok: false, materials });
}

function calculateMaterialUnitCost(payload: any) {
  const purchaseCost = Number(payload.purchaseCost) || 0;

  if (payload.purchaseUnit === "roll") {
    const widthIn = Number(payload.rollWidthIn) || 0;
    const lengthFt = Number(payload.rollLengthFt) || 0;
    const totalSqIn = widthIn * lengthFt * 12;
    const totalSqFt = totalSqIn / 144;

    if (payload.baseUnit === "sqin") {
      return totalSqIn > 0 ? purchaseCost / totalSqIn : 0;
    }

    return totalSqFt > 0 ? purchaseCost / totalSqFt : 0;
  }

  if (["cartridge", "bottle", "pouch"].includes(payload.purchaseUnit)) {
    const volumeMl = Number(payload.volumeMl) || 0;
    return volumeMl > 0 ? purchaseCost / volumeMl : 0;
  }

  if (payload.purchaseUnit === "gallon") {
    const volumeMl = 3785.41;
    return purchaseCost / volumeMl;
  }

  if (payload.purchaseUnit === "case" || payload.purchaseUnit === "box") {
    const caseQty = Number(payload.caseQuantity) || 0;
    return caseQty > 0 ? purchaseCost / caseQty : 0;
  }

  return purchaseCost;
}

export default function MaterialsPage() {
  const navigate = useNavigate();
  const loaderData = useLoaderData<typeof loader>() as any;
  const fetcher = useFetcher<any>();

  const [materials, setMaterials] = useState<any[]>(loaderData.materials || []);
  const vendors = loaderData.vendors || [];
  const customMaterialTypes = loaderData.customMaterialTypes || [];
  const customProductFamilies = loaderData.customProductFamilies || [];
  const vendorOptions = [
    { label: "Manual / no Vendor Center link", value: "" },
    ...vendors.map((vendor: any) => ({
      label: `${vendor.name}${vendor.status ? ` (${vendor.status})` : ""}`,
      value: vendor.id,
    })),
  ];
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [materialType, setMaterialType] = useState("ink_coating");
  const [customMaterialType, setCustomMaterialType] = useState("");
  const [selectedFamilies, setSelectedFamilies] = useState<string[]>([]);
  const [customProductFamily, setCustomProductFamily] = useState("");
  const [vendor, setVendor] = useState("");
  const [primaryVendorId, setPrimaryVendorId] = useState("");
  const [sku, setSku] = useState("");
  const [stockOnHand, setStockOnHand] = useState("");
  const [reorderPoint, setReorderPoint] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [costReviewNeeded, setCostReviewNeeded] = useState(false);
  const [useInRecipes, setUseInRecipes] = useState(true);
  const finalMaterialType = materialType === "custom" ? makeOption(customMaterialType).value : normalizeType(materialType);
  const availableMaterialTypeOptions = uniqueOptions(defaultMaterialTypes, customMaterialTypes).concat([{ label: "+ Add custom type", value: "custom" }]);
  const availableFamilyOptions = uniqueOptions(defaultProductFamilies, customProductFamilies).concat([{ label: "+ Add custom family", value: "custom" }]);

  const [purchaseUnit, setPurchaseUnit] = useState("each");
  const [purchaseCost, setPurchaseCost] = useState("");
  const [baseUnit, setBaseUnit] = useState("each");
  const [rollWidthIn, setRollWidthIn] = useState("");
  const [rollLengthFt, setRollLengthFt] = useState("");
  const [volumeMl, setVolumeMl] = useState("");
  const [caseQuantity, setCaseQuantity] = useState("");
  const [filter, setFilter] = useState("all");
  const [familyFilter, setFamilyFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [reviewFilter, setReviewFilter] = useState("all");
  const [recipeFilter, setRecipeFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [vendorMaterialId, setVendorMaterialId] = useState("");
  const [vendorCenterId, setVendorCenterId] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vendorSku, setVendorSku] = useState("");
  const [vendorUnitCost, setVendorUnitCost] = useState("");
  const [vendorMoq, setVendorMoq] = useState("");
  const [vendorLeadTimeDays, setVendorLeadTimeDays] = useState("");
  const [variantMaterialId, setVariantMaterialId] = useState("");
  const [variantName, setVariantName] = useState("");
  const [variantColor, setVariantColor] = useState("");
  const [variantSku, setVariantSku] = useState("");
  const [variantStockOnHand, setVariantStockOnHand] = useState("");
  const [variantReorderPoint, setVariantReorderPoint] = useState("");
  const [variantNotes, setVariantNotes] = useState("");

  useEffect(() => {
    if (fetcher.data?.materials) setMaterials(fetcher.data.materials);
  }, [fetcher.data]);
  // 2026-10-07: surface the action result (e.g. "archived instead of deleted") — it was silently dropped before.
  const actionFeedback = (fetcher.data as any)?.error || (fetcher.data as any)?.message || null;
  const actionFeedbackIsError = Boolean((fetcher.data as any)?.error);

  useEffect(() => {
    const rule = getUnitRule(finalMaterialType);
    if (!rule.purchaseUnits.some((option) => option.value === purchaseUnit)) {
      setPurchaseUnit(rule.defaultPurchaseUnit);
    }
    if (!rule.baseUnits.some((option) => option.value === baseUnit)) {
      setBaseUnit(rule.defaultBaseUnit);
    }
    if (finalMaterialType === "ink_coating" && !volumeMl && rule.defaultVolumeMl) {
      setVolumeMl(rule.defaultVolumeMl);
    }
  }, [finalMaterialType]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setMaterialType("ink_coating");
    setCustomMaterialType("");
    setSelectedFamilies([]);
    setCustomProductFamily("");
    setVendor("");
    setPrimaryVendorId("");
    setSku("");
    setStockOnHand("");
    setReorderPoint("");
    setLeadTimeDays("");
    setReason("");
    setNotes("");
    setCostReviewNeeded(false);
    setUseInRecipes(true);
    const rule = getUnitRule("label");
    setPurchaseUnit(rule.defaultPurchaseUnit);
    setBaseUnit(rule.defaultBaseUnit);
    setPurchaseCost("");
    setRollWidthIn("");
    setRollLengthFt("");
    setVolumeMl("");
    setCaseQuantity("");
  }

  function saveMaterial() {
    fetcher.submit(
      {
        intent: "saveMaterial",
        id: editingId,
        name,
        materialType: finalMaterialType,
        productFamilies: selectedFamilies.join(","),
        vendor,
        primaryVendorId,
        sku,
        stockOnHand,
        reorderPoint,
        leadTimeDays,
        reason,
        notes,
        costReviewNeeded,
        useInRecipes,
        purchaseUnit,
        purchaseCost,
        baseUnit,
        rollWidthIn,
        rollLengthFt,
        volumeMl,
        caseQuantity,
      },
      { method: "post", encType: "application/json" }
    );

    resetForm();
  }

  function editMaterial(material: any) {
    setEditingId(material.id);
    setName(material.name || "");
    setMaterialType(normalizeType(material.materialType || "general"));
    setCustomMaterialType("");
    setSelectedFamilies(parseFamilies(material.productFamilies));
    setCustomProductFamily("");
    setVendor(material.vendor || material.primaryVendor?.name || "");
    setPrimaryVendorId(material.primaryVendorId || material.primaryVendor?.id || "");
    setSku(material.sku || "");
    setStockOnHand(material.stockOnHand ? String(material.stockOnHand) : "");
    setReorderPoint(material.reorderPoint ? String(material.reorderPoint) : "");
    setLeadTimeDays(material.leadTimeDays ? String(material.leadTimeDays) : "");
    setReason("");
    setNotes(material.notes || "");
    setCostReviewNeeded(Boolean(material.costReviewNeeded));
    setUseInRecipes(material.useInRecipes !== false);
    setPurchaseUnit(material.purchaseUnit || getUnitRule(material.materialType || "label").defaultPurchaseUnit);
    setPurchaseCost(material.purchaseCost ? String(material.purchaseCost) : "");
    setBaseUnit(material.baseUnit || material.unit || getUnitRule(material.materialType || "label").defaultBaseUnit);
    setRollWidthIn(material.rollWidthIn ? String(material.rollWidthIn) : "");
    setRollLengthFt(material.rollLengthFt ? String(material.rollLengthFt) : "");
    setVolumeMl(material.volumeMl ? String(material.volumeMl) : "");
    setCaseQuantity(material.caseQuantity ? String(material.caseQuantity) : "");
  }

  function archiveMaterial(id: string) {
    fetcher.submit(
      { intent: "archiveMaterial", id },
      { method: "post", encType: "application/json" }
    );
  }

  function restoreMaterial(id: string) {
    fetcher.submit(
      { intent: "restoreMaterial", id },
      { method: "post", encType: "application/json" }
    );
  }

  function permanentDeleteMaterial(material: any) {
    const confirmed = window.confirm(
      `Permanently delete ${material.name}? This is only allowed when the material has never been used. If it has usage history, the app will archive it instead.`
    );
    if (!confirmed) return;
    fetcher.submit(
      { intent: "permanentDeleteMaterial", id: material.id },
      { method: "post", encType: "application/json" }
    );
  }

  function addVendor() {
    fetcher.submit(
      {
        intent: "addVendor",
        materialId: vendorMaterialId,
        vendorCenterId,
        vendorName,
        vendorSku,
        unitCost: vendorUnitCost,
        moq: vendorMoq,
        leadTimeDays: vendorLeadTimeDays,
      },
      { method: "post", encType: "application/json" }
    );

    setVendorMaterialId("");
    setVendorCenterId("");
    setVendorName("");
    setVendorSku("");
    setVendorUnitCost("");
    setVendorMoq("");
    setVendorLeadTimeDays("");
  }

  function addMaterialVariant() {
    if (!variantMaterialId || !variantName.trim()) return;
    fetcher.submit(
      {
        intent: "addMaterialVariant",
        materialId: variantMaterialId,
        variantName,
        color: variantColor,
        variantSku,
        variantStockOnHand,
        variantReorderPoint,
        variantNotes,
      },
      { method: "post", encType: "application/json" }
    );
    setVariantName("");
    setVariantColor("");
    setVariantSku("");
    setVariantStockOnHand("");
    setVariantReorderPoint("");
    setVariantNotes("");
  }

  function archiveMaterialVariant(variantId: string) {
    fetcher.submit({ intent: "archiveMaterialVariant", variantId }, { method: "post", encType: "application/json" });
  }

  function restoreMaterialVariant(variantId: string) {
    fetcher.submit({ intent: "restoreMaterialVariant", variantId }, { method: "post", encType: "application/json" });
  }

  const filteredMaterials = materials.filter((material) => {
    const isActive = material.active !== false;
    if (statusFilter === "active" && !isActive) return false;
    if (statusFilter === "inactive" && isActive) return false;

    if (filter !== "all" && normalizeType(material.materialType) !== normalizeType(filter)) return false;
    if (familyFilter !== "all" && !parseFamilies(material.productFamilies).includes(familyFilter)) return false;
    if (reviewFilter === "needs_review" && !material.costReviewNeeded) return false;
    if (reviewFilter === "reviewed" && material.costReviewNeeded) return false;
    if (recipeFilter === "recipe_only" && material.useInRecipes === false) return false;
    if (recipeFilter === "hidden_from_recipes" && material.useInRecipes !== false) return false;

    const query = search.trim().toLowerCase();
    if (query) {
      const haystack = [
        material.name,
        material.materialType,
        material.productFamilies,
        material.vendor,
        material.primaryVendor?.name,
        material.sku,
        material.notes,
        material.costReviewNeeded ? "cost review needed" : "",
        material.useInRecipes === false ? "hidden from recipes" : "recipe usable",
        ...(material.variants || []).map((variant: any) => `${variant.name} ${variant.color || ""} ${variant.sku || ""}`),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    return true;
  });

  const materialCounts = {
    total: materials.length,
    active: materials.filter((material) => material.active !== false).length,
    inactive: materials.filter((material) => material.active === false).length,
    filtered: filteredMaterials.length,
    needsReview: materials.filter((material) => material.costReviewNeeded).length,
    hiddenFromRecipes: materials.filter((material) => material.useInRecipes === false).length,
  };

  const currentUnitRule = getUnitRule(finalMaterialType);
  const currentPurchaseUnitOptions = currentUnitRule.purchaseUnits;
  const currentBaseUnitOptions = currentUnitRule.baseUnits;
  const calculatedPreview = calculateMaterialUnitCost({
    purchaseUnit,
    purchaseCost,
    baseUnit,
    rollWidthIn,
    rollLengthFt,
    volumeMl,
    caseQuantity,
  });
  const stockPreview = Number(stockOnHand) || 0;
  const availablePreview =
    purchaseUnit === "roll"
      ? stockPreview * (((Number(rollWidthIn) || 0) * (Number(rollLengthFt) || 0) * 12) / 144)
      : ["cartridge", "bottle", "pouch"].includes(purchaseUnit)
        ? stockPreview * (Number(volumeMl) || 0)
        : ["case", "box"].includes(purchaseUnit)
          ? stockPreview * (Number(caseQuantity) || 0)
          : stockPreview;

  function choosePrimaryVendor(vendorId: string) {
    setPrimaryVendorId(vendorId);
    const selectedVendor = vendors.find((v: any) => v.id === vendorId);
    if (selectedVendor) {
      setVendor(selectedVendor.name);
      if (!leadTimeDays && selectedVendor.leadTimeDays) setLeadTimeDays(String(selectedVendor.leadTimeDays));
    }
  }

  function chooseComparisonVendor(vendorId: string) {
    setVendorCenterId(vendorId);
    const selectedVendor = vendors.find((v: any) => v.id === vendorId);
    if (selectedVendor) {
      setVendorName(selectedVendor.name);
      if (!vendorLeadTimeDays && selectedVendor.leadTimeDays) setVendorLeadTimeDays(String(selectedVendor.leadTimeDays));
    }
  }

  return (
    <Page
      title="Material Center"
      subtitle="Everything you buy to make product: what it costs per unit, how much is on hand, who supplies it, and which product families use it."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{ content: "New Material", onAction: resetForm }}
    >
      {actionFeedback ? <div style={{ margin: "0 0 12px", padding: 10, borderRadius: 10, border: actionFeedbackIsError ? "1px solid #fecaca" : "1px solid #bbf7d0", background: actionFeedbackIsError ? "#fef2f2" : "#f0fdf4", fontSize: 13, fontWeight: 600 }}>{actionFeedback}</div> : null}
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                {editingId ? "Edit Material" : "Add Material"}
              </Text>

               <InlineStack gap="300">
                <NativeInput label="Material name" value={name} onChange={setName} />
                <NativeSelect label="Material type" value={materialType} onChange={setMaterialType} options={availableMaterialTypeOptions} />
                {materialType === "custom" && (
                  <NativeInput
                    label="Custom material type"
                    value={customMaterialType}
                    onChange={setCustomMaterialType}
                    helpText="Example: Foil, Specialty Film, Hang Tag. It becomes reusable after saving."
                  />
                )}
                </InlineStack>

                <InlineStack gap="300">
                <NativeSelect
                    label="Purchase / inventory unit"
                    value={purchaseUnit}
                    onChange={(value: string) => {
                      setPurchaseUnit(value);
                      if (finalMaterialType === "ink_coating" && value === "bottle" && (!volumeMl || volumeMl === "750")) setVolumeMl("1000");
                      if (finalMaterialType === "ink_coating" && ["cartridge", "pouch"].includes(value) && (!volumeMl || volumeMl === "1000")) setVolumeMl("750");
                    }}
                    options={currentPurchaseUnitOptions}
                    helpText="This is how you buy and count inventory."
                />

                <NativeInput
                    label={`Purchase cost ($ per ${purchaseUnit})`}
                    prefix="$"
                    value={purchaseCost}
                    onChange={setPurchaseCost}
                    helpText="What you pay for one purchase unit. Example: 156.99 per Roland cartridge/pouch."
                />

                <NativeSelect
                    label="Recipe / costing unit"
                    value={baseUnit}
                    onChange={setBaseUnit}
                    options={currentBaseUnitOptions}
                    helpText="This is what recipes and print logs use."
                />
                </InlineStack>

                {purchaseUnit === "roll" && (
                <InlineStack gap="300">
                    <NativeInput label="Roll width (in)" value={rollWidthIn} onChange={setRollWidthIn} suffix="in" />
                    <NativeInput label="Roll length (ft)" value={rollLengthFt} onChange={setRollLengthFt} suffix="ft" />
                </InlineStack>
                )}

                {["cartridge", "bottle", "pouch"].includes(purchaseUnit) && (
                <NativeInput
                    label={`Size (ml per ${purchaseUnit})`}
                    value={volumeMl}
                    onChange={setVolumeMl}
                    suffix="ml"
                    helpText="Roland = 750 ml. Mimaki = 1000 ml."
                />
                )}

                {(["case", "box"].includes(purchaseUnit)) && (
                <NativeInput
                    label={`Quantity in ${purchaseUnit}`}
                    value={caseQuantity}
                    onChange={setCaseQuantity}
                    helpText="Example: 1000 bags per case."
                />
                )}

                <Card>
                  <BlockStack gap="100">
                    <Text as="p" fontWeight="bold">Calculated cost preview</Text>
                    <Text as="p">{moneyPer(calculatedPreview, baseUnit)}</Text>
                    <Text as="p" tone="subdued">Stock is counted in {purchaseUnit}. Available for recipes: {Number(availablePreview || 0).toFixed(2)} {formatBaseUnitLabel(baseUnit)}.</Text>
                  </BlockStack>
                </Card>

                <InlineStack gap="300">
                <NativeSelect label="Primary vendor (Vendor Center)" value={primaryVendorId} onChange={choosePrimaryVendor} options={vendorOptions} helpText="Pick a vendor record. Its name fills the vendor name field." />
                <NativeInput label="Vendor name (only if not in Vendor Center)" value={vendor} onChange={setVendor} helpText="Free-text fallback. Ignored when a Vendor Center vendor is selected." />
                <NativeInput label="Vendor SKU / part number" value={sku} onChange={setSku} />
                </InlineStack>

                <Card>
                  <BlockStack gap="200">
                    <Text as="p" fontWeight="bold">Product families</Text>
                    <Text as="p" tone="subdued">Pick every product family this material should appear in during recipe/cost setup.</Text>
                    <InlineStack gap="200" wrap>
                      {availableFamilyOptions.filter((family) => family.value !== "custom").map((family) => (
                        <label key={family.value} style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid #ddd", borderRadius: 8, padding: "8px 10px" }}>
                          <input
                            type="checkbox"
                            checked={selectedFamilies.includes(family.value)}
                            onChange={(event) => {
                              setSelectedFamilies((current) =>
                                event.target.checked
                                  ? Array.from(new Set([...current, family.value]))
                                  : current.filter((value) => value !== family.value)
                              );
                            }}
                          />
                          <span>{family.label}</span>
                        </label>
                      ))}
                    </InlineStack>

                    <InlineStack gap="200" blockAlign="end">
                      <NativeInput label="Add custom family" value={customProductFamily} onChange={setCustomProductFamily} helpText="Example: Jars, Die Cuts, THCA Packaging." />
                      <Button
                        onClick={() => {
                          const option = makeOption(customProductFamily);
                          if (option.value) {
                            setSelectedFamilies((current) => Array.from(new Set([...current, option.value])));
                            setCustomProductFamily("");
                          }
                        }}
                      >
                        Add family
                      </Button>
                    </InlineStack>

                    {selectedFamilies.length ? (
                      <Text as="p">Selected: {selectedFamilies.map(familyLabel).join(", ")}</Text>
                    ) : (
                      <Text as="p" tone="critical">Pick at least one family before using this material in recipes.</Text>
                    )}
                  </BlockStack>
                </Card>

                <InlineStack gap="300">
                <NativeInput label={`Stock on hand (${purchaseUnit})`} value={stockOnHand} onChange={setStockOnHand} helpText="Leave blank if you do not track stock for this material." />
                <NativeInput label={`Reorder point (${purchaseUnit})`} value={reorderPoint} onChange={setReorderPoint} helpText="Low-stock warning shows when stock is at or below this." />
                <NativeInput label="Lead time (days)" value={leadTimeDays} onChange={setLeadTimeDays} helpText="Blank = use the vendor's lead time." />
                </InlineStack>

                <InlineStack gap="300">
                  <label style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #ddd", borderRadius: 8, padding: "8px 10px" }}>
                    <input type="checkbox" checked={costReviewNeeded} onChange={(event) => setCostReviewNeeded(event.currentTarget.checked)} />
                    <span>Cost needs review (flag as provisional)</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, border: "1px solid #ddd", borderRadius: 8, padding: "8px 10px" }}>
                    <input type="checkbox" checked={useInRecipes} onChange={(event) => setUseInRecipes(event.currentTarget.checked)} />
                    <span>Available in recipes</span>
                  </label>
                </InlineStack>

                <NativeInput label="Reason for cost change" value={reason} onChange={setReason} helpText="Recorded in cost history when an existing material's unit cost changes. Not needed for new materials." />
                <NativeTextarea label="Notes" value={notes} onChange={setNotes} />

                <InlineStack gap="300">
                <Button variant="primary" onClick={saveMaterial}>
                    {editingId ? "Update material" : "Save material"}
                </Button>

                <Button onClick={resetForm}>
                    Clear
                </Button>
            </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
                <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Alternate vendor pricing
              </Text>
              <Text as="p" tone="subdued">
                Record what other vendors charge for the same material so you can compare before reordering. This does not change the material's cost; use Edit on the material to change that.
              </Text>

              <Select
                label="Material"
                value={vendorMaterialId}
                onChange={setVendorMaterialId}
                options={[
                  { label: "Select material", value: "" },
                  ...materials.map((m) => ({
                    label: m.name,
                    value: m.id,
                  })),
                ]}
              />

              <InlineStack gap="300">
                <Select
                  label="Vendor (Vendor Center)"
                  value={vendorCenterId}
                  onChange={chooseComparisonVendor}
                  options={vendorOptions}
                />

                <TextField
                  label="Vendor name (only if not in Vendor Center)"
                  value={vendorName}
                  onChange={setVendorName}
                  autoComplete="off"
                />

                <TextField
                  label="Vendor SKU / part number"
                  value={vendorSku}
                  onChange={setVendorSku}
                  autoComplete="off"
                />

                <TextField
                  label="Unit cost ($ per item)"
                  prefix="$"
                  value={vendorUnitCost}
                  onChange={setVendorUnitCost}
                  autoComplete="off"
                />
              </InlineStack>

              <InlineStack gap="300">
                <TextField
                  label="Minimum order qty (MOQ)"
                  value={vendorMoq}
                  onChange={setVendorMoq}
                  autoComplete="off"
                />

                <TextField
                  label="Lead time (days)"
                  value={vendorLeadTimeDays}
                  onChange={setVendorLeadTimeDays}
                  autoComplete="off"
                />
              </InlineStack>

              <Button onClick={addVendor} disabled={!vendorMaterialId || !vendorName.trim()}>
                Add alternate vendor price
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>
                <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Color variants / aliases</Text>
              <Text as="p" tone="subdued">Use variants for colors, aliases, or sub-stock under one material, like 4x5 blank bag colors. The parent material keeps the cost; variants only track their own stock.</Text>
              <NativeSelect
                label="Parent material"
                value={variantMaterialId}
                onChange={setVariantMaterialId}
                options={[{ label: "Select material", value: "" }, ...materials.map((m) => ({ label: m.name, value: m.id }))]}
              />
              <InlineStack gap="300">
                <NativeInput label="Variant / alias name" value={variantName} onChange={setVariantName} helpText="Example: Black, Clear, White, Gold, Mixed Colors." />
                <NativeInput label="Color" value={variantColor} onChange={setVariantColor} />
                <NativeInput label="Variant SKU" value={variantSku} onChange={setVariantSku} />
              </InlineStack>
              <InlineStack gap="300">
                <NativeInput label="Variant stock (count)" value={variantStockOnHand} onChange={setVariantStockOnHand} helpText="Optional. Leave blank if you only track parent stock." />
                <NativeInput label="Variant reorder point" value={variantReorderPoint} onChange={setVariantReorderPoint} />
              </InlineStack>
              <NativeTextarea label="Variant notes" value={variantNotes} onChange={setVariantNotes} />
              <Button onClick={addMaterialVariant} disabled={!variantMaterialId || !variantName.trim()}>Add variant / alias</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <BlockStack gap="050">
                  <Text as="h2" variant="headingMd">
                    Materials
                  </Text>
                  <Text as="p" tone="subdued">
                    Showing {materialCounts.filtered} of {materialCounts.total}. Active: {materialCounts.active}. Inactive: {materialCounts.inactive}. Needs review: {materialCounts.needsReview}. Hidden from recipes: {materialCounts.hiddenFromRecipes}.
                  </Text>
                </BlockStack>
              </InlineStack>

              <InlineStack gap="300" align="start">
                <NativeInput label="Search materials" value={search} onChange={setSearch} helpText="Search name, vendor, SKU, notes." />
                <NativeSelect
                  label="Status"
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { label: "Active only", value: "active" },
                    { label: "Inactive only", value: "inactive" },
                    { label: "All active + inactive", value: "all" },
                  ]}
                />
                <NativeSelect
                  label="Material type"
                  value={filter}
                  onChange={setFilter}
                  options={[{ label: "All types", value: "all" }, ...availableMaterialTypeOptions.filter((option) => option.value !== "custom")]}
                />
                <NativeSelect
                  label="Product family"
                  value={familyFilter}
                  onChange={setFamilyFilter}
                  options={[{ label: "All families", value: "all" }, ...availableFamilyOptions.filter((option) => option.value !== "custom")]}
                />
                <NativeSelect
                  label="Cost review"
                  value={reviewFilter}
                  onChange={setReviewFilter}
                  options={[
                    { label: "All review statuses", value: "all" },
                    { label: "Needs cost review", value: "needs_review" },
                    { label: "Reviewed", value: "reviewed" },
                  ]}
                />
                <NativeSelect
                  label="Recipe visibility"
                  value={recipeFilter}
                  onChange={setRecipeFilter}
                  options={[
                    { label: "All", value: "all" },
                    { label: "Use in recipes", value: "recipe_only" },
                    { label: "Hidden from recipes", value: "hidden_from_recipes" },
                  ]}
                />
              </InlineStack>

              <InlineStack gap="200">
                <Button onClick={() => { setSearch(""); setFilter("all"); setFamilyFilter("all"); setStatusFilter("active"); setReviewFilter("all"); setRecipeFilter("all"); }}>
                  Reset filters
                </Button>
                <Button onClick={() => setStatusFilter("inactive")}>
                  Review inactive
                </Button>
              </InlineStack>

              <Divider />

              {filteredMaterials.length === 0 ? (
                materials.length === 0 ? (
                  <BlockStack gap="100">
                    <Text as="p" fontWeight="bold">No materials yet.</Text>
                    <Text as="p" tone="subdued">
                      Add your first material with the form above. Start with the things you buy most: roll media, ink, blank bags, and boxes.
                    </Text>
                  </BlockStack>
                ) : (
                  <BlockStack gap="100">
                    <Text as="p" fontWeight="bold">No materials match these filters.</Text>
                    <Text as="p" tone="subdued">
                      {materialCounts.total} material(s) exist ({materialCounts.active} active, {materialCounts.inactive} inactive). Use Reset filters to see them all.
                    </Text>
                  </BlockStack>
                )
              ) : (
                filteredMaterials.map((material) => {
                  const lowStock =
                    material.stockOnHand !== null &&
                    material.reorderPoint !== null &&
                    Number(material.stockOnHand) <=
                      Number(material.reorderPoint);
                  const unitCost = Number(material.calculatedUnitCost || material.costPerUnit || 0);
                  const costUnit = material.baseUnit || material.unit || "each";
                  const vendorDisplay = material.primaryVendor?.name || material.vendor || "";
                  const stockRecorded = material.stockOnHand !== null && material.stockOnHand !== undefined;
                  const alternateVendors = (material.vendors || []).filter((row: any) => row.active !== false);
                  const costHistory = material.costHistory || [];

                  return (
                    <Card key={material.id}>
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <Text as="p" fontWeight="bold">
                            {material.name}
                          </Text>

                          <InlineStack gap="200" wrap>
                            <Badge>
                              {materialTypeLabel(material.materialType)}
                            </Badge>

                            {parseFamilies(material.productFamilies).map((family: string) => (
                              <Badge key={family}>{familyLabel(family)}</Badge>
                            ))}

                            {unitCost <= 0 && <Badge tone="critical">Cost missing</Badge>}
                            {unitCost > 0 && material.costReviewNeeded && <Badge tone="warning">Cost needs review</Badge>}
                            {!vendorDisplay && <Badge tone="critical">Vendor not set</Badge>}
                            {material.useInRecipes === false && <Badge tone="info">Hidden from recipes</Badge>}
                            {material.active === false && <Badge>Inactive</Badge>}
                            {lowStock && <Badge tone="critical">Low stock</Badge>}
                          </InlineStack>
                        </InlineStack>

                        <Text as="p">
                          Cost: {moneyPer(unitCost, costUnit)}
                          {" | Purchase: "}
                          ${Number(material.purchaseCost || 0).toFixed(2)} per {material.purchaseUnit || "each"}
                        </Text>

                        <Text as="p">
                          {stockRecorded
                            ? `Stock: ${Number(material.stockOnHand || 0).toFixed(2)} ${material.purchaseUnit || "each"} | Available for recipes: ${Number(calculateAvailableUnits(material) || 0).toFixed(2)} ${formatBaseUnitLabel(costUnit)}`
                            : "Stock: not recorded"}
                          {material.reorderPoint !== null && material.reorderPoint !== undefined ? ` | Reorder at: ${Number(material.reorderPoint).toFixed(2)} ${material.purchaseUnit || "each"}` : ""}
                        </Text>

                        <Text as="p">
                          Vendor: {vendorDisplay || "not set"}
                          {material.sku ? ` | SKU: ${material.sku}` : ""}
                          {material.leadTimeDays ? ` | Lead time: ${material.leadTimeDays} day(s)` : " | Lead time: not set"}
                        </Text>

                        {material.notes ? <Text as="p" tone="subdued">{material.notes}</Text> : null}

                        {alternateVendors.length ? (
                          <Card>
                            <BlockStack gap="150">
                              <Text as="p" fontWeight="bold">Alternate vendor prices</Text>
                              {alternateVendors.map((row: any) => (
                                <Text as="p" key={row.id}>
                                  {row.vendorName}{row.vendorSku ? ` · SKU ${row.vendorSku}` : ""} · {moneyPer(row.unitCost, row.unit || "each", 4)}
                                  {row.moq ? ` · MOQ ${row.moq}` : ""}{row.leadTimeDays ? ` · ${row.leadTimeDays} day lead` : ""}
                                </Text>
                              ))}
                            </BlockStack>
                          </Card>
                        ) : null}

                        {(material.variants || []).length ? (
                          <Card>
                            <BlockStack gap="150">
                              <Text as="p" fontWeight="bold">Variants / aliases</Text>
                              {(material.variants || []).map((variant: any) => (
                                <InlineStack key={variant.id} align="space-between" blockAlign="center">
                                  <Text as="p">
                                    {variant.name}{variant.color ? ` · ${variant.color}` : ""}{variant.sku ? ` · ${variant.sku}` : ""}
                                    {variant.stockOnHand !== null && variant.stockOnHand !== undefined ? ` · Stock ${variant.stockOnHand}` : ""}
                                    {variant.active === false ? " · inactive" : ""}
                                  </Text>
                                  {variant.active === false ? (
                                    <Button onClick={() => restoreMaterialVariant(variant.id)}>Restore variant</Button>
                                  ) : (
                                    <Button tone="critical" onClick={() => archiveMaterialVariant(variant.id)}>Archive variant (hide, keeps history)</Button>
                                  )}
                                </InlineStack>
                              ))}
                            </BlockStack>
                          </Card>
                        ) : null}

                        {costHistory.length ? (
                          <details>
                            <summary style={{ cursor: "pointer", fontSize: 12, color: "#6d7175" }}>Cost history (last {costHistory.length})</summary>
                            <BlockStack gap="050">
                              {costHistory.map((entry: any) => (
                                <Text as="p" key={entry.id} tone="subdued">
                                  {formatDate(entry.createdAt)}: {moneyPer(entry.oldCost, costUnit)} to {moneyPer(entry.newCost, costUnit)}
                                  {entry.reason ? ` — ${entry.reason}` : ""}{entry.vendor ? ` (${entry.vendor})` : ""}
                                </Text>
                              ))}
                            </BlockStack>
                          </details>
                        ) : null}

                        <InlineStack gap="200">
                          <Button onClick={() => editMaterial(material)}>
                            Edit
                          </Button>

                          {material.active === false ? (
                            <Button onClick={() => restoreMaterial(material.id)}>
                              Restore
                            </Button>
                          ) : (
                            <Button tone="critical" onClick={() => archiveMaterial(material.id)}>
                              Archive (hide, keeps history)
                            </Button>
                          )}

                          <Button tone="critical" onClick={() => permanentDeleteMaterial(material)}>
                            Delete permanently
                          </Button>
                        </InlineStack>
                      </BlockStack>
                    </Card>
                  );
                })
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}