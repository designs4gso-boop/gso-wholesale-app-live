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

const machineTypes = [
  { label: "Printer", value: "printer" },
  { label: "Cutter", value: "cutter" },
  { label: "Laminator", value: "laminator" },
  { label: "Press", value: "press" },
  { label: "Other", value: "other" },
];

const inkTypes = [
  { label: "CMYK", value: "cmyk" },
  { label: "White", value: "white" },
  { label: "Gloss", value: "gloss" },
  { label: "Orange", value: "orange" },
  { label: "Red", value: "red" },
  { label: "Green", value: "green" },
  { label: "Primer", value: "primer" },
  { label: "Metallic", value: "metallic" },
  { label: "Other", value: "other" },
];


type DefaultInkSlot = {
  slotNumber: number;
  inkName: string;
  inkType: string;
  cartridgeCost: number;
  cartridgeMl: number;
  mlPerSqft1Pct: number;
  enabled?: boolean;
};

type DefaultMachinePreset = {
  name: string;
  machineType: string;
  maxWidthIn: number;
  costPerHour: number;
  sqftPerHour: number;
  setupWastePct: number;
  allowOverflow: boolean;
  notes: string;
  inkSlots: DefaultInkSlot[];
};

const ROLAND_POUCH_COST = 156.99;
const ROLAND_POUCH_ML = 750;
const MIMAKI_BOTTLE_COST_ESTIMATE = 190;
const MIMAKI_BOTTLE_ML = 1000;
const DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL = 0.0075;
const DEFAULT_WHITE_GLOSS_ML_PER_SQFT_1PCT_PER_CHANNEL = 0.0075;

const gsoDefaultMachinePresets: DefaultMachinePreset[] = [
  {
    // 15F.0K.4B: LG-640 is the shop's actual Roland (13A.7B operational
    // evidence); recovery preset = the owner-approved $8/hr, never the stale $5.
    name: "Roland TrueVIS LG-640",
    machineType: "printer",
    maxWidthIn: 52.9,
    costPerHour: 8,
    sqftPerHour: 150,
    setupWastePct: 10,
    allowOverflow: true,
    notes:
      "GSO default for white/gloss/emboss label work (Mimaki is CMYK ONLY — owner-verified 2026-07-26). Official usable width is about 52.9 in. Uses 750 ml ECO-UV pouches. Defaults should be tuned with VersaWorks / DG Connect actual job logs.",
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
    costPerHour: 8,
    sqftPerHour: 150,
    setupWastePct: 10,
    allowOverflow: false,
    notes:
      "GSO default for standard CMYK work ONLY — the Mimaki never runs white, clear/gloss, spot-gloss, layered-gloss, or raised-gloss pricing (owner-verified 2026-07-26; that work routes to the Roland LG-640). Official max print/cut width is about 53.6 in. Mimaki LUS-170 bottles are 1 liter; cost defaults are estimates and should be replaced with invoice costs.",
    inkSlots: [
      { slotNumber: 1, inkName: "Cyan", inkType: "cmyk", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 2, inkName: "Magenta", inkType: "cmyk", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 3, inkName: "Yellow", inkType: "cmyk", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 4, inkName: "Black", inkType: "cmyk", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 5, inkName: "White", inkType: "white", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_WHITE_GLOSS_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 6, inkName: "White", inkType: "white", cartridgeCost: MIMAKI_BOTTLE_COST_ESTIMATE, cartridgeMl: MIMAKI_BOTTLE_ML, mlPerSqft1Pct: DEFAULT_WHITE_GLOSS_ML_PER_SQFT_1PCT_PER_CHANNEL },
      { slotNumber: 7, inkName: "Unused - gloss routed to Roland", inkType: "other", cartridgeCost: 0, cartridgeMl: 0, mlPerSqft1Pct: 0, enabled: false },
      { slotNumber: 8, inkName: "Unused - gloss routed to Roland", inkType: "other", cartridgeCost: 0, cartridgeMl: 0, mlPerSqft1Pct: 0, enabled: false },
    ],
  },
];

function costPerMl(slot: DefaultInkSlot) {
  return slot.cartridgeMl > 0 ? slot.cartridgeCost / slot.cartridgeMl : 0;
}

async function installDefaultMachinePreset(shop: string, preset: DefaultMachinePreset, overwriteExisting = false) {
  let machine = await db.machine.findFirst({
    where: { shop, name: preset.name },
    include: { inkChannels: true },
  });

  if (!machine) {
    machine = await db.machine.create({
      data: {
        shop,
        name: preset.name,
        machineType: preset.machineType,
        maxWidthIn: preset.maxWidthIn,
        costPerHour: preset.costPerHour,
        sqftPerHour: preset.sqftPerHour,
        setupWastePct: preset.setupWastePct,
        allowOverflow: preset.allowOverflow,
        active: true,
      },
      include: { inkChannels: true },
    });
  } else if (overwriteExisting) {
    machine = await db.machine.update({
      where: { id: machine.id },
      data: {
        machineType: preset.machineType,
        maxWidthIn: preset.maxWidthIn,
        costPerHour: preset.costPerHour,
        sqftPerHour: preset.sqftPerHour,
        setupWastePct: preset.setupWastePct,
        allowOverflow: preset.allowOverflow,
        active: true,
      },
      include: { inkChannels: true },
    });
  }

  const existingSlots = machine.inkChannels || [];

  for (const slot of preset.inkSlots) {
    const existingSlot = existingSlots.find((ink: any) => ink.slotNumber === slot.slotNumber);
    const shouldFillExisting =
      overwriteExisting ||
      !existingSlot?.inkName ||
      Number(existingSlot?.cartridgeCost || 0) === 0 ||
      Number(existingSlot?.cartridgeMl || 0) === 0;

    const slotData = {
      shop,
      machineId: machine.id,
      slotNumber: slot.slotNumber,
      inkName: slot.inkName,
      inkType: slot.inkType,
      cartridgeCost: slot.cartridgeCost,
      cartridgeMl: slot.cartridgeMl,
      costPerMl: costPerMl(slot),
      mlPerSqft1Pct: slot.mlPerSqft1Pct,
      enabled: slot.enabled !== false,
    };

    if (!existingSlot) {
      await db.machineInkChannel.create({ data: slotData });
    } else if (shouldFillExisting) {
      await db.machineInkChannel.update({ where: { id: existingSlot.id }, data: slotData });
    }
  }
}

async function installGsoDefaultMachines(shop: string, overwriteExisting = false) {
  for (const preset of gsoDefaultMachinePresets) {
    await installDefaultMachinePreset(shop, preset, overwriteExisting);
  }
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const machineCount = await db.machine.count({ where: { shop } });
  if (machineCount === 0) {
    await installGsoDefaultMachines(shop, false);
  }

  const machines = await db.machine.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    include: { inkChannels: { orderBy: { slotNumber: "asc" } } },
  });

  return Response.json({ machines });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const payload = await request.json();

  if (payload.intent === "saveMachine") {
    if (payload.id) {
      await db.machine.update({
        where: { id: payload.id },
        data: {
          name: payload.name,
          machineType: payload.machineType || "printer",
          maxWidthIn: payload.maxWidthIn ? Number(payload.maxWidthIn) : null,
          costPerHour: Number(payload.costPerHour) || 0,
          sqftPerHour: Number(payload.sqftPerHour) || 0,
          setupWastePct: Number(payload.setupWastePct) || 0,
          allowOverflow: Boolean(payload.allowOverflow),
          active: true,
        },
      });
    } else {
      const machine = await db.machine.create({
        data: {
          shop,
          name: payload.name,
          machineType: payload.machineType || "printer",
          maxWidthIn: payload.maxWidthIn ? Number(payload.maxWidthIn) : null,
          costPerHour: Number(payload.costPerHour) || 0,
          sqftPerHour: Number(payload.sqftPerHour) || 0,
          setupWastePct: Number(payload.setupWastePct) || 0,
          allowOverflow: Boolean(payload.allowOverflow),
          active: true,
        },
      });

      for (let i = 1; i <= 8; i++) {
        await db.machineInkChannel.create({
          data: {
            shop,
            machineId: machine.id,
            slotNumber: i,
            inkName: "",
            inkType: "cmyk",
            enabled: true,
          },
        });
      }
    }
  }

  if (payload.intent === "deleteMachine") {
    await db.machine.update({
      where: { id: payload.id },
      data: { active: false },
    });
  }

  if (payload.intent === "restoreMachine") {
  await db.machine.update({
    where: { id: payload.id },
    data: { active: true },
  });
}

if (payload.intent === "permanentDeleteMachine") {
  await db.machineInkChannel.deleteMany({
    where: { machineId: payload.id },
  });

  await db.machine.delete({
    where: { id: payload.id },
  });
}

  if (payload.intent === "updateSlot") {
    const cartridgeCost = Number(payload.cartridgeCost || 0);
    const cartridgeMl = Number(payload.cartridgeMl || 0);
    const costPerMl = cartridgeMl > 0 ? cartridgeCost / cartridgeMl : 0;

    await db.machineInkChannel.update({
      where: { id: payload.id },
      data: {
        inkName: payload.inkName || "",
        inkType: payload.inkType || "cmyk",
        cartridgeCost,
        cartridgeMl,
        costPerMl,
        mlPerSqft1Pct: Number(payload.mlPerSqft1Pct || 0),
        enabled: true,
      },
    });
  }

  if (payload.intent === "clearSlot") {
    await db.machineInkChannel.update({
      where: { id: payload.id },
      data: {
        inkName: "",
        inkType: "cmyk",
        cartridgeCost: 0,
        cartridgeMl: 0,
        costPerMl: 0,
        mlPerSqft1Pct: 0,
        enabled: true,
      },
    });
  }

  if (payload.intent === "installGsoDefaults") {
    await installGsoDefaultMachines(shop, Boolean(payload.overwriteExisting));
  }

  const machines = await db.machine.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    include: { inkChannels: { orderBy: { slotNumber: "asc" } } },
  });

  return Response.json({ ok: true, machines });
}

export default function MachinesPage() {
  const navigate = useNavigate();
  const loaderData = useLoaderData<typeof loader>() as any;
  const fetcher = useFetcher<any>();

  const [machines, setMachines] = useState<any[]>(loaderData.machines || []);
  const [slotEdits, setSlotEdits] = useState<any>({});

  const [editingMachineId, setEditingMachineId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [machineType, setMachineType] = useState("printer");
  const [maxWidthIn, setMaxWidthIn] = useState("");
  const [costPerHour, setCostPerHour] = useState("");
  const [sqftPerHour, setSqftPerHour] = useState("");
  const [setupWastePct, setSetupWastePct] = useState("");
  const [allowOverflow, setAllowOverflow] = useState("false");

  useEffect(() => {
    if (fetcher.data?.machines) setMachines(fetcher.data.machines);
  }, [fetcher.data]);

  function resetMachineForm() {
    setEditingMachineId(null);
    setName("");
    setMachineType("printer");
    setMaxWidthIn("");
    setCostPerHour("");
    setSqftPerHour("");
    setSetupWastePct("");
    setAllowOverflow("false");
  }

  function saveMachine() {
    fetcher.submit(
      {
        intent: "saveMachine",
        id: editingMachineId,
        name,
        machineType,
        maxWidthIn,
        costPerHour,
        sqftPerHour,
        setupWastePct,
        allowOverflow: allowOverflow === "true",
      },
      { method: "post", encType: "application/json" }
    );

    resetMachineForm();
  }

  function editMachine(machine: any) {
    setEditingMachineId(machine.id);
    setName(machine.name || "");
    setMachineType(machine.machineType || "printer");
    setMaxWidthIn(machine.maxWidthIn ? String(machine.maxWidthIn) : "");
    setCostPerHour(String(machine.costPerHour || ""));
    setSqftPerHour(String(machine.sqftPerHour || ""));
    setSetupWastePct(String(machine.setupWastePct || ""));
    setAllowOverflow(machine.allowOverflow ? "true" : "false");
  }

  function deleteMachine(id: string) {
    fetcher.submit(
      { intent: "deleteMachine", id },
      { method: "post", encType: "application/json" }
    );
  }

  function restoreMachine(id: string) {
  fetcher.submit(
    { intent: "restoreMachine", id },
    { method: "post", encType: "application/json" }
  );
}

function permanentDeleteMachine(id: string) {
  if (!confirm("Permanently delete this machine and all ink slots?")) return;

  fetcher.submit(
    { intent: "permanentDeleteMachine", id },
    { method: "post", encType: "application/json" }
  );
}

  function getSlotValue(ink: any, field: string) {
    return slotEdits[ink.id]?.[field] ?? String(ink[field] || "");
  }

  function updateSlotEdit(id: string, field: string, value: string) {
    setSlotEdits((prev: any) => ({
      ...prev,
      [id]: { ...prev[id], [field]: value },
    }));
  }

  function saveSlot(ink: any) {
    fetcher.submit(
      {
        intent: "updateSlot",
        id: ink.id,
        inkName: slotEdits[ink.id]?.inkName ?? ink.inkName,
        inkType: slotEdits[ink.id]?.inkType ?? ink.inkType,
        cartridgeCost: slotEdits[ink.id]?.cartridgeCost ?? ink.cartridgeCost,
        cartridgeMl: slotEdits[ink.id]?.cartridgeMl ?? ink.cartridgeMl,
        mlPerSqft1Pct: slotEdits[ink.id]?.mlPerSqft1Pct ?? ink.mlPerSqft1Pct,
      },
      { method: "post", encType: "application/json" }
    );
  }

  function clearSlot(ink: any) {
    fetcher.submit(
      { intent: "clearSlot", id: ink.id },
      { method: "post", encType: "application/json" }
    );
  }

  function installGsoDefaults(overwriteExisting = false) {
    if (
      overwriteExisting &&
      !confirm("Refresh Roland and Mimaki default values? This can overwrite default printer slots you already edited.")
    ) {
      return;
    }

    fetcher.submit(
      { intent: "installGsoDefaults", overwriteExisting },
      { method: "post", encType: "application/json" }
    );
  }

  return (
    <Page
      title="Machine Center"
      subtitle="Printers, 8 ink slots, cartridge costs, cost per ML, coverage rates, and overflow routing."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{ content: "New Machine", onAction: resetMachineForm }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">GSO Default Printer Profiles</Text>
                  <Text as="p" tone="subdued">
                    Install the Roland LG-640 and Mimaki UCJV300-130 with researched starting widths, speeds, ink slots, cartridge sizes, and coverage defaults ($8/hr owner recovery rate; Mimaki is CMYK only). Tune these values with your real invoices and print logs.
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  <Button onClick={() => installGsoDefaults(false)}>Install Missing Defaults</Button>
                  <Button tone="critical" onClick={() => installGsoDefaults(true)}>Refresh Defaults</Button>
                </InlineStack>
              </InlineStack>
              <Text as="p" tone="subdued">
                Roland is set up for CMYK + white + gloss/emboss. Mimaki is set up for CMYK + white, with gloss routed to Roland by default.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                {editingMachineId ? "Edit Machine" : "Add Machine"}
              </Text>

              <InlineStack gap="300">
                <TextField label="Machine Name" value={name} onChange={setName} autoComplete="off" />
                <Select label="Machine Type" value={machineType} onChange={setMachineType} options={machineTypes} />
                <TextField label="Max Width Inches" value={maxWidthIn} onChange={setMaxWidthIn} autoComplete="off" />
              </InlineStack>

              <InlineStack gap="300">
                <TextField label="Machine Cost Per Hour" prefix="$" value={costPerHour} onChange={setCostPerHour} autoComplete="off" />
                <TextField label="Sq Ft Per Hour" value={sqftPerHour} onChange={setSqftPerHour} autoComplete="off" />
                <TextField label="Setup Waste %" suffix="%" value={setupWastePct} onChange={setSetupWastePct} autoComplete="off" />
              </InlineStack>

              <Select
                label="Allow Overflow Jobs"
                value={allowOverflow}
                onChange={setAllowOverflow}
                options={[
                  { label: "No", value: "false" },
                  { label: "Yes", value: "true" },
                ]}
              />

              <InlineStack gap="300">
                <Button variant="primary" onClick={saveMachine}>
                  {editingMachineId ? "Update Machine" : "Save Machine"}
                </Button>
                <Button onClick={resetMachineForm}>Clear</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Machines</Text>
              <Divider />

              {machines.length === 0 ? (
                <Text as="p" tone="subdued">No machines yet.</Text>
              ) : (
                machines.map((machine) => (
                  <Card key={machine.id}>
                    <BlockStack gap="300">
                      <InlineStack align="space-between">
                        <Text as="p" fontWeight="bold">{machine.name}</Text>
                        <InlineStack gap="200">
                          <Badge>{machine.machineType}</Badge>
                          {machine.allowOverflow && <Badge tone="success">Overflow Allowed</Badge>}
                          {!machine.active && <Badge tone="warning">Inactive</Badge>}
                        </InlineStack>
                      </InlineStack>

                      <Text as="p">
                        Max Width: {machine.maxWidthIn || "N/A"} in | Cost/hr: ${Number(machine.costPerHour || 0).toFixed(2)} | Sqft/hr: {Number(machine.sqftPerHour || 0).toFixed(2)}
                      </Text>

                      <Text as="p">Setup Waste: {Number(machine.setupWastePct || 0).toFixed(2)}%</Text>

                      {gsoDefaultMachinePresets.find((preset) => preset.name === machine.name)?.notes && (
                        <Text as="p" tone="subdued">
                          {gsoDefaultMachinePresets.find((preset) => preset.name === machine.name)?.notes}
                        </Text>
                      )}

                      <InlineStack gap="200">
                        <Button onClick={() => editMachine(machine)}>Edit Machine</Button>

                        {machine.active ? (
                            <Button tone="critical" onClick={() => deleteMachine(machine.id)}>
                            Archive Machine
                            </Button>
                        ) : (
                            <Button onClick={() => restoreMachine(machine.id)}>
                            Restore Machine
                            </Button>
                        )}

                        <Button tone="critical" onClick={() => permanentDeleteMachine(machine.id)}>
                            Permanent Delete
                        </Button>
                        </InlineStack>

                      <Divider />

                      <Text as="p" fontWeight="bold">Ink Slots</Text>

                      <BlockStack gap="300">
                        {machine.inkChannels?.map((ink: any) => {
                          const cartridgeCost = Number(getSlotValue(ink, "cartridgeCost")) || 0;
                          const cartridgeMl = Number(getSlotValue(ink, "cartridgeMl")) || 0;
                          const liveCostPerMl = cartridgeMl > 0 ? cartridgeCost / cartridgeMl : 0;

                          return (
                            <Card key={ink.id}>
                              <BlockStack gap="300">
                                <InlineStack align="space-between">
                                  <Text as="p" fontWeight="bold">Slot {ink.slotNumber}</Text>
                                  <InlineStack gap="200">
                                    <Badge>{slotEdits[ink.id]?.inkType ?? ink.inkType}</Badge>
                                    {ink.enabled === false && <Badge tone="warning">Disabled</Badge>}
                                  </InlineStack>
                                </InlineStack>

                                <InlineStack gap="300">
                                  <TextField
                                    label="Ink Name"
                                    autoComplete="off"
                                    value={slotEdits[ink.id]?.inkName ?? ink.inkName ?? ""}
                                    onChange={(value) => updateSlotEdit(ink.id, "inkName", value)}
                                  />

                                  <Select
                                    label="Ink Type"
                                    options={inkTypes}
                                    value={slotEdits[ink.id]?.inkType ?? ink.inkType}
                                    onChange={(value) => updateSlotEdit(ink.id, "inkType", value)}
                                  />
                                </InlineStack>

                                <InlineStack gap="300">
                                  <TextField
                                    label="Bottle/Cartridge Cost"
                                    prefix="$"
                                    autoComplete="off"
                                    value={getSlotValue(ink, "cartridgeCost")}
                                    onChange={(value) => updateSlotEdit(ink.id, "cartridgeCost", value)}
                                  />

                                  <TextField
                                    label="Bottle/Cartridge ML"
                                    autoComplete="off"
                                    value={getSlotValue(ink, "cartridgeMl")}
                                    onChange={(value) => updateSlotEdit(ink.id, "cartridgeMl", value)}
                                  />

                                  <TextField
                                    label="ML Per SqFt @ 1% Coverage"
                                    autoComplete="off"
                                    value={getSlotValue(ink, "mlPerSqft1Pct")}
                                    onChange={(value) => updateSlotEdit(ink.id, "mlPerSqft1Pct", value)}
                                  />
                                </InlineStack>

                                <Text as="p">
                                  Live Cost Per ML: ${liveCostPerMl.toFixed(4)}
                                </Text>

                                <InlineStack gap="200">
                                  <Button onClick={() => saveSlot(ink)}>Save Slot</Button>
                                  <Button tone="critical" onClick={() => clearSlot(ink)}>Clear Slot</Button>
                                </InlineStack>
                              </BlockStack>
                            </Card>
                          );
                        })}
                      </BlockStack>
                    </BlockStack>
                  </Card>
                ))
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}