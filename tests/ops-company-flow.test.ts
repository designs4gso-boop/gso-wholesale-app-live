import { describe, expect, it } from "vitest";

import { runCompanyFlowSimulation } from "../app/lib/ops/simulator.server";

describe("OPS-2 full company flow (lead -> supervisor (fake reasoning) -> specialist -> quote prep -> art -> production transition intent -> Slack approval -> executor -> QC -> shipping -> invoice -> outbox worker -> reports)", () => {
  it("every safety assertion holds; no disabled action executes; no live provider, DB or Slack is touched", async () => {
    const sim = await runCompanyFlowSimulation();
    const failed = sim.assertions.filter((a) => !a.ok);
    expect(failed, failed.map((f) => `${f.name}: ${f.detail}`).join("\n")).toEqual([]);
    expect(sim.assertions.length).toBeGreaterThanOrEqual(45);
    expect(sim.steps.length).toBeGreaterThanOrEqual(5);
    expect(sim.allPassed).toBe(true);
    expect(sim.intents.filter((i) => i.autonomyLevel === "DISABLED" && i.status === "COMPLETED")).toEqual([]);
    for (const i of sim.intents) {
      if (i.status === "COMPLETED") expect(i.executedAt).toBeTruthy();
      if (i.approvedBy) expect(["staff", "owner"]).toContain(i.approvedBy.type);
      expect(i.audit[0].event).toBe("proposed");
    }
    expect(sim.slackPosts.length).toBe(1); // recorded sink, not Slack
  });
});
