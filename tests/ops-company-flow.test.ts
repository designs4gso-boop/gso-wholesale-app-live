import { describe, expect, it } from "vitest";

import { runCompanyFlowSimulation } from "../app/lib/ops/simulator.server";

describe("full company flow simulation (lead -> quote -> art -> production -> purchasing -> QC -> ship -> invoice -> reports)", () => {
  it("every safety assertion holds and no disabled action executes", async () => {
    const sim = await runCompanyFlowSimulation();
    const failed = sim.assertions.filter((a) => !a.ok);
    expect(failed, failed.map((f) => `${f.name}: ${f.detail}`).join("\n")).toEqual([]);
    expect(sim.assertions.length).toBeGreaterThanOrEqual(30);
    expect(sim.steps.length).toBeGreaterThanOrEqual(10);
    expect(sim.allPassed).toBe(true);
    const executedDisabled = sim.intents.filter((i) => i.autonomyLevel === "DISABLED" && i.status === "COMPLETED");
    expect(executedDisabled).toEqual([]);
    for (const i of sim.intents) {
      if (i.status === "COMPLETED") expect(i.executedAt).toBeTruthy();
      if (i.approvedBy) expect(["staff", "owner"]).toContain(i.approvedBy.type);
      expect(i.audit[0].event).toBe("proposed");
    }
  });
});
