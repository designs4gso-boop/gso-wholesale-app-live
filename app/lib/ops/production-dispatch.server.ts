// GSO Operations Agent Platform — Production Dispatcher (plan only).
//
// Machine assignment is decided by the ONE canonical decider the print-intake
// agent already uses (decideMachine): CMYK -> Mimaki, white/gloss -> Roland,
// explicit Mimaki on white/gloss = contradiction = BLOCK. This module never
// copies files or writes hot folders; the PowerShell print-intake agent
// remains the executor.

import { decideMachine, type IntakeItem } from "../print-intake-routing.server";
import { MACHINE_KEYS } from "../machine-routing.server";

export const PRODUCTION_DISPATCH_VERSION = "production-dispatch/1.0.0-2026-10-03";

export type DispatchItem = Pick<IntakeItem, "id" | "itemTicket" | "productTitle" | "selectedFinish" | "materialSummary" | "machineSummary"> & { fileName?: string | null; outsourced?: boolean };

export type DispatchPlanLine = {
  itemId: string;
  itemTicket: string | null;
  decision: "DISPATCH" | "BLOCK" | "OUTSOURCED";
  machine: "mimaki" | "roland" | null;
  machineKey: string | null;
  rule: string | null;
  reasons: string[];
};

export function planDispatch(items: DispatchItem[]): { version: string; lines: DispatchPlanLine[]; blocked: number } {
  const lines = items.map((item): DispatchPlanLine => {
    if (item.outsourced) return { itemId: item.id, itemTicket: item.itemTicket, decision: "OUTSOURCED", machine: null, machineKey: null, rule: "legacy_outsourced", reasons: ["family is vendor-produced; no in-house machine"] };
    const d = decideMachine({ ...item, ripJobName: null, suggestedFileName: null }, item.fileName ?? "");
    if (!d.machine) return { itemId: item.id, itemTicket: item.itemTicket, decision: "BLOCK", machine: null, machineKey: null, rule: null, reasons: d.reasons };
    return { itemId: item.id, itemTicket: item.itemTicket, decision: "DISPATCH", machine: d.machine, machineKey: MACHINE_KEYS[d.machine], rule: d.machineRule, reasons: d.reasons };
  });
  return { version: PRODUCTION_DISPATCH_VERSION, lines, blocked: lines.filter((l) => l.decision === "BLOCK").length };
}
