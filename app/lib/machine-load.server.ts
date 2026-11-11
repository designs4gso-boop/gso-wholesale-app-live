// 2026-11-11 — per-press load snapshot for AUTO routing (see
// machine-load-balancing.ts for the selection rule).
//
// Audit finding: the ERP has NO live RIP queue or machine-minute ledger. The
// only defensible per-press signal is the open Production work itself:
//   - items on jobs in a print-stage status (approved through printing, or a
//     pending reprint),
//   - attributed to a press ONLY by an explicit machineSummary (ERP
//     assignment, a manual job's printer, or a converted quote's costed press),
//   - estimated minutes ONLY from that item's saved canonical snapshot.
// Any unattributed open item makes the snapshot incomplete, and the selector
// then reports AUTO_MACHINE_LOAD_UNAVAILABLE instead of guessing.
//
// READ-ONLY. A failed read returns null (= load unavailable), never a guess.

import type { MachineLoadSnapshot } from "./machine-load-balancing";
import { assignedMachineOf } from "./print-intake-routing.server";

/** Statuses where the work is waiting for, or occupying, a press. */
export const PRINT_STAGE_STATUSES = ["proof_approved", "ready_to_print", "printing", "reprint_needed"] as const;

function snapshotMinutes(costSnapshot: string | null | undefined): number | null {
  try {
    const minutes = JSON.parse(String(costSnapshot || ""))?.canonical?.diagnostics?.machineMinutes;
    return typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
  } catch {
    return null;
  }
}

/** Pure: build the snapshot from open print-stage items. Exported for tests. */
export function machineLoadFromItems(
  items: Array<{ machineSummary: string | null; costSnapshot?: string | null }>,
  capturedAt = new Date(),
): MachineLoadSnapshot {
  const byPrinter = { mimaki: { openItems: 0, estimatedMinutes: 0 as number | null }, roland: { openItems: 0, estimatedMinutes: 0 as number | null } };
  let unattributedOpenItems = 0;
  for (const item of items) {
    const printer = assignedMachineOf(item);
    if (!printer) {
      unattributedOpenItems += 1;
      continue;
    }
    const entry = byPrinter[printer];
    entry.openItems += 1;
    const minutes = snapshotMinutes(item.costSnapshot);
    entry.estimatedMinutes = entry.estimatedMinutes == null || minutes == null ? null : entry.estimatedMinutes + minutes;
  }
  return {
    source: `open Production items in ${PRINT_STAGE_STATUSES.join(" / ")}`,
    capturedAt: capturedAt.toISOString(),
    byPrinter,
    unattributedOpenItems,
  };
}

export async function loadMachineWorkload(db: any, shop: string): Promise<MachineLoadSnapshot | null> {
  try {
    const items = await db.productionJobItem.findMany({
      where: { shop, job: { shop, active: true, status: { in: [...PRINT_STAGE_STATUSES] } } },
      select: { machineSummary: true, costSnapshot: true },
    });
    return machineLoadFromItems(items);
  } catch {
    return null;
  }
}
