import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Print flow UX (2026-10-05): the four print pages must read as ONE flow.
// Display/copy-only contract — this test pins (a) the shared "Print flow"
// strip, (b) plain-English headings with no patch/version labels, and (c)
// every form field name that existed before the copy pass, so a UX edit
// can never silently drop a control.

const ROUTES_DIR = path.resolve(__dirname, "..", "app", "routes");

const PAGES = {
  printIntake: { file: "app.erp.print-intake.tsx", route: "/app/erp/print-intake" },
  ripImports: { file: "app.erp.rip-imports.tsx", route: "/app/erp/rip-imports" },
  ripImportReview: { file: "app.erp.rip-import-review.tsx", route: "/app/erp/rip-import-review" },
  printLogs: { file: "app.erp.print-logs.tsx", route: "/app/erp/print-logs" },
} as const;

const FLOW_STEPS = [
  { step: 1, label: "Print Intake", hint: "artwork → hot folder", route: PAGES.printIntake.route },
  { step: 2, label: "RIP Imports", hint: "printer logs in", route: PAGES.ripImports.route },
  { step: 3, label: "RIP Import Review", hint: "fix unmatched", route: PAGES.ripImportReview.route },
  { step: 4, label: "Print Logs", hint: "actual usage", route: PAGES.printLogs.route },
] as const;

// Form field names / intents that existed before the UX pass. If any of
// these disappear, a control was removed — which this pass must never do.
const PINNED_FIELDS: Record<keyof typeof PAGES, string[]> = {
  printIntake: [
    'name="intent"', 'value="release"', 'value="assign"', 'value="reject"',
    'name="intakeId"', 'name="target"', 'name="confirmReject"',
  ],
  ripImports: ['name="source"', 'name="ripFile"', 'name="notes"', 'encType="multipart/form-data"'],
  ripImportReview: [
    'name="status"', 'name="source"', 'name="days"', 'name="q"', 'name="warnings"',
    'name="intent"', 'value="rematch"', 'value="unmatch"', 'value="bulkRematch"', 'value="applyRipBackfill"',
    'name="entryId"', 'name="jobId"', 'name="expectedJobId"', 'name="confirm"', 'name="entryIds"',
    'name="confirmPhrase"', 'id="bulk-attach-form"', 'form="bulk-attach-form"',
  ],
  printLogs: [
    'name="intent"', 'value="importPrintLog"', 'name="source"', 'name="fileName"',
    'name="logFile"', 'name="logText"', 'name="notes"', 'encType="multipart/form-data"',
  ],
};

function read(key: keyof typeof PAGES) {
  return readFileSync(path.join(ROUTES_DIR, PAGES[key].file), "utf8");
}

// Staff-facing heading text: <h1>/<h2> JSX, Polaris <Text as="h1|h2">, and the
// Polaris <Page title="..."> prop. Attribute/style noise is stripped so only
// the visible words are checked.
function headingTexts(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/g)) out.push(match[2]);
  for (const match of source.matchAll(/<Text\s+as="h[12]"[^>]*>([\s\S]*?)<\/Text>/g)) out.push(match[1]);
  for (const match of source.matchAll(/\btitle="([^"]*)"/g)) out.push(match[1]);
  return out.map((text) => text.replace(/<[^>]+>/g, " ").replace(/\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim());
}

describe("print flow UX — one flow across four pages", () => {
  const keys = Object.keys(PAGES) as Array<keyof typeof PAGES>;

  it.each(keys)("%s carries the shared Print flow strip with all four steps", (key) => {
    const source = read(key);
    expect(source).toContain('aria-label="Print flow"');
    expect(source).toContain("function PrintFlowStrip(");
    for (const step of FLOW_STEPS) {
      expect(source).toContain(`label: "${step.label}"`);
      expect(source).toContain(`hint: "${step.hint}"`);
      expect(source).toContain(`to: "${step.route}"`);
    }
    // Steps must be declared in flow order 1..4.
    const order = FLOW_STEPS.map((step) => source.indexOf(`label: "${step.label}"`));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((index) => index >= 0)).toBe(true);
    // The page highlights itself.
    expect(source).toContain(`<PrintFlowStrip current="${PAGES[key].route}" />`);
  });

  it.each(keys)("%s links to the other three pages in the flow", (key) => {
    const source = read(key);
    for (const other of keys) {
      if (other === key) continue;
      expect(source).toContain(PAGES[other].route);
    }
  });

  it("all four strips use identical step text", () => {
    const strips = keys.map((key) => {
      const source = read(key);
      const start = source.indexOf("const PRINT_FLOW_STEPS = [");
      const end = source.indexOf("] as const;", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return source.slice(start, end).replace(/\s+/g, " ");
    });
    for (const strip of strips) expect(strip).toBe(strips[0]);
  });

  it.each(keys)("%s has no patch/version labels in staff-facing headings", (key) => {
    const headings = headingTexts(read(key));
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) {
      expect(heading).not.toMatch(/\bPatch\b/i);
      expect(heading).not.toMatch(/\bv14\.0\b/i);
      expect(heading).not.toMatch(/\b1[0-9][A-Z]\.[0-9]+[A-Z]?\b/); // e.g. 13A.6C, 15H.3
    }
  });

  it.each(keys)("%s still contains every pinned form field / intent", (key) => {
    const source = read(key);
    for (const field of PINNED_FIELDS[key]) expect(source).toContain(field);
  });

  it.each(keys)("%s wraps failure messages with a plain sentence and a Technical detail block", (key) => {
    const source = read(key);
    expect(source).toContain("nothing was changed");
    expect(source).toContain("<summary style={{ cursor: \"pointer\" }}>Technical detail</summary>");
  });

  it("every list/table that can be empty explains what would appear and how", () => {
    expect(read("printIntake")).toContain("Nothing needs review right now");
    expect(read("printIntake")).toContain("No intake outcomes yet");
    expect(read("ripImports")).toContain("No RIP imports yet");
    expect(read("ripImportReview")).toContain("No rows match these filters");
    expect(read("ripImportReview")).toContain("No attached rows to audit yet");
    expect(read("ripImportReview")).toContain("No printer-log imports yet");
    expect(read("printLogs")).toContain("No print logs imported yet");
    expect(read("printLogs")).toContain("No unmatched rows");
  });
});
