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

const materialTypes = [
  { label: "Label", value: "label" },
  { label: "DTP", value: "dtp" },
  { label: "Box", value: "box" },
  { label: "Die Cut", value: "die_cut" },
  { label: "Ink", value: "ink" },
  { label: "Laminate", value: "laminate" },
  { label: "Labor", value: "labor" },
  { label: "Machine", value: "machine" },
  { label: "Shipping", value: "shipping" },
  { label: "General", value: "general" },
];

const canonicalMaterialTypes = [
  { label: "All types", value: "all" },
  ...materialTypes,
  { label: "Roll Media", value: "roll_media" },
  { label: "Ink / Coating", value: "ink_coating" },
  { label: "Blanks / Bags", value: "blanks" },
  { label: "Outsourced", value: "outsourced" },
];

function normalizeType(value: string | null | undefined) {
  const type = String(value || "general").toLowerCase().trim().replace(/\s+/g, "_").replace(/-/g, "_");
  if (["ink", "ink_coating", "coating", "gloss", "white_ink", "cmyk_ink"].includes(type)) return "ink";
  if (["label", "labels", "roll_media", "roll", "media", "vinyl", "sticker", "stickers"].includes(type)) return "label";
  if (["laminate", "lamination", "lam"].includes(type)) return "laminate";
  if (["dtp", "bag", "bags", "blank", "blanks", "blank_bag", "blanks_bags", "pouch", "pouches", "stock_bag", "sticker_bag"].includes(type)) return "dtp";
  if (["box", "boxes", "carton"].includes(type)) return "box";
  if (["die_cut", "diecut", "die_cut_bag", "diecut_bag"].includes(type)) return "die_cut";
  if (["labor", "service", "design", "prepress"].includes(type)) return "labor";
  if (["machine", "equipment"].includes(type)) return "machine";
  if (["shipping", "freight", "packing", "packaging_supplies"].includes(type)) return "shipping";
  if (["outsourced", "sourced", "vendor", "vendor_product"].includes(type)) return "outsourced";
  return type || "general";
}

function materialTypeLabel(value: string | null | undefined) {
  const normalized = normalizeType(value);
  const match = [...materialTypes, { label: "Outsourced", value: "outsourced" }].find((option) => option.value === normalized);
  return match?.label || String(value || "General");
}


const smartUnitRules: Record<string, { purchaseUnits: { label: string; value: string }[]; baseUnits: { label: string; value: string }[]; defaultPurchaseUnit: string; defaultBaseUnit: string; defaultVolumeMl?: string }> = {
  ink: {
    purchaseUnits: [
      { label: "Cartridge / pouch", value: "cartridge" },
      { label: "Bottle", value: "bottle" },
      { label: "Pouch", value: "pouch" },
    ],
    baseUnits: [{ label: "ML", value: "ml" }],
    defaultPurchaseUnit: "cartridge",
    defaultBaseUnit: "ml",
    defaultVolumeMl: "750",
  },
  label: {
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
  dtp: {
    purchaseUnits: [
      { label: "Case", value: "case" },
      { label: "Box", value: "box" },
      { label: "Each", value: "each" },
    ],
    baseUnits: [{ label: "Each", value: "each" }],
    defaultPurchaseUnit: "case",
    defaultBaseUnit: "each",
  },
  box: {
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
  shipping: {
    purchaseUnits: [
      { label: "Each", value: "each" },
      { label: "Box", value: "box" },
      { label: "Case", value: "case" },
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
      { label: "ML", value: "ml" },
      { label: "Hour", value: "hour" },
    ],
    defaultPurchaseUnit: "each",
    defaultBaseUnit: "each",
  },
};

function getUnitRule(materialType: string) {
  return smartUnitRules[materialType] || smartUnitRules.general;
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
    },
  }),
    db.vendor.findMany({
      where: { shop: session.shop, active: true },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      include: { contacts: { where: { active: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] } },
    }),
  ]);

  return Response.json({ materials, vendors });
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

const calculatedUnitCost = calculateMaterialUnitCost(payload);

    let material;

    if (payload.id) {
      material = await db.material.update({
        where: { id: payload.id },
        data: {
          name: payload.name,
          materialType: payload.materialType,
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
          materialType: payload.materialType,
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
      },
    });

    return Response.json({ ok: true, materials });
  }

  if (payload.intent === "deleteMaterial" || payload.intent === "archiveMaterial") {
    await db.material.update({
      where: { id: payload.id },
      data: { active: false },
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
      },
    });

    return Response.json({ ok: true, materials, message: "Material archived." });
  }

  if (payload.intent === "restoreMaterial") {
    await db.material.update({
      where: { id: payload.id },
      data: { active: true },
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
      await db.material.update({ where: { id: payload.id }, data: { active: false } });
      const materials = await db.material.findMany({
        where: { shop },
        orderBy: { updatedAt: "desc" },
        include: { primaryVendor: true, vendors: true, costHistory: { orderBy: { createdAt: "desc" }, take: 5 } },
      });
      return Response.json({ ok: false, materials, error: "This material is used by recipes, production, inventory, purchase requests, or cost book records, so it was archived instead of permanently deleted." });
    }

    await db.material.delete({ where: { id: payload.id } });

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
      },
    });

    return Response.json({ ok: true, materials, message: "Material permanently deleted." });
  }

  if (payload.intent === "addVendor") {
    await db.materialVendor.create({
      data: {
        shop,
        materialId: payload.materialId,
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
  const vendorOptions = [
    { label: "Manual / no Vendor Center link", value: "" },
    ...vendors.map((vendor: any) => ({
      label: `${vendor.name}${vendor.status ? ` (${vendor.status})` : ""}`,
      value: vendor.id,
    })),
  ];
  const [editingId, setEditingId] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [materialType, setMaterialType] = useState("label");
  const [vendor, setVendor] = useState("");
  const [primaryVendorId, setPrimaryVendorId] = useState("");
  const [sku, setSku] = useState("");
  const [stockOnHand, setStockOnHand] = useState("");
  const [reorderPoint, setReorderPoint] = useState("");
  const [leadTimeDays, setLeadTimeDays] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [purchaseUnit, setPurchaseUnit] = useState("each");
  const [purchaseCost, setPurchaseCost] = useState("");
  const [baseUnit, setBaseUnit] = useState("each");
  const [rollWidthIn, setRollWidthIn] = useState("");
  const [rollLengthFt, setRollLengthFt] = useState("");
  const [volumeMl, setVolumeMl] = useState("");
  const [caseQuantity, setCaseQuantity] = useState("");
  const [filter, setFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [vendorMaterialId, setVendorMaterialId] = useState("");
  const [vendorCenterId, setVendorCenterId] = useState("");
  const [vendorName, setVendorName] = useState("");
  const [vendorSku, setVendorSku] = useState("");
  const [vendorUnitCost, setVendorUnitCost] = useState("");
  const [vendorMoq, setVendorMoq] = useState("");
  const [vendorLeadTimeDays, setVendorLeadTimeDays] = useState("");

  useEffect(() => {
    if (fetcher.data?.materials) setMaterials(fetcher.data.materials);
  }, [fetcher.data]);

  useEffect(() => {
    const rule = getUnitRule(materialType);
    if (!rule.purchaseUnits.some((option) => option.value === purchaseUnit)) {
      setPurchaseUnit(rule.defaultPurchaseUnit);
    }
    if (!rule.baseUnits.some((option) => option.value === baseUnit)) {
      setBaseUnit(rule.defaultBaseUnit);
    }
    if (materialType === "ink" && !volumeMl && rule.defaultVolumeMl) {
      setVolumeMl(rule.defaultVolumeMl);
    }
  }, [materialType]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setMaterialType("label");
    setVendor("");
    setPrimaryVendorId("");
    setSku("");
    setStockOnHand("");
    setReorderPoint("");
    setLeadTimeDays("");
    setReason("");
    setNotes("");
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
        materialType,
        vendor,
        primaryVendorId,
        sku,
        stockOnHand,
        reorderPoint,
        leadTimeDays,
        reason,
        notes,
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
    setMaterialType(material.materialType || "label");
    setVendor(material.vendor || material.primaryVendor?.name || "");
    setPrimaryVendorId(material.primaryVendorId || material.primaryVendor?.id || "");
    setSku(material.sku || "");
    setStockOnHand(material.stockOnHand ? String(material.stockOnHand) : "");
    setReorderPoint(material.reorderPoint ? String(material.reorderPoint) : "");
    setLeadTimeDays(material.leadTimeDays ? String(material.leadTimeDays) : "");
    setReason("");
    setNotes(material.notes || "");
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

  const filteredMaterials = materials.filter((material) => {
    const isActive = material.active !== false;
    if (statusFilter === "active" && !isActive) return false;
    if (statusFilter === "inactive" && isActive) return false;

    if (filter !== "all" && normalizeType(material.materialType) !== normalizeType(filter)) return false;

    const query = search.trim().toLowerCase();
    if (query) {
      const haystack = [
        material.name,
        material.materialType,
        material.vendor,
        material.primaryVendor?.name,
        material.sku,
        material.notes,
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
  };

  const currentUnitRule = getUnitRule(materialType);
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
      subtitle="Advanced material costs, inventory, vendors, and cost history."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{ content: "New Material", onAction: resetForm }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                {editingId ? "Edit Material" : "Add Material"}
              </Text>

               <InlineStack gap="300">
                <NativeInput label="Material Name" value={name} onChange={setName} />
                <NativeSelect label="Material Type" value={materialType} onChange={setMaterialType} options={materialTypes} />
                </InlineStack>

                <InlineStack gap="300">
                <NativeSelect
                    label="Purchase / Inventory Unit"
                    value={purchaseUnit}
                    onChange={(value: string) => {
                      setPurchaseUnit(value);
                      if (materialType === "ink" && value === "bottle" && (!volumeMl || volumeMl === "750")) setVolumeMl("1000");
                      if (materialType === "ink" && ["cartridge", "pouch"].includes(value) && (!volumeMl || volumeMl === "1000")) setVolumeMl("750");
                    }}
                    options={currentPurchaseUnitOptions}
                    helpText="This is how you buy and count inventory."
                />

                <NativeInput
                    label={`Purchase Cost / ${purchaseUnit}`}
                    prefix="$"
                    value={purchaseCost}
                    onChange={setPurchaseCost}
                    helpText="Example: 156.99 per Roland cartridge/pouch."
                />

                <NativeSelect
                    label="Recipe / Costing Unit"
                    value={baseUnit}
                    onChange={setBaseUnit}
                    options={currentBaseUnitOptions}
                    helpText="This is what recipes and print logs use."
                />
                </InlineStack>

                {purchaseUnit === "roll" && (
                <InlineStack gap="300">
                    <NativeInput label="Roll Width Inches" value={rollWidthIn} onChange={setRollWidthIn} />
                    <NativeInput label="Roll Length Feet" value={rollLengthFt} onChange={setRollLengthFt} />
                </InlineStack>
                )}

                {["cartridge", "bottle", "pouch"].includes(purchaseUnit) && (
                <NativeInput
                    label={`ML per ${purchaseUnit}`}
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
                    <Text as="p">${Number(calculatedPreview || 0).toFixed(6)} / {formatBaseUnitLabel(baseUnit)}</Text>
                    <Text as="p" tone="subdued">Stock is counted in {purchaseUnit}. Available recipe units: {Number(availablePreview || 0).toFixed(2)} {formatBaseUnitLabel(baseUnit)}.</Text>
                  </BlockStack>
                </Card>

                <InlineStack gap="300">
                <NativeSelect label="Primary Vendor" value={primaryVendorId} onChange={choosePrimaryVendor} options={vendorOptions} />
                <NativeInput label="Vendor Text / Fallback" value={vendor} onChange={setVendor} />
                <NativeInput label="Vendor / Material SKU" value={sku} onChange={setSku} />
                </InlineStack>

                <InlineStack gap="300">
                <NativeInput label={`Stock On Hand (${purchaseUnit})`} value={stockOnHand} onChange={setStockOnHand} />
                <NativeInput label={`Reorder Point (${purchaseUnit})`} value={reorderPoint} onChange={setReorderPoint} />
                <NativeInput label="Lead Time Days" value={leadTimeDays} onChange={setLeadTimeDays} />
                </InlineStack>

                <NativeInput label="Reason For Cost Change" value={reason} onChange={setReason} />
                <NativeTextarea label="Notes" value={notes} onChange={setNotes} />

                <InlineStack gap="300">
                <Button variant="primary" onClick={saveMaterial}>
                    {editingId ? "Update Material" : "Save Material"}
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
                Vendor Comparison
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
                  label="Vendor Center Vendor"
                  value={vendorCenterId}
                  onChange={chooseComparisonVendor}
                  options={vendorOptions}
                />

                <TextField
                  label="Vendor Name / Fallback"
                  value={vendorName}
                  onChange={setVendorName}
                  autoComplete="off"
                />

                <TextField
                  label="Vendor SKU"
                  value={vendorSku}
                  onChange={setVendorSku}
                  autoComplete="off"
                />

                <TextField
                  label="Unit Cost"
                  prefix="$"
                  value={vendorUnitCost}
                  onChange={setVendorUnitCost}
                  autoComplete="off"
                />
              </InlineStack>

              <InlineStack gap="300">
                <TextField
                  label="MOQ"
                  value={vendorMoq}
                  onChange={setVendorMoq}
                  autoComplete="off"
                />

                <TextField
                  label="Lead Time Days"
                  value={vendorLeadTimeDays}
                  onChange={setVendorLeadTimeDays}
                  autoComplete="off"
                />
              </InlineStack>

              <Button onClick={addVendor}>
                Add Vendor Option
              </Button>
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
                    Showing {materialCounts.filtered} of {materialCounts.total}. Active: {materialCounts.active}. Inactive: {materialCounts.inactive}.
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
                  options={canonicalMaterialTypes}
                />
              </InlineStack>

              <InlineStack gap="200">
                <Button onClick={() => { setSearch(""); setFilter("all"); setStatusFilter("active"); }}>
                  Reset filters
                </Button>
                <Button onClick={() => setStatusFilter("inactive")}>
                  Review inactive
                </Button>
              </InlineStack>

              <Divider />

              {filteredMaterials.length === 0 ? (
                <Text as="p" tone="subdued">
                  No materials yet.
                </Text>
              ) : (
                filteredMaterials.map((material) => {
                  const lowStock =
                    material.stockOnHand !== null &&
                    material.reorderPoint !== null &&
                    Number(material.stockOnHand) <=
                      Number(material.reorderPoint);

                  return (
                    <Card key={material.id}>
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <Text as="p" fontWeight="bold">
                            {material.name}
                          </Text>

                          <InlineStack gap="200">
                            <Badge>
                              {materialTypeLabel(material.materialType)}
                            </Badge>

                            {material.active === false && (
                              <Badge tone="warning">
                                INACTIVE
                              </Badge>
                            )}

                            {lowStock && (
                              <Badge tone="critical">
                                LOW STOCK
                              </Badge>
                            )}
                          </InlineStack>
                        </InlineStack>

                        <Text as="p">
                          Cost: $
                          {Number(
                            material.calculatedUnitCost ||
                              material.costPerUnit ||
                              0
                          ).toFixed(6)}{" "}
                          / {material.baseUnit || material.unit}
                        </Text>

                        <Text as="p">
                          Purchase: ${Number(material.purchaseCost || 0).toFixed(2)} / {material.purchaseUnit || "each"}
                        </Text>

                        <Text as="p">
                          Stock: {Number(material.stockOnHand || 0).toFixed(2)} {material.purchaseUnit || "each"}
                          {" | Available: "}
                          {Number(calculateAvailableUnits(material) || 0).toFixed(2)} {formatBaseUnitLabel(material.baseUnit || material.unit)}
                        </Text>

                        <Text as="p">
                          Vendor: {material.vendor || "N/A"}
                        </Text>

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
                              Archive
                            </Button>
                          )}

                          <Button tone="critical" onClick={() => permanentDeleteMaterial(material)}>
                            Delete Forever
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