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
    include: {
      inkChannels: {
        orderBy: { slotNumber: "asc" },
      },
    },
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
          active: payload.active !== false,
        },
      });
    } else {
      await db.machine.create({
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
    }
  }

  if (payload.intent === "deleteMachine") {
    await db.machine.update({
      where: { id: payload.id },
      data: { active: false },
    });
  }

  if (payload.intent === "saveInkChannel") {
    if (payload.id) {
      await db.machineInkChannel.update({
        where: { id: payload.id },
        data: {
          slotNumber: Number(payload.slotNumber) || 1,
          inkName: payload.inkName,
          inkType: payload.inkType,
          costPerMl: Number(payload.costPerMl) || 0,
          mlPerSqft100: Number(payload.mlPerSqft100) || 0,
          enabled: payload.enabled !== false,
        },
      });
    } else {
      await db.machineInkChannel.create({
        data: {
          shop,
          machineId: payload.machineId,
          slotNumber: Number(payload.slotNumber) || 1,
          inkName: payload.inkName,
          inkType: payload.inkType,
          costPerMl: Number(payload.costPerMl) || 0,
          mlPerSqft100: Number(payload.mlPerSqft100) || 0,
          enabled: true,
        },
      });
    }
  }

  if (payload.intent === "deleteInkChannel") {
    await db.machineInkChannel.update({
      where: { id: payload.id },
      data: { enabled: false },
    });
  }

  const machines = await db.machine.findMany({
    where: { shop },
    orderBy: { updatedAt: "desc" },
    include: {
      inkChannels: {
        orderBy: { slotNumber: "asc" },
      },
    },
  });

  return Response.json({ ok: true, machines });
}

export default function MachinesPage() {
  const navigate = useNavigate();
  const loaderData = useLoaderData<typeof loader>() as any;
  const fetcher = useFetcher<any>();

  const [machines, setMachines] = useState<any[]>(loaderData.machines || []);

  const [editingMachineId, setEditingMachineId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [machineType, setMachineType] = useState("printer");
  const [maxWidthIn, setMaxWidthIn] = useState("");
  const [costPerHour, setCostPerHour] = useState("");
  const [sqftPerHour, setSqftPerHour] = useState("");
  const [setupWastePct, setSetupWastePct] = useState("");
  const [allowOverflow, setAllowOverflow] = useState("false");

  const [editingInkId, setEditingInkId] = useState<string | null>(null);
  const [machineId, setMachineId] = useState("");
  const [slotNumber, setSlotNumber] = useState("1");
  const [inkName, setInkName] = useState("");
  const [inkType, setInkType] = useState("cmyk");
  const [costPerMl, setCostPerMl] = useState("");
  const [mlPerSqft100, setMlPerSqft100] = useState("");

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

  function resetInkForm() {
    setEditingInkId(null);
    setMachineId("");
    setSlotNumber("1");
    setInkName("");
    setInkType("cmyk");
    setCostPerMl("");
    setMlPerSqft100("");
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

  function saveInkChannel() {
    fetcher.submit(
      {
        intent: "saveInkChannel",
        id: editingInkId,
        machineId,
        slotNumber,
        inkName,
        inkType,
        costPerMl,
        mlPerSqft100,
      },
      { method: "post", encType: "application/json" }
    );

    resetInkForm();
  }

  function editInkChannel(machine: any, ink: any) {
    setEditingInkId(ink.id);
    setMachineId(machine.id);
    setSlotNumber(String(ink.slotNumber || 1));
    setInkName(ink.inkName || "");
    setInkType(ink.inkType || "cmyk");
    setCostPerMl(String(ink.costPerMl || ""));
    setMlPerSqft100(String(ink.mlPerSqft100 || ""));
  }

  function deleteInkChannel(id: string) {
    fetcher.submit(
      { intent: "deleteInkChannel", id },
      { method: "post", encType: "application/json" }
    );
  }

  return (
    <Page
      title="Machine Center"
      subtitle="Printers, ink slots, cost per ML, coverage rates, and overflow routing."
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
                <TextField
                  label="Machine Name"
                  value={name}
                  onChange={setName}
                  autoComplete="off"
                  placeholder="Mimaki UCJV300-54"
                />

                <Select
                  label="Machine Type"
                  value={machineType}
                  onChange={setMachineType}
                  options={machineTypes}
                />

                <TextField
                  label="Max Width Inches"
                  value={maxWidthIn}
                  onChange={setMaxWidthIn}
                  autoComplete="off"
                />
              </InlineStack>

              <InlineStack gap="300">
                <TextField
                  label="Machine Cost Per Hour"
                  prefix="$"
                  value={costPerHour}
                  onChange={setCostPerHour}
                  autoComplete="off"
                />

                <TextField
                  label="Sq Ft Per Hour"
                  value={sqftPerHour}
                  onChange={setSqftPerHour}
                  autoComplete="off"
                />

                <TextField
                  label="Setup Waste %"
                  suffix="%"
                  value={setupWastePct}
                  onChange={setSetupWastePct}
                  autoComplete="off"
                />
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
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                {editingInkId ? "Edit Ink Slot" : "Add Ink Slot"}
              </Text>

              <Select
                label="Machine"
                value={machineId}
                onChange={setMachineId}
                options={[
                  { label: "Select machine", value: "" },
                  ...machines
                    .filter((m) => m.active)
                    .map((m) => ({ label: m.name, value: m.id })),
                ]}
              />

              <InlineStack gap="300">
                <TextField
                  label="Slot Number"
                  value={slotNumber}
                  onChange={setSlotNumber}
                  autoComplete="off"
                />

                <TextField
                  label="Ink Name"
                  value={inkName}
                  onChange={setInkName}
                  autoComplete="off"
                  placeholder="Cyan, White, Gloss, Orange"
                />

                <Select
                  label="Ink Type"
                  value={inkType}
                  onChange={setInkType}
                  options={inkTypes}
                />
              </InlineStack>

              <InlineStack gap="300">
                <TextField
                  label="Cost Per ML"
                  prefix="$"
                  value={costPerMl}
                  onChange={setCostPerMl}
                  autoComplete="off"
                />

                <TextField
                  label="ML Per Sq Ft At 100% Coverage"
                  value={mlPerSqft100}
                  onChange={setMlPerSqft100}
                  autoComplete="off"
                />
              </InlineStack>

              <InlineStack gap="300">
                <Button variant="primary" onClick={saveInkChannel}>
                  {editingInkId ? "Update Ink Slot" : "Save Ink Slot"}
                </Button>
                <Button onClick={resetInkForm}>Clear</Button>
              </InlineStack>

              <Text as="p" tone="subdued">
                Formula later: total sqft × coverage % × ML/sqft × cost/ml.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Machines
              </Text>

              <Divider />

              {machines.length === 0 ? (
                <Text as="p" tone="subdued">
                  No machines yet.
                </Text>
              ) : (
                machines.map((machine) => (
                  <Card key={machine.id}>
                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <Text as="p" fontWeight="bold">
                          {machine.name}
                        </Text>

                        <InlineStack gap="200">
                          <Badge>{machine.machineType}</Badge>
                          {machine.allowOverflow && (
                            <Badge tone="success">Overflow Allowed</Badge>
                          )}
                          {!machine.active && (
                            <Badge tone="warning">Inactive</Badge>
                          )}
                        </InlineStack>
                      </InlineStack>

                      <Text as="p">
                        Max Width: {machine.maxWidthIn || "N/A"} in | Cost/hr:
                        ${Number(machine.costPerHour || 0).toFixed(2)} | Sqft/hr:
                        {Number(machine.sqftPerHour || 0).toFixed(2)}
                      </Text>

                      <Text as="p">
                        Setup Waste: {Number(machine.setupWastePct || 0).toFixed(2)}%
                      </Text>

                      <Divider />

                      <Text as="p" fontWeight="bold">
                        Ink Slots
                      </Text>

                      {machine.inkChannels?.length ? (
                        machine.inkChannels.map((ink: any) => (
                          <InlineStack key={ink.id} align="space-between">
                            <Text as="p">
                              Slot {ink.slotNumber}: {ink.inkName} ({ink.inkType}) —
                              ${Number(ink.costPerMl || 0).toFixed(4)}/ml —
                              {Number(ink.mlPerSqft100 || 0).toFixed(4)} ml/sqft @ 100%
                            </Text>

                            <InlineStack gap="200">
                              <Button onClick={() => editInkChannel(machine, ink)}>
                                Edit
                              </Button>

                              {ink.enabled && (
                                <Button
                                  tone="critical"
                                  onClick={() => deleteInkChannel(ink.id)}
                                >
                                  Disable
                                </Button>
                              )}
                            </InlineStack>
                          </InlineStack>
                        ))
                      ) : (
                        <Text as="p" tone="subdued">
                          No ink slots configured.
                        </Text>
                      )}

                      <InlineStack gap="200">
                        <Button onClick={() => editMachine(machine)}>Edit Machine</Button>

                        {machine.active && (
                          <Button
                            tone="critical"
                            onClick={() => deleteMachine(machine.id)}
                          >
                            Deactivate Machine
                          </Button>
                        )}
                      </InlineStack>
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