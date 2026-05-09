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

const productTypes = [{ label: "Labels", value: "label" }];

const statusOptions = [
  { label: "Active", value: "active" },
  { label: "Archived", value: "archived" },
  { label: "All", value: "all" },
];

const emptyOption = { label: "None", value: "" };

function numberOrZero(value: any) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function nullableNumber(value: any) {
  if (value === null || value === undefined || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function money(value: number) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(4)}`;
}

function percent(value: number) {
  if (!Number.isFinite(value)) return "0.00%";
  return `${value.toFixed(2)}%`;
}

function materialUnitCost(material: any) {
  return numberOrZero(material?.calculatedUnitCost || material?.costPerUnit);
}

function machineInkCost(machine: any, inkType: string, totalSqft: number, coveragePercent: number) {
  if (!machine || !coveragePercent || coveragePercent <= 0) return 0;

  const channels = (machine.inkChannels || []).filter(
    (channel: any) => channel.enabled !== false && channel.inkType === inkType,
  );

  return channels.reduce((sum: number, channel: any) => {
    const costPerMl = numberOrZero(channel.costPerMl);
    const mlPerSqft1Pct = numberOrZero(channel.mlPerSqft1Pct || channel.mlPerSqft100 / 100);
    return sum + totalSqft * coveragePercent * mlPerSqft1Pct * costPerMl;
  }, 0);
}

function calcLabelRecipe(input: any) {
  const widthIn = numberOrZero(input.widthIn);
  const heightIn = numberOrZero(input.heightIn);
  const quantity = Math.max(1, Math.round(numberOrZero(input.quantity) || 1));
  const wastePct = numberOrZero(input.wastePct);
  const targetMarginPct = numberOrZero(input.targetMarginPct);
  const setupCost = numberOrZero(input.setupCost);
  const laborMinutes = numberOrZero(input.laborMinutes);
  const laborRate = numberOrZero(input.laborRate || 25);
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

  const cmykInkCost = machineInkCost(machine, "cmyk", totalSqft, numberOrZero(input.cmykCoveragePct));
  const whiteInkCost = machineInkCost(machine, "white", totalSqft, numberOrZero(input.whiteCoveragePct));
  const glossInkCost = machineInkCost(machine, "gloss", totalSqft, numberOrZero(input.glossCoveragePct));
  const inkCost = cmykInkCost + whiteInkCost + glossInkCost;

  const sqftPerHour = numberOrZero(machine?.sqftPerHour);
  const machineCostPerHour = numberOrZero(machine?.costPerHour);
  const machineHours = sqftPerHour > 0 ? totalSqft / sqftPerHour : 0;
  const machineCost = machineHours * machineCostPerHour;

  const laborCost = (laborMinutes / 60) * laborRate;
  const totalCost = mediaCost + laminateCost + inkCost + machineCost + laborCost + setupCost;
  const unitCost = totalCost / quantity;
  const marginDecimal = Math.min(0.95, Math.max(0, targetMarginPct / 100));
  const recommendedUnitPrice = marginDecimal >= 0.95 ? unitCost : unitCost / (1 - marginDecimal);
  const totalSellPrice = recommendedUnitPrice * quantity;
  const grossProfit = totalSellPrice - totalCost;
  const actualMarginPct = totalSellPrice > 0 ? (grossProfit / totalSellPrice) * 100 : 0;

  return {
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
    machineHours,
    machineCost,
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
    const data = {
      shop,
      name: payload.name || "Untitled label recipe",
      sku: payload.sku || null,
      productType: payload.productType || "label",
      widthIn: nullableNumber(payload.widthIn),
      heightIn: nullableNumber(payload.heightIn),
      defaultQuantity: Math.max(1, Math.round(Number(payload.defaultQuantity) || 1000)),
      targetMarginPct: numberOrZero(payload.targetMarginPct || 40),
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
        { inkType: "cmyk", coveragePercent: numberOrZero(payload.cmykCoveragePct), required: numberOrZero(payload.cmykCoveragePct) > 0 },
        { inkType: "white", coveragePercent: numberOrZero(payload.whiteCoveragePct), required: numberOrZero(payload.whiteCoveragePct) > 0 },
        { inkType: "gloss", coveragePercent: numberOrZero(payload.glossCoveragePct), required: numberOrZero(payload.glossCoveragePct) > 0 },
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
        const requiredInkTypes = inkRequirements
          .filter((ink) => ink.required)
          .map((ink) => ink.inkType)
          .join(",");

        await tx.recipeMachineRule.create({
          data: {
            shop,
            recipeId: savedRecipe.id,
            preferredMachineId: payload.machineId,
            requiredInkTypes,
            allowOverflow: Boolean(payload.allowOverflow),
          },
        });
      }

      await tx.recipeTier.create({
        data: {
          shop,
          recipeId: savedRecipe.id,
          minQty: Math.max(1, Math.round(Number(payload.defaultQuantity) || 1000)),
          marginPct: numberOrZero(payload.targetMarginPct || 40),
        },
      });

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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState("active");
  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [productType, setProductType] = useState("label");
  const [widthIn, setWidthIn] = useState("");
  const [heightIn, setHeightIn] = useState("");
  const [defaultQuantity, setDefaultQuantity] = useState("1000");
  const [mediaMaterialId, setMediaMaterialId] = useState("");
  const [laminateMaterialId, setLaminateMaterialId] = useState("");
  const [machineId, setMachineId] = useState("");
  const [cmykCoveragePct, setCmykCoveragePct] = useState("40");
  const [whiteCoveragePct, setWhiteCoveragePct] = useState("0");
  const [glossCoveragePct, setGlossCoveragePct] = useState("0");
  const [wastePct, setWastePct] = useState("10");
  const [setupCost, setSetupCost] = useState("0");
  const [laborMinutes, setLaborMinutes] = useState("0");
  const [laborRate, setLaborRate] = useState("25");
  const [targetMarginPct, setTargetMarginPct] = useState("50");
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

  const calculation = useMemo(
    () =>
      calcLabelRecipe({
        widthIn,
        heightIn,
        quantity: defaultQuantity,
        wastePct,
        targetMarginPct,
        setupCost,
        laborMinutes,
        laborRate,
        mediaMaterial,
        laminateMaterial,
        machine: selectedMachine,
        cmykCoveragePct,
        whiteCoveragePct,
        glossCoveragePct,
      }),
    [
      widthIn,
      heightIn,
      defaultQuantity,
      wastePct,
      targetMarginPct,
      setupCost,
      laborMinutes,
      laborRate,
      mediaMaterial,
      laminateMaterial,
      selectedMachine,
      cmykCoveragePct,
      whiteCoveragePct,
      glossCoveragePct,
    ],
  );

  const filteredRecipes = recipes.filter((recipe: any) => {
    if (activeFilter === "all") return true;
    if (activeFilter === "archived") return recipe.active === false;
    return recipe.active !== false;
  });

  function resetForm() {
    setEditingId(null);
    setName("");
    setSku("");
    setProductType("label");
    setWidthIn("");
    setHeightIn("");
    setDefaultQuantity("1000");
    setMediaMaterialId("");
    setLaminateMaterialId("");
    setMachineId("");
    setCmykCoveragePct("40");
    setWhiteCoveragePct("0");
    setGlossCoveragePct("0");
    setWastePct("10");
    setSetupCost("0");
    setLaborMinutes("0");
    setLaborRate("25");
    setTargetMarginPct("50");
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
        defaultQuantity,
        mediaMaterialId,
        laminateMaterialId,
        machineId,
        cmykCoveragePct,
        whiteCoveragePct,
        glossCoveragePct,
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
    const white = recipe.inkRequirements?.find((item: any) => item.inkType === "white");
    const gloss = recipe.inkRequirements?.find((item: any) => item.inkType === "gloss");

    setEditingId(recipe.id);
    setName(recipe.name || "");
    setSku(recipe.sku || "");
    setProductType(recipe.productType || "label");
    setWidthIn(recipe.widthIn !== null && recipe.widthIn !== undefined ? String(recipe.widthIn) : "");
    setHeightIn(recipe.heightIn !== null && recipe.heightIn !== undefined ? String(recipe.heightIn) : "");
    setDefaultQuantity(recipe.defaultQuantity ? String(recipe.defaultQuantity) : "1000");
    setMediaMaterialId(media?.materialId || "");
    setLaminateMaterialId(laminate?.materialId || "");
    setMachineId(machineRule?.preferredMachineId || "");
    setCmykCoveragePct(cmyk ? String(cmyk.coveragePercent) : "0");
    setWhiteCoveragePct(white ? String(white.coveragePercent) : "0");
    setGlossCoveragePct(gloss ? String(gloss.coveragePercent) : "0");
    setWastePct(recipe.wastePct !== null && recipe.wastePct !== undefined ? String(recipe.wastePct) : "0");
    setSetupCost(recipe.setupCost !== null && recipe.setupCost !== undefined ? String(recipe.setupCost) : "0");
    setLaborMinutes(recipe.laborMinutes !== null && recipe.laborMinutes !== undefined ? String(recipe.laborMinutes) : "0");
    setTargetMarginPct(recipe.targetMarginPct !== null && recipe.targetMarginPct !== undefined ? String(recipe.targetMarginPct) : "50");
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
                    Label Recipe Calculator
                  </Text>
                  <Text as="p" tone="subdued">
                    Build the true cost for labels from area, media, laminate, ink, machine time, labor, waste, and margin.
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
                  <Select label="Product Type" options={productTypes} value={productType} onChange={setProductType} />
                </div>
              </InlineStack>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="Label Width In" value={widthIn} onChange={setWidthIn} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Label Height In" value={heightIn} onChange={setHeightIn} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Quantity" value={defaultQuantity} onChange={setDefaultQuantity} type="number" autoComplete="off" />
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

              <Select label="Preferred Machine" options={machineOptions} value={machineId} onChange={setMachineId} />

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="CMYK Coverage %" value={cmykCoveragePct} onChange={setCmykCoveragePct} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="White Coverage %" value={whiteCoveragePct} onChange={setWhiteCoveragePct} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Gloss Coverage %" value={glossCoveragePct} onChange={setGlossCoveragePct} type="number" autoComplete="off" />
                </div>
              </InlineStack>

              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <TextField label="Waste %" value={wastePct} onChange={setWastePct} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Setup Cost" value={setupCost} onChange={setSetupCost} type="number" prefix="$" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Labor Minutes" value={laborMinutes} onChange={setLaborMinutes} type="number" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Labor Rate / Hr" value={laborRate} onChange={setLaborRate} type="number" prefix="$" autoComplete="off" />
                </div>
                <div style={{ flex: 1 }}>
                  <TextField label="Target Margin %" value={targetMarginPct} onChange={setTargetMarginPct} type="number" autoComplete="off" />
                </div>
              </InlineStack>

              <TextField label="Notes" value={notes} onChange={setNotes} multiline={3} autoComplete="off" />

              <Card background="bg-surface-secondary">
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Live Cost Preview
                  </Text>
                  <InlineStack gap="500">
                    <Text as="p">Sq In / Label: {calculation.sqinPerLabel.toFixed(4)}</Text>
                    <Text as="p">Sq Ft / Label: {calculation.sqftPerLabel.toFixed(6)}</Text>
                    <Text as="p">Total Sq Ft w/ Waste: {calculation.totalSqft.toFixed(4)}</Text>
                  </InlineStack>
                  <Divider />
                  <InlineStack gap="500">
                    <Text as="p">Media: {money(calculation.mediaCost)}</Text>
                    <Text as="p">Laminate: {money(calculation.laminateCost)}</Text>
                    <Text as="p">Ink: {money(calculation.inkCost)}</Text>
                    <Text as="p">Machine: {money(calculation.machineCost)}</Text>
                    <Text as="p">Labor: {money(calculation.laborCost)}</Text>
                    <Text as="p">Setup: {money(calculation.setupCost)}</Text>
                  </InlineStack>
                  <Divider />
                  <InlineStack gap="500">
                    <Text as="p" fontWeight="bold">Total Cost: {money(calculation.totalCost)}</Text>
                    <Text as="p" fontWeight="bold">Unit Cost: {money(calculation.unitCost)}</Text>
                    <Text as="p" fontWeight="bold">Recommended Unit Price: {money(calculation.recommendedUnitPrice)}</Text>
                    <Text as="p" fontWeight="bold">Margin: {percent(calculation.actualMarginPct)}</Text>
                  </InlineStack>
                </BlockStack>
              </Card>

              <InlineStack gap="200">
                <Button variant="primary" onClick={saveRecipe} disabled={!name || !widthIn || !heightIn || !mediaMaterialId}>
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

                  return (
                    <Card key={recipe.id} background="bg-surface-secondary">
                      <BlockStack gap="200">
                        <InlineStack align="space-between">
                          <BlockStack gap="100">
                            <Text as="h3" variant="headingSm">{recipe.name}</Text>
                            <Text as="p" tone="subdued">
                              {recipe.widthIn || 0} in x {recipe.heightIn || 0} in • Qty {recipe.defaultQuantity || 1000}
                            </Text>
                          </BlockStack>
                          <InlineStack gap="100">
                            <Badge>{recipe.productType || "label"}</Badge>
                            {recipe.active === false && <Badge tone="warning">ARCHIVED</Badge>}
                          </InlineStack>
                        </InlineStack>
                        <Text as="p">Media: {media?.name || "Not selected"}</Text>
                        <Text as="p">Machine: {machine?.name || "Not selected"}</Text>
                        <Text as="p">Waste: {recipe.wastePct || 0}% • Target Margin: {recipe.targetMarginPct || 0}%</Text>
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
