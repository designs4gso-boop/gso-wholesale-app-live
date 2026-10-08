// MACHINES "Edit machine" HOTFIX — 2026-10-08.
// Before: the button only populated the "Add Machine" form at the top of the
// page (nothing changed next to the button). After: the editor renders INLINE in
// that machine's card, scrolls into view, and saves through the unchanged
// saveMachine action. Ink slots, archive / delete, routing and the $5 owner
// standard are untouched.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OWNER_STANDARDS } from "../app/lib/owner-standards";
import { decideMachine } from "../app/lib/print-intake-routing.server";

const src = readFileSync(new URL("../app/routes/app.erp.machines.tsx", import.meta.url), "utf8");
const component = src.slice(src.indexOf("export default function MachinesPage"));
const action = src.slice(src.indexOf("export async function action"), src.indexOf("export default function MachinesPage"));

describe("Machines page — Edit machine is actionable and visible", () => {
  it("1. the Edit machine button calls editMachine, which opens an inline editor in that machine's card and scrolls to it", () => {
    expect(component).toContain('<Button onClick={() => editMachine(machine)}>Edit machine</Button>');
    expect(component).toContain("{editingMachineId === machine.id ? (");
    expect(component).toContain("id={`machine-editor-${machine.id}`}");
    expect(component).toContain("Edit machine — {machine.name}");
    expect(component).toContain('<Badge tone="info">Editing</Badge>');
    expect(component).toContain("scrollIntoView({ behavior: \"smooth\", block: \"center\" })");
    // the top card no longer silently becomes the editor
    expect(component).not.toContain('{editingMachineId ? "Edit Machine" : "Add Machine"}');
    expect(component).toContain("the edit form is open inside that machine's card below");
  });

  it("2. existing machine values populate the editor state", () => {
    for (const line of [
      "setEditingMachineId(machine.id);",
      'setName(machine.name || "");',
      'setMachineType(machine.machineType || "printer");',
      'setMaxWidthIn(machine.maxWidthIn ? String(machine.maxWidthIn) : "");',
      'setCostPerHour(String(machine.costPerHour || ""));',
      'setSqftPerHour(String(machine.sqftPerHour || ""));',
      'setSetupWastePct(String(machine.setupWastePct || ""));',
      'setAllowOverflow(machine.allowOverflow ? "true" : "false");',
    ]) expect(component, line).toContain(line);
  });

  it("3. machine cost per hour is an editable field in the shared machine-level field set (name, type, width, cost, throughput, setup waste, overflow)", () => {
    const fields = component.slice(component.indexOf("function machineFields()"), component.indexOf("function deleteMachine"));
    for (const label of ['label="Machine name"', 'label="Machine type"', 'label="Max print width (in)"', 'label="Machine cost ($ per hour)"', 'label="Throughput (sqft per hour)"', 'label="Setup waste (%)"', 'label="Accept overflow jobs"']) expect(fields, label).toContain(label);
    expect(fields).toContain("onChange={setCostPerHour}");
    expect(fields).toContain("Owner standard: $${OWNER_STANDARDS.machineRecoveryPerHour.value.toFixed(2)}/hr");
    expect((component.match(/\{machineFields\(\)\}/g) || []).length).toBe(2); // add form + inline editor share one definition
  });

  it("4. saving uses the existing safe update path (saveMachine intent -> updateOwnedRecord) with machine-level fields only", () => {
    const save = component.slice(component.indexOf("function saveMachine()"), component.indexOf("function editMachine"));
    expect(save).toContain('intent: "saveMachine"');
    expect(save).toContain("id: editingMachineId,");
    for (const k of ["name,", "machineType,", "maxWidthIn,", "costPerHour,", "sqftPerHour,", "setupWastePct,", 'allowOverflow: allowOverflow === "true",']) expect(save, k).toContain(k);
    expect(save).not.toMatch(/ink|slot|channel/i);
    expect((component.match(/<Button variant="primary" onClick={saveMachine}>Update machine<\/Button>/g) || []).length).toBe(1);
    expect(action).toContain('if (payload.intent === "saveMachine") {');
    expect(action).toContain("const result = await updateOwnedRecord(db.machine, shop, payload.id, {");
    expect(action).toContain("costPerHour: Number(payload.costPerHour) || 0,");
  });

  it("5. ink slots are not altered by editing the machine (the update writes machine columns only; slot intents are separate)", () => {
    const update = action.slice(action.indexOf("const result = await updateOwnedRecord(db.machine"), action.indexOf("if (!result.ok)"));
    expect(update).not.toMatch(/inkChannel|machineInkChannel|slot/i);
    expect(action).toContain('if (payload.intent === "updateSlot") {');
    expect(action).toContain('if (payload.intent === "clearSlot") {');
    expect(component).toContain("Ink slots are edited with their own controls below; they are not changed by this form.");
  });

  it("6. archive / restore / permanent delete behaviour is unchanged", () => {
    expect(component).toContain('{ intent: "deleteMachine", id },');
    expect(component).toContain('{ intent: "restoreMachine", id },');
    expect(component).toContain('if (!confirm("Permanently delete this machine and all ink slots?")) return;');
    expect(component).toContain('{ intent: "permanentDeleteMachine", id, confirmPermanentDelete: true },');
    expect(action).toContain('if (payload.intent === "deleteMachine") {');
    expect(action).toContain('if (payload.intent === "permanentDeleteMachine") {');
  });

  it("7. machine routing is unchanged (white / gloss -> Roland, CMYK -> Mimaki by default)", () => {
    expect(String(decideMachine({ selectedFinish: "White + CMYK", materialSummary: "white ink layer", machineSummary: null } as any).machine)).toMatch(/roland/i);
    expect(String(decideMachine({ selectedFinish: "Gloss", materialSummary: "spot gloss", machineSummary: null } as any).machine)).toMatch(/roland/i);
    expect(String(decideMachine({ selectedFinish: "CMYK", materialSummary: "standard cmyk", machineSummary: null } as any).machine)).toMatch(/mimaki/i);
    expect(src).not.toContain("decideMachine"); // the page never routes jobs; routing authority lives in print-intake-routing.server.ts
  });

  it("8. the $5 canonical owner standard is unchanged and the page copy no longer says $8", () => {
    expect(OWNER_STANDARDS.machineRecoveryPerHour.value).toBe(5);
    expect(OWNER_STANDARDS.machineRecoveryPerHour.status).toBe("owner_verified");
    expect(src).toContain("$5 per hour owner recovery rate, approved 2026-10-07");
    expect(src).not.toContain("$8 per hour owner recovery rate");
    expect((src.match(/costPerHour: OWNER_STANDARDS\.machineRecoveryPerHour\.value/g) || []).length).toBe(2);
  });
});
