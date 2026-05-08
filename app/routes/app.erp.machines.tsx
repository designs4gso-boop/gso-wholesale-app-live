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

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);

  const machines = await db.machine.findMany({
    where: { shop: session.shop },
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

                      <InlineStack gap="200">
                        <Button onClick={() => editMachine(machine)}>Edit Machine</Button>
                        {machine.active && (
                          <Button tone="critical" onClick={() => deleteMachine(machine.id)}>
                            Deactivate Machine
                          </Button>
                        )}
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
                                  <Badge>{slotEdits[ink.id]?.inkType ?? ink.inkType}</Badge>
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