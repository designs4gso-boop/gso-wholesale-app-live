import { OWNER_STANDARDS } from "../lib/owner-standards";
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

// 15G.2: seed values reconciled to the canonical ink authority
// (app/lib/ink-rates-shared.ts — $149/750ml Roland, $176/1000ml Mimaki) so
// fresh installs match quote pricing and actual-cost reporting. Channel $/ml
// is reference data only: pricing paths read the canonical rates directly.
const ROLAND_POUCH_COST = 149;
const ROLAND_POUCH_ML = 750;
const MIMAKI_BOTTLE_COST_ESTIMATE = 176;
const MIMAKI_BOTTLE_ML = 1000;
const DEFAULT_CMYK_ML_PER_SQFT_1PCT_PER_CHANNEL = 0.0075;
const DEFAULT_WHITE_GLOSS_ML_PER_SQFT_1PCT_PER_CHANNEL = 0.0075;

const gsoDefaultMachinePresets: DefaultMachinePreset[] = [
  {
    // 15F.0K.4B: LG-640 is the shop's actual Roland (13A.7B operational
    // evidence); recovery preset = the owner-approved $5/hr (2026-10-07, retail
    // replacement basis) — the same rate as the Mimaki.
    name: "Roland TrueVIS LG-640",
    machineType: "printer",
    maxWidthIn: 52.9,
    costPerHour: OWNER_STANDARDS.machineRecoveryPerHour.value,
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
    costPerHour: OWNER_STANDARDS.machineRecoveryPerHour.value,
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
      // OWNER DECISION 2026-10-07: the Mimaki is CMYK-only for ERP routing — white (and gloss) run on the Roland only. No Mimaki white channel is exposed.
      { slotNumber: 5, inkName: "Unused - white routed to Roland", inkType: "other", cartridgeCost: 0, cartridgeMl: 0, mlPerSqft1Pct: 0, enabled: false },
      { slotNumber: 6, inkName: "Unused - white routed to Roland", inkType: "other", cartridgeCost: 0, cartridgeMl: 0, mlPerSqft1Pct: 0, enabled: false },
      { slotNumber: 7, inkName: "Unused - gloss routed to Roland", inkType: "other", cartridgeCost: 0, cartridgeMl: 0, mlPerSqft1Pct: 0, enabled: false },
      { slotNumber: 8, inkName: "Unused - gloss routed to Roland", inkType: "other", cartridgeCost: 0, cartridgeMl: 0, mlPerSqft1Pct: 0, enabled: false },
    ],
  },
];

function costPerMl(slot: DefaultInkSlot) {
  return slot.cartridgeMl > 0 ? slot.cartridgeCost / slot.cartridgeMl : 0;
}

// Display-only helpers: readable labels for stored type keys, and detection of
// slots/machines still sitting on the seeded GSO default numbers (which the
// preset notes themselves describe as estimates to be tuned from invoices).
function machineTypeLabel(value: string | null | undefined) {
  return machineTypes.find((option) => option.value === value)?.label || String(value || "Other");
}

function inkTypeLabel(value: string | null | undefined) {
  return inkTypes.find((option) => option.value === value)?.label || String(value || "Other");
}

function presetForMachine(machine: any) {
  return gsoDefaultMachinePresets.find((preset) => preset.name === machine?.name) || null;
}

function machineUsesDefaultValues(machine: any) {
  const preset = presetForMachine(machine);
  if (!preset) return false;
  return (
    Number(machine.costPerHour) === preset.costPerHour &&
    Number(machine.sqftPerHour) === preset.sqftPerHour &&
    Number(machine.setupWastePct) === preset.setupWastePct
  );
}

function slotUsesDefaultValues(machine: any, ink: any) {
  const preset = presetForMachine(machine);
  const slot = preset?.inkSlots.find((row) => row.slotNumber === ink.slotNumber);
  if (!slot || !ink.inkName) return false;
  return Number(ink.cartridgeCost) === slot.cartridgeCost && Number(ink.cartridgeMl) === slot.cartridgeMl;
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

  // 15G.1: page loads are read-only — no auto-seeding, no silent repair of
  // zeroed ink-channel costs. Creating/refreshing the GSO defaults is the
  // explicit "Install Missing Defaults" / "Refresh Defaults" action only.
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
      const result = await updateOwnedRecord(db.machine, shop, payload.id, {
        name: payload.name,
        machineType: payload.machineType || "printer",
        maxWidthIn: payload.maxWidthIn ? Number(payload.maxWidthIn) : null,
        costPerHour: Number(payload.costPerHour) || 0,
        sqftPerHour: Number(payload.sqftPerHour) || 0,
        setupWastePct: Number(payload.setupWastePct) || 0,
        allowOverflow: Boolean(payload.allowOverflow),
        active: true,
      });
      if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });
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
    const result = await updateOwnedRecord(db.machine, shop, payload.id, { active: false });
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });
  }

  if (payload.intent === "restoreMachine") {
    const result = await updateOwnedRecord(db.machine, shop, payload.id, { active: true });
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });
  }

  if (payload.intent === "permanentDeleteMachine") {
    // 15G.1: server-enforced confirmation + shop ownership + one transaction.
    if (payload.confirmPermanentDelete !== true) {
      return Response.json({ ok: false, error: "Permanent delete requires explicit confirmation." }, { status: 400 });
    }
    const owned = await db.machine.findFirst({ where: { id: payload.id, shop }, select: { id: true } });
    if (!owned) return Response.json({ ok: false, error: "Machine not found for this shop." }, { status: 404 });
    await db.$transaction([
      db.machineInkChannel.deleteMany({ where: { machineId: owned.id, shop } }),
      db.machine.deleteMany({ where: { id: owned.id, shop } }),
    ]);
  }

  if (payload.intent === "updateSlot") {
    const cartridgeCost = Number(payload.cartridgeCost || 0);
    const cartridgeMl = Number(payload.cartridgeMl || 0);
    const costPerMl = cartridgeMl > 0 ? cartridgeCost / cartridgeMl : 0;

    const result = await updateOwnedRecord(db.machineInkChannel, shop, payload.id, {
      inkName: payload.inkName || "",
      inkType: payload.inkType || "cmyk",
      cartridgeCost,
      cartridgeMl,
      costPerMl,
      mlPerSqft1Pct: Number(payload.mlPerSqft1Pct || 0),
      enabled: true,
    });
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });
  }

  if (payload.intent === "clearSlot") {
    const result = await updateOwnedRecord(db.machineInkChannel, shop, payload.id, {
      inkName: "",
      inkType: "cmyk",
      cartridgeCost: 0,
      cartridgeMl: 0,
      costPerMl: 0,
      mlPerSqft1Pct: 0,
      enabled: true,
    });
    if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: result.status });
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
    // HOTFIX 2026-10-08: the editor renders INLINE inside the machine's own card
    // (it used to fill the "Add Machine" form at the top of the page with no
    // visible change next to the button). Bring it into view as well.
    if (typeof document !== "undefined") {
      requestAnimationFrame(() => document.getElementById(`machine-editor-${machine.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
    }
  }

  /** Machine-level fields only (name, type, width, hourly cost, throughput, setup waste, overflow). Ink slots keep their own controls. */
  function machineFields() {
    return (
      <>
        <InlineStack gap="300">
          <TextField label="Machine name" value={name} onChange={setName} autoComplete="off" helpText="Use the model name, e.g. Roland TrueVIS LG-640." />
          <Select label="Machine type" value={machineType} onChange={setMachineType} options={machineTypes} />
          <TextField label="Max print width (in)" suffix="in" value={maxWidthIn} onChange={setMaxWidthIn} autoComplete="off" />
        </InlineStack>

        <InlineStack gap="300">
          <TextField label="Machine cost ($ per hour)" prefix="$" suffix="/ hr" value={costPerHour} onChange={setCostPerHour} autoComplete="off" helpText={`Owner recovery rate for running this machine. Owner standard: $${OWNER_STANDARDS.machineRecoveryPerHour.value.toFixed(2)}/hr (approved 2026-10-07) — pricing and actual costs use the standard; this record is shown on reports.`} />
          <TextField label="Throughput (sqft per hour)" suffix="sqft / hr" value={sqftPerHour} onChange={setSqftPerHour} autoComplete="off" />
          <TextField label="Setup waste (%)" suffix="%" value={setupWastePct} onChange={setSetupWastePct} autoComplete="off" helpText="Extra media burned per job for setup and test prints." />
        </InlineStack>

        <Select
          label="Accept overflow jobs"
          helpText="Yes = jobs can be routed here when their usual machine is busy."
          value={allowOverflow}
          onChange={setAllowOverflow}
          options={[
            { label: "No", value: "false" },
            { label: "Yes", value: "true" },
          ]}
        />
      </>
    );
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
    { intent: "permanentDeleteMachine", id, confirmPermanentDelete: true },
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
    if (!confirm(`Clear ink slot ${ink.slotNumber}? This erases the ink name, cartridge cost and size for this slot.`)) return;
    fetcher.submit(
      { intent: "clearSlot", id: ink.id },
      { method: "post", encType: "application/json" }
    );
  }

  function installGsoDefaults(overwriteExisting = false) {
    if (
      overwriteExisting &&
      !confirm("Reset the Roland and Mimaki profiles to the GSO default values? This overwrites widths, rates and ink slot costs you may have edited on those two printers.")
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
      subtitle="Each printer's hourly cost, speed, print width, and the cost of every ink in its slots. Recipes and quotes read these numbers."
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{ content: "New Machine", onAction: resetMachineForm }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">GSO default printer profiles</Text>
                  <Text as="p" tone="subdued">
                    Install the Roland LG-640 and Mimaki UCJV300-130 with starting widths, speeds, ink slots, cartridge sizes, and coverage defaults ($5 per hour owner recovery rate, approved 2026-10-07; Mimaki is CMYK only). Default numbers are estimates: replace them with your real invoices and print logs.
                  </Text>
                </BlockStack>
                <InlineStack gap="200">
                  <Button onClick={() => installGsoDefaults(false)}>Install missing defaults</Button>
                  <Button tone="critical" onClick={() => installGsoDefaults(true)}>Reset defaults (overwrites edits)</Button>
                </InlineStack>
              </InlineStack>
              <Text as="p" tone="subdued">
                Roland is set up for CMYK + white + gloss/emboss. The Mimaki runs CMYK only — white, clear/gloss and spot-gloss work is routed to the Roland. "Install missing defaults" never touches a printer that already exists.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Add Machine</Text>
              {editingMachineId ? (
                <InlineStack gap="300" blockAlign="center">
                  <Text as="p" tone="subdued">Editing {name || "a machine"} — the edit form is open inside that machine's card below.</Text>
                  <Button onClick={resetMachineForm}>Cancel edit</Button>
                </InlineStack>
              ) : (
                <>
                  {machineFields()}
                  <InlineStack gap="300">
                    <Button variant="primary" onClick={saveMachine}>Save machine</Button>
                    <Button onClick={resetMachineForm}>Clear</Button>
                  </InlineStack>
                </>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <BlockStack gap="050">
                <Text as="h2" variant="headingMd">Machines</Text>
                <Text as="p" tone="subdued">
                  {machines.length} machine(s): {machines.filter((machine) => machine.active).length} active, {machines.filter((machine) => !machine.active).length} inactive.
                </Text>
              </BlockStack>
              <Divider />

              {machines.length === 0 ? (
                <BlockStack gap="100">
                  <Text as="p" fontWeight="bold">No machines yet.</Text>
                  <Text as="p" tone="subdued">
                    Use "Install missing defaults" above to create the GSO Roland LG-640 and Mimaki UCJV300-130 profiles, or add a machine with the form. Nothing is created automatically.
                  </Text>
                </BlockStack>
              ) : (
                machines.map((machine) => {
                  const hourlyRateMissing = Number(machine.costPerHour || 0) <= 0;
                  const usingDefaults = machineUsesDefaultValues(machine);
                  const inkChannels = machine.inkChannels || [];

                  return (
                  <Card key={machine.id}>
                    <BlockStack gap="300">
                      <InlineStack align="space-between">
                        <Text as="p" fontWeight="bold">{machine.name}</Text>
                        <InlineStack gap="200" wrap>
                          <Badge>{machineTypeLabel(machine.machineType)}</Badge>
                          {machine.allowOverflow && <Badge tone="info">Accepts overflow</Badge>}
                          {hourlyRateMissing && <Badge tone="critical">Hourly rate missing</Badge>}
                          {!hourlyRateMissing && usingDefaults && <Badge tone="warning">Default values (estimated)</Badge>}
                          {!machine.active && <Badge>Inactive</Badge>}
                        </InlineStack>
                      </InlineStack>

                      <Text as="p">
                        Max print width: {machine.maxWidthIn ? `${machine.maxWidthIn} in` : "not set"}
                        {" | Machine cost: "}{hourlyRateMissing ? "not set" : `$${Number(machine.costPerHour).toFixed(2)} per hour`}
                        {" | Throughput: "}{Number(machine.sqftPerHour || 0) > 0 ? `${Number(machine.sqftPerHour).toFixed(2)} sqft per hour` : "not set"}
                        {" | Setup waste: "}{Number(machine.setupWastePct || 0).toFixed(2)}%
                      </Text>

                      {editingMachineId === machine.id ? (
                        <div id={`machine-editor-${machine.id}`} style={{ border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 10, padding: 12 }}>
                          <BlockStack gap="300">
                            <InlineStack align="space-between" blockAlign="center">
                              <Text as="h3" variant="headingSm">Edit machine — {machine.name}</Text>
                              <Badge tone="info">Editing</Badge>
                            </InlineStack>
                            {machineFields()}
                            <InlineStack gap="300">
                              <Button variant="primary" onClick={saveMachine}>Update machine</Button>
                              <Button onClick={resetMachineForm}>Cancel</Button>
                            </InlineStack>
                            <Text as="p" tone="subdued">Ink slots are edited with their own controls below; they are not changed by this form.</Text>
                          </BlockStack>
                        </div>
                      ) : null}

                      {presetForMachine(machine)?.notes && (
                        <details>
                          <summary style={{ cursor: "pointer", fontSize: 12, color: "#6d7175" }}>GSO default profile notes</summary>
                          <Text as="p" tone="subdued">{presetForMachine(machine)?.notes}</Text>
                        </details>
                      )}

                      <InlineStack gap="200">
                        <Button onClick={() => editMachine(machine)}>Edit machine</Button>

                        {machine.active ? (
                            <Button tone="critical" onClick={() => deleteMachine(machine.id)}>
                            Archive machine (hide, keeps slots)
                            </Button>
                        ) : (
                            <Button onClick={() => restoreMachine(machine.id)}>
                            Restore machine
                            </Button>
                        )}

                        <Button tone="critical" onClick={() => permanentDeleteMachine(machine.id)}>
                            Delete permanently (with ink slots)
                        </Button>
                        </InlineStack>

                      <Divider />

                      <BlockStack gap="050">
                        <Text as="p" fontWeight="bold">Ink slots</Text>
                        <Text as="p" tone="subdued">Cost per ml is calculated from cartridge cost and size. Ink use per sqft at 1% coverage drives ink cost in recipes.</Text>
                      </BlockStack>

                      {inkChannels.length === 0 ? (
                        <Text as="p" tone="subdued">No ink slots recorded for this machine.</Text>
                      ) : null}

                      <BlockStack gap="300">
                        {inkChannels.map((ink: any) => {
                          const cartridgeCost = Number(getSlotValue(ink, "cartridgeCost")) || 0;
                          const cartridgeMl = Number(getSlotValue(ink, "cartridgeMl")) || 0;
                          const liveCostPerMl = cartridgeMl > 0 ? cartridgeCost / cartridgeMl : 0;
                          const slotEmpty = !String(ink.inkName || "").trim();
                          const slotCostMissing = !slotEmpty && ink.enabled !== false && (Number(ink.cartridgeCost || 0) <= 0 || Number(ink.cartridgeMl || 0) <= 0);
                          const slotDefaults = !slotCostMissing && slotUsesDefaultValues(machine, ink);

                          return (
                            <Card key={ink.id}>
                              <BlockStack gap="300">
                                <InlineStack align="space-between">
                                  <Text as="p" fontWeight="bold">Slot {ink.slotNumber}{ink.inkName ? ` — ${ink.inkName}` : ""}</Text>
                                  <InlineStack gap="200" wrap>
                                    <Badge>{inkTypeLabel(slotEdits[ink.id]?.inkType ?? ink.inkType)}</Badge>
                                    {ink.enabled === false && <Badge>Disabled</Badge>}
                                    {slotEmpty && ink.enabled !== false && <Badge>Empty slot</Badge>}
                                    {slotCostMissing && <Badge tone="critical">Ink cost missing</Badge>}
                                    {slotDefaults && <Badge tone="warning">Default cost (estimated)</Badge>}
                                  </InlineStack>
                                </InlineStack>

                                <InlineStack gap="300">
                                  <TextField
                                    label="Ink name"
                                    autoComplete="off"
                                    value={slotEdits[ink.id]?.inkName ?? ink.inkName ?? ""}
                                    onChange={(value) => updateSlotEdit(ink.id, "inkName", value)}
                                  />

                                  <Select
                                    label="Ink type"
                                    options={inkTypes}
                                    value={slotEdits[ink.id]?.inkType ?? ink.inkType}
                                    onChange={(value) => updateSlotEdit(ink.id, "inkType", value)}
                                  />
                                </InlineStack>

                                <InlineStack gap="300">
                                  <TextField
                                    label="Cartridge / bottle cost ($)"
                                    prefix="$"
                                    autoComplete="off"
                                    value={getSlotValue(ink, "cartridgeCost")}
                                    onChange={(value) => updateSlotEdit(ink.id, "cartridgeCost", value)}
                                  />

                                  <TextField
                                    label="Cartridge / bottle size (ml)"
                                    suffix="ml"
                                    autoComplete="off"
                                    value={getSlotValue(ink, "cartridgeMl")}
                                    onChange={(value) => updateSlotEdit(ink.id, "cartridgeMl", value)}
                                  />

                                  <TextField
                                    label="Ink use (ml per sqft at 1% coverage)"
                                    suffix="ml"
                                    autoComplete="off"
                                    value={getSlotValue(ink, "mlPerSqft1Pct")}
                                    onChange={(value) => updateSlotEdit(ink.id, "mlPerSqft1Pct", value)}
                                  />
                                </InlineStack>

                                <Text as="p">
                                  Cost per ml: {cartridgeMl > 0 ? `$${liveCostPerMl.toFixed(4)} per ml` : "not available until cost and size are entered"}
                                </Text>

                                <InlineStack gap="200">
                                  <Button onClick={() => saveSlot(ink)}>Save slot</Button>
                                  <Button tone="critical" onClick={() => clearSlot(ink)}>Clear slot (erase ink and cost)</Button>
                                </InlineStack>
                              </BlockStack>
                            </Card>
                          );
                        })}
                      </BlockStack>
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