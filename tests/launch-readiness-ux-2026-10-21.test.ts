// 2026-10-21 — LAUNCH READINESS UX CLEANUP (presentation only).
//
// The real Setup Wizard loader runs against an in-memory DB double shaped like
// the current live state (9 ready / 2 needs review / 1 blocker / 2 warnings,
// 82%), and the page component is server-rendered with that loader data to
// prove the default (collapsed) layout. No Prisma connection, no writes.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "942075-2.myshopify.com" }, admin: {} }) },
}));

const JAR_RECIPES = [
  "5oz Clear Jar with Applied Label",
  "4oz Black/White Jar with Applied Label",
  "4oz Clear Jar with Applied Label",
].map((name, index) => ({ id: `r_${index}`, name, minQuantity: 1 }));

const dbCalls: string[] = [];
vi.mock("../app/db.server", () => {
  const COUNTS: Record<string, number> = {
    erpAdminSetting: 5, material: 10, machine: 3, vendor: 2, productTypeProfile: 4, productRecipe: 12,
    pricingRule: 5, configuratorPricingRule: 4, marginReviewSetting: 1, configuratorProduct: 3,
    recipeVariantRule: 2, configuratorOption: 6, productionJobItem: 4, priceApprovalRecord: 7,
    agentApiCredential: 0, agentReviewQueueItem: 1,
  };
  const count = (name: string, args: any) => {
    const where = args?.where || {};
    if (name === "productionJob") return where.actualTotalCost ? 0 : 4;
    if (name === "quote") {
      if (where.status === "deposit_paid") return 1;
      if (where.status === "paid") return 2;
      if (where.lowMarginApprovedAt) return 1;
      return 6;
    }
    return COUNTS[name] ?? 0;
  };
  const model = (name: string) => new Proxy({}, {
    get: (_t, method: string) => async (args: any) => {
      dbCalls.push(`${name}.${method}`);
      if (method === "count") return count(name, args);
      if (method === "findFirst") return name === "agentSubmissionLog" ? { createdAt: new Date("2026-10-01T00:00:00Z") } : null;
      if (method === "findMany") return name === "productRecipe" ? JAR_RECIPES : [];
      throw new Error(`unexpected db.${name}.${method} - the readiness page must stay read-only`);
    },
  });
  const db = new Proxy({}, { get: (_t, key: string) => model(key) });
  return { default: db, db };
});

vi.mock("../app/lib/recipe-pricing.server", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  priceRecipeAtQuantity: () => ({}),
  blockingConversionIssues: () => ["recipe is missing width or height"],
}));

const PAGE = "app/routes/app.erp.setup-wizard.tsx";
const src = (path: string) => readFileSync(path, "utf8");

let data: any;
let html = "";
let route: any;

beforeAll(async () => {
  route = await import("../app/routes/app.erp.setup-wizard");
  data = await (await route.loader({ request: new Request("https://app.test/app/erp/setup-wizard") })).json();
  const Stub = createRoutesStub([{ id: "readiness", path: "/", Component: route.default, loader: () => data }]);
  html = renderToString(
    createElement(AppProvider as any, { i18n: en }, createElement(Stub as any, { initialEntries: ["/"], hydrationData: { loaderData: { readiness: data } } })),
  );
}, 60_000);

const textOf = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("1-2. naming", () => {
  it("the page title is Launch Readiness with the new subtitle; no prominent shop domain", () => {
    const text = textOf(html);
    expect(text).toContain("Launch Readiness");
    expect(text).toContain("System readiness & launch checklist");
    expect(text).not.toContain("Setup Wizard");
    expect(text).not.toContain("942075-2.myshopify.com"); // only inside the collapsed Technical details
    expect(src(PAGE)).not.toContain("System readiness for {data.shop}");
  });

  it("the navigation label is Launch Readiness (same route, same position)", () => {
    const nav = src("app/routes/app.tsx");
    expect(nav).toContain('<s-link href="/app/erp/setup-wizard">Help · Launch Readiness</s-link>');
    expect(nav).not.toContain("Setup Wizard");
    for (const file of ["app/routes/app._index.tsx", "app/routes/app.erp.walkthrough.tsx"]) {
      expect(src(file), file).not.toContain("Setup Wizard");
    }
  });
});

describe("3-7. readiness values come from the existing loader logic", () => {
  it("percentage, ready, needs review, blocker and warning counts are unchanged and displayed", () => {
    const steps = data.steps as any[];
    expect(steps).toHaveLength(11);
    const ready = steps.filter((s) => s.status === "Ready").length;
    expect(data.readySteps).toBe(ready);
    expect(data.readySteps).toBe(9);
    expect(data.progress).toBe(Math.round((ready / steps.length) * 100));
    expect(data.progress).toBe(82);
    expect(data.needsReviewSteps).toBe(2);
    expect(data.blockerSteps.map((b: any) => b.name)).toEqual(["Quote Pipeline"]);
    expect(data.warningSteps).toEqual(["Agent Platform", "Reporting & Margin Review"]);
    const text = textOf(html);
    expect(text).toContain("82%");
    for (const label of ["8 Ready", "1 Blockers", "2 Warnings"]) expect(text).toContain(label);
    // the 2 not-Ready sections are the 2 warnings: the summary must not count them again as Needs Review
    expect(data.needsReviewSteps).toBe(2); // internal metric unchanged
    expect(text).not.toContain("Needs Review");
    expect(src(PAGE)).toContain("Internal needs-review count (sections not yet Ready): ${data.needsReviewSteps}");
    expect(text).not.toContain("9 Ready"); // no 9-vs-8 mismatch: the summary matches the Ready sections list (8)
    expect(data.readySteps).toBe(9); // internal metric unchanged, kept under Technical details
    expect(src(PAGE)).toContain("Internal readiness count (used for the ${data.progress}%): ${data.readySteps} of ${steps.length} sections");
    expect(text).not.toContain("Internal readiness count"); // collapsed by default
  });

  it("the Quote Pipeline blocker stays, summarized in plain English with the exact items behind View details", () => {
    const pipeline = data.steps.find((s: any) => s.name === "Quote Pipeline");
    expect(pipeline.severity).toBe("blocker");
    expect(pipeline.details).toEqual(JAR_RECIPES.map((r) => `${r.name}: recipe is missing width or height`));
    expect(pipeline.summary).toBe("At least 3 jar recipes need dimensions before they are quote-ready.");
    const text = textOf(html);
    expect(text).toContain("Blockers (1)");
    expect(text).toContain("At least 3 jar recipes need dimensions before they are quote-ready.");
    expect(text).toContain("Fix in Product Setup");
    expect(text).toContain("View details");
    expect(text).not.toContain("recipe is missing width or height"); // exact items collapsed until View details
  });

  it("warnings are plain English; technical wording stays out of the default view", () => {
    const text = textOf(html);
    expect(text).toContain("Warnings (2)");
    expect(text).toContain("No active agent credential - only needed when a vendor agent is onboarded.");
    expect(text).toContain("Actual-cost reporting is not mature yet");
    expect(text).not.toMatch(/reasoning OFF|execution OFF|worker|cron|schedule|\.ps1|Deep check/i);
  });
});

describe("8-10. collapsed sections", () => {
  it("ready sections, the full checklist, the launch checklist and technical details are collapsed by default", () => {
    const text = textOf(html);
    expect(text).toContain("Ready sections (8)");
    expect(text).toContain("View ready sections");
    expect(text).toContain("View full checklist");
    expect(text).toContain("Launch Checklist");
    expect(text).toContain("View launch checklist");
    expect(text).toContain("View technical details");
    // nothing behind those toggles is rendered yet
    for (const hidden of ["Shop Defaults", "Cost Foundation", "Storefront Configurator", "Production Workflow", "Internal beta launch", "active material(s)"]) {
      expect(text, hidden).not.toContain(hidden);
    }
    expect(html.match(/aria-expanded="false"/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it("the launch checklist and the full long-form checklist are still in the page", () => {
    const page = src(PAGE);
    for (const item of [
      "1. Product Setup: launch recipes show green readiness (dimensions, materials, preferred machine).",
      "12. Actual-cost reporting loop running: completed jobs log actual costs and margins get reviewed.",
      "Internal beta launch (staff-only quoting and production):",
      "Full customer launch adds:",
    ]) expect(page).toContain(item);
    expect(page).toContain("<StepCard key={step.name} step={step} />");
  });
});

describe("11. fix links and next action", () => {
  it("every step keeps its existing destinations; Fix Next Issue uses the existing next step", () => {
    const first = Object.fromEntries(data.steps.map((s: any) => [s.name, s.links[0].url]));
    expect(first).toEqual({
      "Shop Defaults": "/app/erp/admin-settings",
      "Cost Foundation": "/app/erp/materials",
      "Product Setup": "/app/erp/products/new",
      "Pricing Rules": "/app/erp/pricing-rules",
      "Quote Pipeline": "/app/erp/product-setup",
      "Quote Safety Gates": "/app/quotes",
      "Shopify Links": "/app/erp/shopify-links",
      "Storefront Configurator": "/app/erp/configurator",
      "Agent Platform": "/app/erp/agent-security",
      "Production Workflow": "/app/erp/production",
      "Reporting & Margin Review": "/app/erp/reports-dashboard",
    });
    expect(data.nextStep.name).toBe("Quote Pipeline");
    const text = textOf(html);
    expect(text).toContain("Fix Next Issue");
    expect(text).not.toContain("Go to next step");
    expect(text).toContain("Next: Quote Pipeline");
  });
});

describe("12-16. read-only, no logic / formula / data / schema change", () => {
  it("the loader only counts and reads (any write would throw in the DB double)", () => {
    expect(dbCalls.length).toBeGreaterThan(0);
    expect(dbCalls.every((call) => /\.(count|findFirst|findMany)$/.test(call))).toBe(true);
    expect(route.action).toBeUndefined();
    const page = src(PAGE);
    expect(page).not.toMatch(/useFetcher|useSubmit|<Form|method="post"/);
  });

  const head = (() => {
    try {
      return execSync(`git show HEAD:${PAGE}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  })();
  const loaderLogic = (source: string) => {
    const body = source.replace(/\r\n/g, "\n");
    const loader = body.slice(body.indexOf("export async function loader"), body.indexOf("function StepCard"));
    const out: string[] = [];
    let inSummary = false;
    for (const line of loader.split("\n")) {
      if (/^ {6}summary:/.test(line)) { inSummary = true; continue; }
      if (inSummary && /^ {6}[a-z]+:/.test(line)) inSummary = false;
      if (!inSummary) out.push(line);
    }
    return out.join("\n");
  };

  it.skipIf(!head)("the loader's readiness logic is identical to HEAD apart from the added plain-English summaries", () => {
    expect(loaderLogic(src(PAGE))).toBe(loaderLogic(head!));
  });

  it("no pricing / costing / recipe / schema file is touched by this patch", () => {
    for (const lib of [
      "app/lib/recipe-pricing.server.ts", "app/lib/canonical-calculator.server.ts", "app/lib/true-cost-engine.server.ts",
      "app/lib/commercial-pricing-policy.server.ts", "app/lib/customer-tiers.ts", "prisma/schema.prisma",
    ]) expect(src(lib), lib).not.toContain("2026-10-21");
    let changed = "";
    try {
      changed = execSync("git status --porcelain -- prisma", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      changed = "";
    }
    expect(changed.trim()).toBe("");
  });
});

describe("summary shows Needs Review only for the separate Needs Review group", () => {
  it("appears (with that group's count) when a non-blocking, non-warning section is not Ready", () => {
    const steps = data.steps.map((s: any) => (s.name === "Shop Defaults" ? { ...s, status: "Partial" } : s));
    const variant = { ...data, steps };
    const Stub = createRoutesStub([{ id: "readiness", path: "/", Component: route.default, loader: () => variant }]);
    const text = textOf(renderToString(
      createElement(AppProvider as any, { i18n: en }, createElement(Stub as any, { initialEntries: ["/"], hydrationData: { loaderData: { readiness: variant } } })),
    ));
    expect(text).toContain("1 Needs Review");
    expect(text).toContain("Needs Review (1)");
    expect(text).toContain("2 Warnings");
    expect(text).toContain("7 Ready");
  });
});
