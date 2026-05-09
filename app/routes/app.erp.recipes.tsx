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
import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const productTypeDefaults: Record<
  string,
  {
    label: string;
    minQuantity: number;
    defaultQuantity: number;
    tiers: number[];
    targetMarginPct: number;
  }
> = {
  label: {
    label: "Labels",
    minQuantity: 64,
    defaultQuantity: 64,
    tiers: [64, 100, 250, 500, 1000, 2500, 5000],
    targetMarginPct: 50,
  },
  box: {
    label: "Boxes",
    minQuantity: 5,
    defaultQuantity: 5,
    tiers: [5, 10, 25, 50, 100, 250, 500],
    targetMarginPct: 50,
  },
  dtp_bag: {
    label: "DTP Bags",
    minQuantity: 100,
    defaultQuantity: 100,
    tiers: [100, 250, 500, 1000, 2000, 5000, 10000],
    targetMarginPct: 45,
  },
  die_cut_bag: {
    label: "Die Cut Bags",
    minQuantity: 500,
    defaultQuantity: 500,
    tiers: [500, 1000, 2500, 5000, 10000],
    targetMarginPct: 45,
  },
  sourced_product: {
    label: "Sourced Products",
    minQuantity: 1,
    defaultQuantity: 1,
    tiers: [1, 10, 25, 50, 100, 250, 500],
    targetMarginPct: 40,
  },
  general: {
    label: "General",
    minQuantity: 1,
    defaultQuantity: 1,
    tiers: [1, 10, 25, 50, 100],
    targetMarginPct: 40,
  },
};

const productTypes = Object.entries(productTypeDefaults).map(([value, config]) => ({
  label: config.label,
  value,
}));

const statusOptions = [
  { label: "Active", value: "active" },
  { label: "Archived", value: "archived" },
  { label: "All", value: "all" },
];

const emptyOption = { label: "None", value: "" };

type LabelFinishPreset = {
  key: string;
  label: string;
  whiteLayers: number;
  glossLayers: number;
  sqftPerHour: number;
  preferredMachine: string;
  description: string;
};

const labelFinishPresets: LabelFinishPreset[] = [
  {
    key: "base",
    label: "Base Print",
    whiteLayers: 0,
    glossLayers: 0,
    sqftPerHour: 150,
    preferredMachine: "Mimaki or Roland",
    description: "CMYK only.",
  },
  {
    key: "white",
    label: "White",
    whiteLayers: 1,
    glossLayers: 0,
    sqftPerHour: 70,
    preferredMachine: "Mimaki or Roland",
    description: "CMYK plus 1 white layer.",
  },
  {
    key: "gloss",
    label: "Gloss",
    whiteLayers: 0,
    glossLayers: 1,
    sqftPerHour: 60,
    preferredMachine: "Roland LG-540",
    description: "CMYK plus 1 gloss layer.",
  },
  {
    key: "white_gloss",
    label: "White + Gloss",
    whiteLayers: 1,
    glossLayers: 1,
    sqftPerHour: 45,
    preferredMachine: "Roland LG-540",
    description: "CMYK, 1 white layer, and 1 gloss layer.",
  },
  {
    key: "emboss",
    label: "Emboss",
    whiteLayers: 0,
    glossLayers: 2,
    sqftPerHour: 35,
    preferredMachine: "Roland LG-540",
    description: "CMYK plus 2 stacked gloss layers for raised feel.",
  },
  {
    key: "white_emboss",
    label: "White + Emboss",
    whiteLayers: 1,
    glossLayers: 2,
    sqftPerHour: 30,
    preferredMachine: "Roland LG-540",
    description: "CMYK, 1 white layer, and 2 stacked gloss layers.",
  },
  {
    key: "emboss_3x",
    label: "3x Emboss",
    whiteLayers: 0,
    glossLayers: 3,
    sqftPerHour: 25,
    preferredMachine: "Roland LG-540",
    description: "CMYK plus 3 stacked gloss layers for braille-style raised feel.",
  },
  {
    key: "white_emboss_3x",
    label: "White + 3x Emboss",
    whiteLayers: 1,
    glossLayers: 3,
    sqftPerHour: 20,
    preferredMachine: "Roland LG-540",
    description: "CMYK, 1 white layer, and 3 stacked gloss layers.",
  },
];

function defaultForProductType(productType: string) {
  return productTypeDefaults[productType] || productTypeDefaults.general;
}

function numberOrZero(value: any) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function nullableNumber(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function positiveInt(value: any, fallback: number) {
  const numberValue = Math.round(Number(value));
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
}

function parseTierBreakpoints(value: any) {
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
  }

  return String(value || "")
    .split(/[\n,]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function normalizeTierBreakpoints(value: any, minQuantity: number) {
  const unique = new Set<number>([minQuantity]);
  for (const qty of parseTierBreakpoints(value)) {
    if (qty >= minQuantity) unique.add(Math.round(qty));
  }
  return Array.from(unique).sort((a, b) => a - b);
}

function money(value: number) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(4)}`;
}

function dollars(value: number) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(2)}`;
}

function percent(value: number) {
  if (!Number.isFinite(value)) return "0.00%";
  return `${value.toFixed(2)}%`;
}

function materialUnitCost(material: any) {
  return numberOrZero(material?.calculatedUnitCost || material?.costPerUnit);
}

function normalizedInkType(value: any) {
  return String(value || "").trim().toLowerCase();
}

function machineInkCost(
  machine: any,
  inkType: string,
  totalSqft: number,
  coveragePercent: number,
  inkAllowancePct: number,
) {
  if (!machine || !coveragePercent || coveragePercent <= 0) return 0;

  const targetInkType = normalizedInkType(inkType);
  const channels = (machine.inkChannels || []).filter(
    (channel: any) => channel.enabled !== false && normalizedInkType(channel.inkType) === targetInkType,
  );

  const rawInkCost = channels.reduce((sum: number, channel: any) => {
    const costPerMl = numberOrZero(channel.costPerMl);
    const mlPerSqft1Pct = numberOrZero(channel.mlPerSqft1Pct || channel.mlPerSqft100 / 100);
    return sum + totalSqft * coveragePercent * mlPerSqft1Pct * costPerMl;
  }, 0);

  return rawInkCost * (1 + numberOrZero(inkAllowancePct) / 100);
}

function machineSpeedForFinish(machine: any, finish: LabelFinishPreset) {
  const machineDefaultSpeed = numberOrZero(machine?.sqftPerHour);
  if (finish.key === "base" && machineDefaultSpeed > 0) return machineDefaultSpeed;
  return finish.sqftPerHour;
}

function calcLabelFinish(input: any, finish: LabelFinishPreset, quantityOverride?: number) {
  const widthIn = numberOrZero(input.widthIn);
  const heightIn = numberOrZero(input.heightIn);
  const minQuantity = positiveInt(input.minQuantity, 1);
  const quantity = Math.max(minQuantity, positiveInt(quantityOverride ?? input.quantity, minQuantity));
  const wastePct = numberOrZero(input.wastePct);
  const targetMarginPct = numberOrZero(input.targetMarginPct);
  const setupCost = numberOrZero(input.setupCost);
  const fixedLaborMinutes = numberOrZero(input.laborMinutes);
  const laborRate = numberOrZero(input.laborRate || 25);
  const operatorLaborPct = numberOrZero(input.operatorLaborPct || 25);
  const inkAllowancePct = numberOrZero(input.inkAllowancePct || 15);
  const maintenanceCostPerSqft = numberOrZero(input.maintenanceCostPerSqft || 0.08);
  const machineRecoveryCostPerSqft = numberOrZero(input.machineRecoveryCostPerSqft || 0.05);
  const overheadCostPerSqft = numberOrZero(input.overheadCostPerSqft || 0);
  const media = input.mediaMaterial;
  const laminate = input.laminateMaterial;
  const machine = input.machine;

  const sqinPerLabel = widthIn * heightIn;
  const sqftPerLabel = sqinPerLabel / 144;
  const totalSqftBeforeWaste = sqftPerLabel * quantity;
  const wasteMultiplier = 1 + wastePct / 100;
  const totalSqft = totalSqftBeforeWaste * wasteMultiplier;

  const mediaCost = totalSqft * materialUnitCost(media);
  const laminateCost = laminate ? totalSqft * materialUnitCost(laminate) : 0;

  const cmykInkCost = machineInkCost(machine, "cmyk", totalSqft, numberOrZero(input.cmykCoveragePct), inkAllowancePct);
  const whiteInkCost = finish.whiteLayers > 0 ? machineInkCost(machine, "white", totalSqft, 100 * finish.whiteLayers, inkAllowancePct) : 0;
  const glossInkCost = finish.glossLayers > 0 ? machineInkCost(machine, "gloss", totalSqft, 100 * finish.glossLayers, inkAllowancePct) : 0;
  const inkCost = cmykInkCost + whiteInkCost + glossInkCost;

  const sqftPerHour = machineSpeedForFinish(machine, finish);
  const machineCostPerHour = numberOrZero(machine?.costPerHour);
  const machineHours = sqftPerHour > 0 ? totalSqft / sqftPerHour : 0;
  const machineHourlyCost = machineHours * machineCostPerHour;
  const machineRecoveryCost = totalSqft * machineRecoveryCostPerSqft;
  const maintenanceCost = totalSqft * maintenanceCostPerSqft;
  const overheadCost = totalSqft * overheadCostPerSqft;

  const fixedLaborCost = (fixedLaborMinutes / 60) * laborRate;
  const runLaborCost = machineHours * laborRate * (operatorLaborPct / 100);
  const laborCost = fixedLaborCost + runLaborCost;

  const totalCost =
    mediaCost +
    laminateCost +
    inkCost +
    machineHourlyCost +
    machineRecoveryCost +
    maintenanceCost +
    overheadCost +
    laborCost +
    setupCost;
  const unitCost = quantity > 0 ? totalCost / quantity : 0;
  const marginDecimal = Math.min(0.95, Math.max(0, targetMarginPct / 100));
  const recommendedUnitPrice = marginDecimal >= 0.95 ? unitCost : unitCost / (1 - marginDecimal);
  const totalSellPrice = recommendedUnitPrice * quantity;
  const grossProfit = totalSellPrice - totalCost;
  const actualMarginPct = totalSellPrice > 0 ? (grossProfit / totalSellPrice) * 100 : 0;

  return {
    finish,
    quantity,
    sqinPerLabel,
    sqftPerLabel,
    totalSqftBeforeWaste,
    totalSqft,
    mediaCost,
    laminateCost,
    cmykInkCost,
    whiteInkCost,
    glossInkCost,
    inkCost,
    sqftPerHour,
    machineHours,
    machineHourlyCost,
    machineRecoveryCost,
    maintenanceCost,
    overheadCost,
    fixedLaborCost,
    runLaborCost,
    laborCost,
    setupCost,
    totalCost,
    unitCost,
    recommendedUnitPrice,
    totalSellPrice,
    grossProfit,
    actualMarginPct,
  };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [recipes, materials, machines] = await Promise.all([
    db.productRecipe.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      include: {
        materials: { include: { material: true } },
        inkRequirements: true,
        machineRules: { include: { preferredMachine: { include: { inkChannels: true } } } },
        tiers: { orderBy: { minQty: "asc" } },
      },
    }),
    db.material.findMany({
      where: { shop, active: true },
      orderBy: { name: "asc" },
    }),
    db.machine.findMany({
      where: { shop, active: true },
      orderBy: { name: "asc" },
      include: { inkChannels: { orderBy: { slotNumber: "asc" } } },
    }),
  ]);

  return Response.json({ recipes, materials, machines });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const payload = await request.json();

  if (payload.intent === "saveRecipe") {
    const productType = payload.productType || "label";
    const productDefault = defaultForProductType(productType);
    const minQuantity = positiveInt(payload.minQuantity, productDefault.minQuantity);
    const defaultQuantity = Math.max(minQuantity, positiveInt(payload.defaultQuantity, productDefault.defaultQuantity));
    const tierBreakpoints = normalizeTierBreakpoints(payload.tierBreakpoints, minQuantity);
    const baseCmykCoveragePct = numberOrZero(payload.cmykCoveragePct || payload.baseCmykCoveragePct || 40);

    const data = {
      shop,
      name: payload.name || "Untitled recipe",
      sku: payload.sku || null,
      productType,
      widthIn: nullableNumber(payload.widthIn),
      heightIn: nullableNumber(payload.heightIn),
      minQuantity,
      defaultQuantity,
      baseCmykCoveragePct,
      inkAllowancePct: numberOrZero(payload.inkAllowancePct || 15),
      maintenanceCostPerSqft: numberOrZero(payload.maintenanceCostPerSqft || 0.08),
      machineRecoveryCostPerSqft: numberOrZero(payload.machineRecoveryCostPerSqft || 0.05),
      overheadCostPerSqft: numberOrZero(payload.overheadCostPerSqft || 0),
      operatorLaborPct: numberOrZero(payload.operatorLaborPct || 25),
      targetMarginPct: numberOrZero(payload.targetMarginPct || productDefault.targetMarginPct),
      wastePct: numberOrZero(payload.wastePct),
      setupCost: numberOrZero(payload.setupCost),
      laborMinutes: numberOrZero(payload.laborMinutes),
      notes: payload.notes || null,
      active: true,
    };

    const recipe = await db.$transaction(async (tx) => {
      let savedRecipe;

      if (payload.id) {
        savedRecipe = await tx.productRecipe.update({
          where: { id: payload.id },
          data,
        });

        await tx.recipeTier.deleteMany({ where: { recipeId: payload.id, shop } });
        await tx.recipeMachineRule.deleteMany({ where: { recipeId: payload.id, shop } });
        await tx.recipeInkRequirement.deleteMany({ where: { recipeId: payload.id, shop } });
        await tx.recipeMaterial.deleteMany({ where: { recipeId: payload.id, shop } });
      } else {
        savedRecipe = await tx.productRecipe.create({ data });
      }

      if (payload.mediaMaterialId) {
        await tx.recipeMaterial.create({
          data: {
            shop,
            recipeId: savedRecipe.id,
            materialId: payload.mediaMaterialId,
            usageType: "media",
            quantity: 1,
            unit: "sqft",
            includeWaste: true,
          },
        });
      }

      if (payload.laminateMaterialId) {
        await tx.recipeMaterial.create({
          data: {
            shop,
            recipeId: savedRecipe.id,
            materialId: payload.laminateMaterialId,
            usageType: "laminate",
            quantity: 1,
            unit: "sqft",
            includeWaste: true,
          },
        });
      }

      const inkRequirements = [
        { inkType: "cmyk", coveragePercent: baseCmykCoveragePct, required: baseCmykCoveragePct > 0, notes: "Base CMYK estimate" },
        { inkType: "white", coveragePercent: 100, required: false, notes: "Optional 1-layer white finish" },
        { inkType: "gloss", coveragePercent: 100, required: false, notes: "Optional gloss/emboss layer. Emboss uses stacked gloss passes." },
      ];

      for (const ink of inkRequirements) {
        await tx.recipeInkRequirement.create({
          data: {
            shop,
            recipeId: savedRecipe.id,
            ...ink,
          },
        });
      }

      if (payload.machineId) {
        await tx.recipeMachineRule.create({
          data: {
            shop,
            recipeId: savedRecipe.id,
            preferredMachineId: payload.machineId,
            requiredInkTypes: "cmyk",
            allowOverflow: Boolean(payload.allowOverflow),
            notes: "Finish table handles optional white, gloss, emboss, and 3x emboss. Roland is preferred for any gloss/emboss option.",
          },
        });
      }

      for (const minQty of tierBreakpoints) {
        await tx.recipeTier.create({
          data: {
            shop,
            recipeId: savedRecipe.id,
            minQty,
            marginPct: numberOrZero(payload.targetMarginPct || productDefault.targetMarginPct),
          },
        });
      }

      return savedRecipe;
    });

    return Response.json({ ok: true, recipe });
  }

  if (payload.intent === "archiveRecipe") {
    await db.productRecipe.update({
      where: { id: payload.id },
      data: { active: false },
    });
    return Response.json({ ok: true });
  }

  if (payload.intent === "restoreRecipe") {
    await db.productRecipe.update({
      where: { id: payload.id },
      data: { active: true },
    });
    return Response.json({ ok: true });
  }

  if (payload.intent === "deleteRecipe") {
    await db.productRecipe.delete({ where: { id: payload.id } });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false });
}

export default function RecipesPage() {
  const { recipes, materials, machines } = useLoaderData<any>();
  const fetcher = useFetcher<any>();
  const navigate = useNavigate();

  const labelDefaults = defaultForProductType("label");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState("active");
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [productType, setProductType] = useState("label");
  const [widthIn, setWidthIn] = useState("");
  const [heightIn, setHeightIn] = useState("");
  const [minQuantity, setMinQuantity] = useState(String(labelDefaults.minQuantity));
  const [defaultQuantity, setDefaultQuantity] = useState(String(labelDefaults.defaultQuantity));
  const [tierBreakpoints, setTierBreakpoints] = useState(labelDefaults.tiers.join(", "));
  const [mediaMaterialId, setMediaMaterialId] = useState("");
  const [laminateMaterialId, setLaminateMaterialId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [cmykCoveragePct, setCmykCoveragePct] = useState("40");
  const [inkAllowancePct, setInkAllowancePct] = useState("15");
  const [maintenanceCostPerSqft, setMaintenanceCostPerSqft] = useState("0.08");
  const [machineRecoveryCostPerSqft, setMachineRecoveryCostPerSqft] = useState("0.05");
  const [overheadCostPerSqft, setOverheadCostPerSqft] = useState("0");
  const [operatorLaborPct, setOperatorLaborPct] = useState("25");
  const [wastePct, setWastePct] = useState("10");
  const [setupCost, setSetupCost] = useState("0");
  const [laborMinutes, setLaborMinutes] = useState("0");
  const [laborRate, setLaborRate] = useState("25");
  const [targetMarginPct, setTargetMarginPct] = useState(String(labelDefaults.targetMarginPct));
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (fetcher.data?.ok) {
      resetForm();
      navigate(".");
    }
  }, [fetcher.data, navigate]);

  const materialOptions = [
    emptyOption,
    ...materials.map((material: any) => ({
      label: `${material.name} - ${money(materialUnitCost(material))}/${material.baseUnit || material.unit || "each"}`,
      value: material.id,
    })),
  ];

  const machineOptions = [
    emptyOption,
    ...machines.map((machine: any) => ({ label: machine.name, value: machine.id })),
  ];

  const mediaMaterial = materials.find((material: any) => material.id === mediaMaterialId);
  const laminateMaterial = materials.find((material: any) => material.id === laminateMaterialId);
  const selectedMachine = machines.find((machine: any) => machine.id === machineId);
  const normalizedMinQuantity = positiveInt(minQuantity, defaultForProductType(productType).minQuantity);
  const normalizedDefaultQuantity = Math.max(
    normalizedMinQuantity,
    positiveInt(defaultQuantity, defaultForProductType(productType).defaultQuantity),
  );
  const normalizedTiers = normalizeTierBreakpoints(tierBreakpoints, normalizedMinQuantity);

  const finishResults = useMemo(
    () =>
      labelFinishPresets.map((finish) =>
        calcLabelFinish(
          {
            widthIn,
            heightIn,
            minQuantity: normalizedMinQuantity,
            quantity: normalizedDefaultQuantity,
            wastePct,
            targetMarginPct,
            setupCost,
            laborMinutes,
            laborRate,
            operatorLaborPct,
            inkAllowancePct,
            maintenanceCostPerSqft,
            machineRecoveryCostPerSqft,
            overheadCostPerSqft,
            mediaMaterial,
            laminateMaterial,
            machine: selectedMachine,
            cmykCoveragePct,
          },
          finish,
        ),
      ),
    [
      widthIn,
      heightIn,
      normalizedMinQuantity,
      normalizedDefaultQuantity,
      wastePct,
      targetMarginPct,
      setupCost,
      laborMinutes,
      laborRate,
      operatorLaborPct,
      inkAllowancePct,
      maintenanceCostPerSqft,
      machineRecoveryCostPerSqft,
      overheadCostPerSqft,
      mediaMaterial,
      laminateMaterial,
      selectedMachine,
      cmykCoveragePct,
    ],
  );

  const tierFinishResults = useMemo(
    () =>
      normalizedTiers.map((tierQty) => ({
        quantity: tierQty,
        finishes: labelFinishPresets.map((finish) =>
          calcLabelFinish(
            {
              widthIn,
              heightIn,
              minQuantity: normalizedMinQuantity,
              quantity: tierQty,
              wastePct,
              targetMarginPct,
              setupCost,
              laborMinutes,
              laborRate,
              operatorLaborPct,
              inkAllowancePct,
              maintenanceCostPerSqft,
              machineRecoveryCostPerSqft,
              overheadCostPerSqft,
              mediaMaterial,
              laminateMaterial,
              machine: selectedMachine,
              cmykCoveragePct,
            },
            finish,
            tierQty,
          ),
        ),
      })),
    [
      normalizedTiers,
      widthIn,
      heightIn,
      normalizedMinQuantity,
      wastePct,
      targetMarginPct,
      setupCost,
      laborMinutes,
      laborRate,
      operatorLaborPct,
      inkAllowancePct,
      maintenanceCostPerSqft,
      machineRecoveryCostPerSqft,
      overheadCostPerSqft,
      mediaMaterial,
      laminateMaterial,
      selectedMachine,
      cmykCoveragePct,
    ],
  );

  const baseCalculation = finishResults[0] || calcLabelFinish({}, labelFinishPresets[0]);

  const filteredRecipes = recipes.filter((recipe: any) => {
    if (activeFilter === "all") return true;
    if (activeFilter === "archived") return recipe.active === false;
    return recipe.active !== false;
  });

  function applyProductTypeDefaults(value: string) {
    const defaults = defaultForProductType(value);
    setProductType(value);
    setMinQuantity(String(defaults.minQuantity));
    setDefaultQuantity(String(defaults.defaultQuantity));
    setTierBreakpoints(defaults.tiers.join(", "));
    setTargetMarginPct(String(defaults.targetMarginPct));
  }

  function resetForm() {
    const defaults = defaultForProductType("label");
    setEditingId(null);
    setName("");
    setSku("");
    setProductType("label");
    setWidthIn("");
    setHeightIn("");
    setMinQuantity(String(defaults.minQuantity));
    setDefaultQuantity(String(defaults.defaultQuantity));
    setTierBreakpoints(defaults.tiers.join(", "));
    setMediaMaterialId("");
    setLaminateMaterialId("");
    setMachineId("");
    setCmykCoveragePct("40");
    setInkAllowancePct("15");
    setMaintenanceCostPerSqft("0.08");
    setMachineRecoveryCostPerSqft("0.05");
    setOverheadCostPerSqft("0");
    setOperatorLaborPct("25");
    setWastePct("10");
    setSetupCost("0");
    setLaborMinutes("0");
    setLaborRate("25");
    setTargetMarginPct(String(defaults.targetMarginPct));
    setNotes("");
  }

  function saveRecipe() {
    fetcher.submit(
      {
        intent: "saveRecipe",
        id: editingId,
        name,
        sku,
        productType,
        widthIn,
        heightIn,
        minQuantity: normalizedMinQuantity,
        defaultQuantity: normalizedDefaultQuantity,
        tierBreakpoints: normalizedTiers.join(","),
        mediaMaterialId,
        laminateMaterialId,
        machineId,
        cmykCoveragePct,
        inkAllowancePct,
        maintenanceCostPerSqft,
        machineRecoveryCostPerSqft,
        overheadCostPerSqft,
        operatorLaborPct,
        wastePct,
        setupCost,
        laborMinutes,
        targetMarginPct,
        notes,
      },
      { method: "post", encType: "application/json" },
    );
  }

  function editRecipe(recipe: any) {
    const media = recipe.materials?.find((item: any) => item.usageType === "media");
    const laminate = recipe.materials?.find((item: any) => item.usageType === "laminate");
    const machineRule = recipe.machineRules?.[0];
    const cmyk = recipe.inkRequirements?.find((item: any) => item.inkType === "cmyk");
    const defaults = defaultForProductType(recipe.productType || "label");

    setEditingId(recipe.id);
    setName(recipe.name || "");
    setSku(recipe.sku || "");
    setProductType(recipe.productType || "label");
    setWidthIn(recipe.widthIn !== null && recipe.widthIn !== undefined ? String(recipe.widthIn) : "");
    setHeightIn(recipe.heightIn !== null && recipe.heightIn !== undefined ? String(recipe.heightIn) : "");
    setMinQuantity(recipe.minQuantity ? String(recipe.minQuantity) : String(defaults.minQuantity));
    setDefaultQuantity(recipe.defaultQuantity ? String(recipe.defaultQuantity) : String(defaults.defaultQuantity));
    setTierBreakpoints(recipe.tiers?.length ? recipe.tiers.map((tier: any) => tier.minQty).join(", ") : defaults.tiers.join(", "));
    setMediaMaterialId(media?.materialId || "");
    setLaminateMaterialId(laminate?.materialId || "");
    setMachineId(machineRule?.preferredMachineId || "");
    setCmykCoveragePct(
      recipe.baseCmykCoveragePct !== null && recipe.baseCmykCoveragePct !== undefined
        ? String(recipe.baseCmykCoveragePct)
        : cmyk
          ? String(cmyk.coveragePercent)
          : "40",
    );
    setInkAllowancePct(recipe.inkAllowancePct !== null && recipe.inkAllowancePct !== undefined ? String(recipe.inkAllowancePct) : "15");
    setMaintenanceCostPerSqft(
      recipe.maintenanceCostPerSqft !== null && recipe.maintenanceCostPerSqft !== undefined
        ? String(recipe.maintenanceCostPerSqft)
        : "0.08",
    );
    setMachineRecoveryCostPerSqft(
      recipe.machineRecoveryCostPerSqft !== null && recipe.machineRecoveryCostPerSqft !== undefined
        ? String(recipe.machineRecoveryCostPerSqft)
        : "0.05",
    );
    setOverheadCostPerSqft(recipe.overheadCostPerSqft !== null && recipe.overheadCostPerSqft !== undefined ? String(recipe.overheadCostPerSqft) : "0");
    setOperatorLaborPct(recipe.operatorLaborPct !== null && recipe.operatorLaborPct !== undefined ? String(recipe.operatorLaborPct) : "25");
    setWastePct(recipe.wastePct !== null && recipe.wastePct !== undefined ? String(recipe.wastePct) : "0");
    setSetupCost(recipe.setupCost !== null && recipe.setupCost !== undefined ? String(recipe.setupCost) : "0");
    setLaborMinutes(recipe.laborMinutes !== null && recipe.laborMinutes !== undefined ? String(recipe.laborMinutes) : "0");
    setTargetMarginPct(recipe.targetMarginPct !== null && recipe.targetMarginPct !== undefined ? String(recipe.targetMarginPct) : String(defaults.targetMarginPct));
    setNotes(recipe.notes || "");
  }

  function archiveRecipe(id: string) {
    fetcher.submit({ intent: "archiveRecipe", id }, { method: "post", encType: "application/json" });
  }

  function restoreRecipe(id: string) {
    fetcher.submit({ intent: "restoreRecipe", id }, { method: "post", encType: "application/json" });
  }

  function deleteRecipe(id: string) {
    if (!window.confirm("Permanently delete this recipe? This cannot be undone.")) return;
    fetcher.submit({ intent: "deleteRecipe", id }, { method: "post", encType: "application/json" });
  }

  return (
    <Page title="Product Recipes" backAction={{ content: "Dashboard", url: "/app" }}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">
                    Recipe Calculator
                  </Text>
                  <Text as="p" tone="subdued">
                    Pick a product type to auto-load minimum quantities and tier breakpoints. Label recipes now calculate normal print, white, gloss, emboss, and 3x emboss with production speed/time built in.
                  </Text>
                </BlockStack>
                {editingId ? <Badge tone="info">Editing</Badge> : <Badge>New recipe</Badge>}
              </InlineStack>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 2 }}>
                  <TextField label="Recipe Name" value={name} onChange={setName} autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="SKU" value={sku} onChange={setSku} autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <Select label="Product Type" options={productTypes} value={productType} onChange={applyProductTypeDefaults} />
                </div>
              </InlineStack>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="Minimum Quantity" value={minQuantity} onChange={setMinQuantity} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Default Quote Quantity" value={defaultQuantity} onChange={setDefaultQuantity} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 2 }}>
                  <TextField
                    label="Pricing Tiers / Breakpoints"
                    value={tierBreakpoints}
                    onChange={setTierBreakpoints}
                    helpText="Comma-separated. The minimum quantity is always included automatically."
                    autoComplete="off"
                  />
                </div>
              </InlineStack>

              <Card background="bg-surface-secondary">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Product quantity rules
                  </Text>
                  <InlineStack gap="400">
                    <Text as="p">Minimum: {normalizedMinQuantity}</Text>
                    <Text as="p">Default quote qty: {normalizedDefaultQuantity}</Text>
                    <Text as="p">Tiers: {normalizedTiers.join(", ")}</Text>
                  </InlineStack>
                </BlockStack>
              </Card>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="Label Width In" value={widthIn} onChange={setWidthIn} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Label Height In" value={heightIn} onChange={setHeightIn} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Base CMYK Coverage %" value={cmykCoveragePct} onChange={setCmykCoveragePct} type="number" autoComplete="off" helpText="Normal labels usually start around 40%. Heavy/full-color jobs can be higher." />
                </div>
              </InlineStack>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <Select label="Media Material" options={materialOptions} value={mediaMaterialId} onChange={setMediaMaterialId} />
                </div>
                <div style={{ flex: 1 }}>
                  <Select label="Laminate Optional" options={materialOptions} value={laminateMaterialId} onChange={setLaminateMaterialId} />
                </div>
              </InlineStack>

              <Select label="Preferred Machine" options={machineOptions} value={machineId} onChange={setMachineId} helpText="Any gloss, emboss, or 3x emboss option should be quoted for the Roland LG-540." />

              <Card background="bg-surface-secondary">
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Production estimating defaults
                  </Text>
                  <InlineStack gap="300" wrap={false}>
                    <div style={{ flex: 1 }}>
                      <TextField label="Waste %" value={wastePct} onChange={setWastePct} type="number" autoComplete="off" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField label="Ink Allowance %" value={inkAllowancePct} onChange={setInkAllowancePct} type="number" autoComplete="off" helpText="Use 10-15% for maintenance/purge allowance." />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField label="Maintenance $/SqFt" value={maintenanceCostPerSqft} onChange={setMaintenanceCostPerSqft} type="number" prefix="$" autoComplete="off" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField label="Machine Recovery $/SqFt" value={machineRecoveryCostPerSqft} onChange={setMachineRecoveryCostPerSqft} type="number" prefix="$" autoComplete="off" />
                    </div>
                  </InlineStack>
                  <InlineStack gap="300" wrap={false}>
                    <div style={{ flex: 1 }}>
                      <TextField label="Setup Cost" value={setupCost} onChange={setSetupCost} type="number" prefix="$" autoComplete="off" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField label="Fixed Labor Minutes" value={laborMinutes} onChange={setLaborMinutes} type="number" autoComplete="off" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField label="Labor Rate / Hr" value={laborRate} onChange={setLaborRate} type="number" prefix="$" autoComplete="off" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField label="Operator Run Labor %" value={operatorLaborPct} onChange={setOperatorLaborPct} type="number" autoComplete="off" helpText="Percent of print run time charged as labor." />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField label="Target Margin %" value={targetMarginPct} onChange={setTargetMarginPct} type="number" autoComplete="off" />
                    </div>
                  </InlineStack>
                  <TextField label="Overhead $/SqFt Optional" value={overheadCostPerSqft} onChange={setOverheadCostPerSqft} type="number" prefix="$" autoComplete="off" />
                </BlockStack>
              </Card>

              <TextField label="Notes" value={notes} onChange={setNotes} multiline={3} autoComplete="off" />

              <Card background="bg-surface-secondary">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Label Area Preview
                  </Text>
                  <InlineStack gap="500">
                    <Text as="p">Qty used: {baseCalculation.quantity}</Text>
                    <Text as="p">Sq In / Label: {baseCalculation.sqinPerLabel.toFixed(4)}</Text>
                    <Text as="p">Sq Ft / Label: {baseCalculation.sqftPerLabel.toFixed(6)}</Text>
                    <Text as="p">Total Sq Ft w/ Waste: {baseCalculation.totalSqft.toFixed(4)}</Text>
                  </InlineStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingSm">
                      Finish Price Table at Default Quantity
                    </Text>
                    <Text as="p" tone="subdued">
                      White is one layer. Gloss is one gloss layer. Emboss is two stacked gloss layers. 3x Emboss is three stacked gloss layers for a stronger raised/braille-style feel.
                    </Text>
                  </BlockStack>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", padding: "8px" }}>Finish</th>
                          <th style={{ textAlign: "right", padding: "8px" }}>Cost Each</th>
                          <th style={{ textAlign: "right", padding: "8px" }}>Suggested Each</th>
                          <th style={{ textAlign: "right", padding: "8px" }}>Total Price</th>
                          <th style={{ textAlign: "right", padding: "8px" }}>Est. Time</th>
                          <th style={{ textAlign: "right", padding: "8px" }}>Speed</th>
                          <th style={{ textAlign: "left", padding: "8px" }}>Machine</th>
                        </tr>
                      </thead>
                      <tbody>
                        {finishResults.map((result) => (
                          <tr key={result.finish.key} style={{ borderTop: "1px solid #ddd" }}>
                            <td style={{ padding: "8px" }}>
                              <BlockStack gap="050">
                                <Text as="span" fontWeight="bold">{result.finish.label}</Text>
                                <Text as="span" tone="subdued">{result.finish.description}</Text>
                              </BlockStack>
                            </td>
                            <td style={{ textAlign: "right", padding: "8px" }}>{money(result.unitCost)}</td>
                            <td style={{ textAlign: "right", padding: "8px" }}>{money(result.recommendedUnitPrice)}</td>
                            <td style={{ textAlign: "right", padding: "8px" }}>{dollars(result.totalSellPrice)}</td>
                            <td style={{ textAlign: "right", padding: "8px" }}>{result.machineHours.toFixed(2)} hr</td>
                            <td style={{ textAlign: "right", padding: "8px" }}>{result.sqftPerHour} sqft/hr</td>
                            <td style={{ padding: "8px" }}>{result.finish.preferredMachine}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Cost Breakdown: {finishResults[0]?.finish.label || "Base Print"}
                  </Text>
                  <InlineStack gap="500">
                    <Text as="p">Media: {money(baseCalculation.mediaCost)}</Text>
                    <Text as="p">Laminate: {money(baseCalculation.laminateCost)}</Text>
                    <Text as="p">CMYK Ink: {money(baseCalculation.cmykInkCost)}</Text>
                    <Text as="p">Machine/hr: {money(baseCalculation.machineHourlyCost)}</Text>
                    <Text as="p">Machine Recovery: {money(baseCalculation.machineRecoveryCost)}</Text>
                    <Text as="p">Maintenance: {money(baseCalculation.maintenanceCost)}</Text>
                    <Text as="p">Labor: {money(baseCalculation.laborCost)}</Text>
                    <Text as="p">Setup: {money(baseCalculation.setupCost)}</Text>
                  </InlineStack>
                  <Divider />
                  <InlineStack gap="500">
                    <Text as="p" fontWeight="bold">Total Cost: {money(baseCalculation.totalCost)}</Text>
                    <Text as="p" fontWeight="bold">Unit Cost: {money(baseCalculation.unitCost)}</Text>
                    <Text as="p" fontWeight="bold">Recommended Unit Price: {money(baseCalculation.recommendedUnitPrice)}</Text>
                    <Text as="p" fontWeight="bold">Margin: {percent(baseCalculation.actualMarginPct)}</Text>
                  </InlineStack>
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">
                    Tier Pricing Snapshot
                  </Text>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr>
                          <th style={{ textAlign: "left", padding: "8px" }}>Qty</th>
                          <th style={{ textAlign: "right", padding: "8px" }}>Base Each</th>
                          <th style={{ textAlign: "right", padding: "8px" }}>White Each</th>
                          <th style={{ textAlign: "right", padding: "8px" }}>Gloss Each</th>
                          <th style={{ textAlign: "right", padding: "8px" }}>Emboss Each</th>
                          <th style={{ textAlign: "right", padding: "8px" }}>3x Emboss Each</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tierFinishResults.map((tier) => {
                          const byKey: Record<string, any> = {};
                          for (const item of tier.finishes) byKey[item.finish.key] = item;
                          return (
                            <tr key={tier.quantity} style={{ borderTop: "1px solid #ddd" }}>
                              <td style={{ padding: "8px" }}>{tier.quantity}</td>
                              <td style={{ textAlign: "right", padding: "8px" }}>{money(byKey.base?.recommendedUnitPrice || 0)}</td>
                              <td style={{ textAlign: "right", padding: "8px" }}>{money(byKey.white?.recommendedUnitPrice || 0)}</td>
                              <td style={{ textAlign: "right", padding: "8px" }}>{money(byKey.gloss?.recommendedUnitPrice || 0)}</td>
                              <td style={{ textAlign: "right", padding: "8px" }}>{money(byKey.emboss?.recommendedUnitPrice || 0)}</td>
                              <td style={{ textAlign: "right", padding: "8px" }}>{money(byKey.emboss_3x?.recommendedUnitPrice || 0)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </BlockStack>
              </Card>

              <InlineStack gap="200">
                <Button variant="primary" onClick={saveRecipe} disabled={!name || !mediaMaterialId}>
                  {editingId ? "Update Recipe" : "Save Recipe"}
                </Button>
                <Button onClick={resetForm}>Clear</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Recipes</Text>
                <Select label="Status" labelHidden options={statusOptions} value={activeFilter} onChange={setActiveFilter} />
              </InlineStack>

              {filteredRecipes.length === 0 ? (
                <Text as="p" tone="subdued">No recipes yet.</Text>
              ) : (
                filteredRecipes.map((recipe: any) => {
                  const media = recipe.materials?.find((item: any) => item.usageType === "media")?.material;
                  const machine = recipe.machineRules?.[0]?.preferredMachine;
                  const recipeTiers = recipe.tiers?.map((tier: any) => tier.minQty).join(", ") || "No tiers";

                  return (
                    <Card key={recipe.id} background="bg-surface-secondary">
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <BlockStack gap="100">
                            <Text as="h3" variant="headingSm">{recipe.name}</Text>
                            <Text as="p" tone="subdued">
                              {productTypeDefaults[recipe.productType]?.label || recipe.productType || "Recipe"} • Min {recipe.minQuantity || 1} • Default Qty {recipe.defaultQuantity || 1}
                            </Text>
                          </BlockStack>
                          <InlineStack gap="100">
                            <Badge>{productTypeDefaults[recipe.productType]?.label || recipe.productType || "recipe"}</Badge>
                            {recipe.active === false && <Badge tone="warning">ARCHIVED</Badge>}
                          </InlineStack>
                        </InlineStack>
                        <Text as="p">Size: {recipe.widthIn || 0} in x {recipe.heightIn || 0} in</Text>
                        <Text as="p">Tiers: {recipeTiers}</Text>
                        <Text as="p">Media: {media?.name || "Not selected"}</Text>
                        <Text as="p">Machine: {machine?.name || "Not selected"}</Text>
                        <Text as="p">CMYK: {recipe.baseCmykCoveragePct ?? 40}% • Waste: {recipe.wastePct || 0}% • Target Margin: {recipe.targetMarginPct || 0}%</Text>
                        <InlineStack gap="200">
                          <Button onClick={() => editRecipe(recipe)}>Edit</Button>
                          {recipe.active === false ? (
                            <>
                              <Button onClick={() => restoreRecipe(recipe.id)}>Restore</Button>
                              <Button tone="critical" onClick={() => deleteRecipe(recipe.id)}>Delete Forever</Button>
                            </>
                          ) : (
                            <Button tone="critical" onClick={() => archiveRecipe(recipe.id)}>Archive</Button>
                          )}
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
