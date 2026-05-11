import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  BlockStack,
  InlineStack,
  Badge,
  Divider,
  TextField,
} from "@shopify/polaris";
import { Form, useActionData, useLoaderData, useNavigation, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const sourceOptions = [
  { label: "VersaWorks CSV/XML", value: "versaworks" },
  { label: "RasterLink CSV/TXT", value: "rasterlink" },
  { label: "Manual CSV/TSV", value: "manual_csv" },
  { label: "Other print log", value: "other" },
];

const columnAliases: Record<string, string[]> = {
  jobName: ["job", "job name", "jobname", "name", "file", "file name", "filename", "print job", "title"],
  machineName: ["machine", "printer", "device", "output device"],
  mediaName: ["media", "material", "profile", "media name"],
  status: ["status", "result", "state"],
  sqft: ["sqft", "sq ft", "square feet", "area", "print area", "printed area", "ft2", "sq.ft"],
  inkMl: ["ink", "ink ml", "total ink", "total ink ml", "ink consumption", "consumption", "total ml", "ml"],
  cmykInkMl: ["cmyk", "process ink", "cmyk ml", "color ink", "color ml"],
  whiteInkMl: ["white", "white ml", "wh ml"],
  glossInkMl: ["gloss", "gloss ml", "clear", "clear ml", "varnish", "varnish ml"],
  printMinutes: ["minutes", "print minutes", "print time", "time", "duration", "elapsed", "elapsed time"],
  startedAt: ["start", "started", "start time", "start date", "date"],
  completedAt: ["end", "ended", "completed", "complete time", "end time", "finish", "finish time"],
};

function normalize(value: any) {
  return String(value || "").trim().toLowerCase().replace(/[_\-]+/g, " ").replace(/\s+/g, " ");
}

function money(value: any) {
  return (Number(value) || 0).toFixed(2);
}

function numberFrom(value: any) {
  const cleaned = String(value || "").replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return cleaned ? Number(cleaned[0]) : 0;
}

function dateFrom(value: any) {
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function minutesFrom(value: any) {
  const text = String(value || "").trim();
  if (!text) return 0;

  const hhmmss = text.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (hhmmss) {
    const hours = Number(hhmmss[1]) || 0;
    const minutes = Number(hhmmss[2]) || 0;
    const seconds = Number(hhmmss[3]) || 0;
    return hours * 60 + minutes + seconds / 60;
  }

  if (/hour|hr/i.test(text)) return numberFrom(text) * 60;
  return numberFrom(text);
}

function chooseDelimiter(line: string) {
  const tabs = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  const semis = (line.match(/;/g) || []).length;
  if (tabs >= commas && tabs >= semis) return "\t";
  if (semis > commas) return ";";
  return ",";
}

function splitCsvLine(line: string, delimiter: string) {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function extractXmlJobs(text: string) {
  const jobs: Record<string, string>[] = [];
  const blocks = text.match(/<job[\s\S]*?<\/job>/gi) || text.match(/<Job[\s\S]*?<\/Job>/g) || [];

  for (const block of blocks) {
    const row: Record<string, string> = {};
    const tags = [...block.matchAll(/<([A-Za-z0-9_\-]+)[^>]*>([\s\S]*?)<\/\1>/g)];
    for (const tag of tags) {
      const key = tag[1];
      const value = tag[2].replace(/<[^>]+>/g, "").trim();
      if (key && value) row[key] = value;
    }
    if (Object.keys(row).length) jobs.push(row);
  }

  return jobs;
}

function parseDelimited(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];

  const delimiter = chooseDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter);
  const rows: Record<string, string>[] = [];

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, delimiter);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] || "";
    });
    rows.push(row);
  }

  return rows;
}

function findField(row: Record<string, string>, field: keyof typeof columnAliases) {
  const entries = Object.entries(row);
  const aliases = columnAliases[field].map(normalize);
  for (const [key, value] of entries) {
    if (aliases.includes(normalize(key))) return value;
  }
  return "";
}

function extractJobTicket(text: string) {
  const match = String(text || "").match(/GSO-[A-Z0-9][A-Z0-9\-]{5,}/i);
  return match ? match[0].toUpperCase() : "";
}

function parsePrintLog(text: string) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return [];

  const rawRows = /<\/?[A-Za-z][\s\S]*>/.test(trimmed) ? extractXmlJobs(trimmed) : parseDelimited(trimmed);

  return rawRows.map((row, index) => {
    const rowText = JSON.stringify(row);
    const sourceJobName = findField(row, "jobName") || rowText.slice(0, 140);
    const jobTicket = extractJobTicket(sourceJobName) || extractJobTicket(rowText);
    const inkMl = numberFrom(findField(row, "inkMl"));
    const cmykInkMl = numberFrom(findField(row, "cmykInkMl"));
    const whiteInkMl = numberFrom(findField(row, "whiteInkMl"));
    const glossInkMl = numberFrom(findField(row, "glossInkMl"));

    return {
      rowNumber: index + 1,
      jobTicket,
      sourceJobName,
      machineName: findField(row, "machineName"),
      mediaName: findField(row, "mediaName"),
      status: findField(row, "status"),
      sqft: numberFrom(findField(row, "sqft")),
      inkMl: inkMl || cmykInkMl + whiteInkMl + glossInkMl,
      cmykInkMl,
      whiteInkMl,
      glossInkMl,
      printMinutes: minutesFrom(findField(row, "printMinutes")),
      startedAt: dateFrom(findField(row, "startedAt")),
      completedAt: dateFrom(findField(row, "completedAt")),
      rawRow: rowText,
    };
  });
}

async function findMatchingJob(shop: string, row: any) {
  const ticket = row.jobTicket;
  const sourceJobName = row.sourceJobName || "";

  if (ticket) {
    const exact = await db.productionJob.findFirst({ where: { shop, jobTicket: ticket } });
    if (exact) return exact;

    const contains = await db.productionJob.findFirst({ where: { shop, jobTicket: { contains: ticket } } });
    if (contains) return contains;
  }

  const jobs = await db.productionJob.findMany({
    where: { shop, active: true },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });

  return jobs.find((job: any) => {
    if (job.jobTicket && sourceJobName.includes(job.jobTicket)) return true;
    if (job.id && sourceJobName.includes(job.id)) return true;
    return false;
  }) || null;
}

async function createEvent(shop: string, jobId: string, eventType: string, message: string, data?: { oldValue?: string; newValue?: string }) {
  return db.productionJobEvent.create({
    data: {
      shop,
      jobId,
      eventType,
      message,
      oldValue: data?.oldValue || null,
      newValue: data?.newValue || null,
    },
  });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [imports, unmatchedEntries, jobs] = await Promise.all([
    db.printLogImport.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { entries: { orderBy: { createdAt: "desc" }, take: 25 } },
    }),
    db.printLogEntry.findMany({
      where: { shop, productionJobId: null },
      orderBy: { createdAt: "desc" },
      take: 25,
    }),
    db.productionJob.findMany({
      where: { shop, active: true },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: { id: true, jobTicket: true, company: true, customerName: true, status: true },
    }),
  ]);

  return Response.json({ imports, unmatchedEntries, jobs, sourceOptions });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "importPrintLog") {
    const source = String(formData.get("source") || "manual_csv");
    const notes = String(formData.get("notes") || "");
    const pastedText = String(formData.get("logText") || "");
    const file = formData.get("logFile") as File | null;
    const fileText = file && file.size > 0 ? await file.text() : "";
    const fileName = file && file.size > 0 ? file.name : String(formData.get("fileName") || "");
    const rawText = fileText || pastedText;
    const rows = parsePrintLog(rawText);

    const importRecord = await db.printLogImport.create({
      data: {
        shop,
        source,
        fileName: fileName || null,
        rawText: rawText.slice(0, 250000),
        notes: notes || null,
        rowCount: rows.length,
        status: "processing",
      },
    });

    let matchedCount = 0;
    let totalSqft = 0;
    let totalInkMl = 0;
    let totalPrintMinutes = 0;

    for (const row of rows) {
      const job = await findMatchingJob(shop, row);
      if (job) matchedCount += 1;
      totalSqft += row.sqft || 0;
      totalInkMl += row.inkMl || 0;
      totalPrintMinutes += row.printMinutes || 0;

      await db.printLogEntry.create({
        data: {
          shop,
          importId: importRecord.id,
          productionJobId: job?.id || null,
          jobTicket: row.jobTicket || job?.jobTicket || null,
          sourceJobName: row.sourceJobName || null,
          printerSoftware: source,
          machineName: row.machineName || null,
          mediaName: row.mediaName || null,
          status: row.status || null,
          sqft: row.sqft || 0,
          inkMl: row.inkMl || 0,
          cmykInkMl: row.cmykInkMl || 0,
          whiteInkMl: row.whiteInkMl || 0,
          glossInkMl: row.glossInkMl || 0,
          printMinutes: row.printMinutes || 0,
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          rawRow: row.rawRow || null,
        },
      });

      if (job) {
        const message = [
          `${source} print log matched.`,
          row.sourceJobName ? `Job: ${row.sourceJobName}.` : "",
          row.sqft ? `Sqft: ${row.sqft}.` : "",
          row.inkMl ? `Ink: ${row.inkMl} ml.` : "",
          row.printMinutes ? `Print time: ${row.printMinutes.toFixed(1)} min.` : "",
        ].filter(Boolean).join(" ");

        await createEvent(shop, job.id, "print_log_imported", message, {
          oldValue: job.status,
          newValue: row.status || null,
        });
      }
    }

    await db.printLogImport.update({
      where: { id: importRecord.id },
      data: {
        matchedCount,
        unmatchedCount: Math.max(0, rows.length - matchedCount),
        totalSqft,
        totalInkMl,
        totalPrintMinutes,
        status: "processed",
      },
    });

    return Response.json({ ok: true, message: `Imported ${rows.length} row(s). Matched ${matchedCount} to production jobs.` });
  }

  if (intent === "matchEntry") {
    const entryId = String(formData.get("entryId") || "");
    const jobId = String(formData.get("jobId") || "");
    const entry = await db.printLogEntry.findFirst({ where: { shop, id: entryId } });
    const job = await db.productionJob.findFirst({ where: { shop, id: jobId } });
    if (!entry || !job) return Response.json({ ok: false, message: "Entry or job not found." }, { status: 404 });

    await db.printLogEntry.update({
      where: { id: entry.id },
      data: { productionJobId: job.id, jobTicket: job.jobTicket || entry.jobTicket },
    });
    await createEvent(shop, job.id, "print_log_manual_match", `Print log entry manually matched: ${entry.sourceJobName || entry.id}.`);
    return Response.json({ ok: true, message: "Print log row matched to production job." });
  }

  return Response.json({ ok: false, message: "Unknown print log action." }, { status: 400 });
}

function SourceSelect({ name, defaultValue }: { name: string; defaultValue?: string }) {
  return (
    <select name={name} defaultValue={defaultValue || "versaworks"} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #aaa" }}>
      {sourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

export default function PrintLogImportPage() {
  const { imports, unmatchedEntries, jobs } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const busy = navigation.state !== "idle";

  const jobOptions = [
    { label: "Choose production job", value: "" },
    ...jobs.map((job: any) => ({
      label: `${job.jobTicket || job.id} | ${job.company || job.customerName || "Customer"} | ${job.status}`,
      value: job.id,
    })),
  ];

  return (
    <Page
      title="Print Log Import"
      subtitle="Import VersaWorks, RasterLink, or CSV job logs and match actual ink, sqft, and print time back to GSO job tickets."
      primaryAction={{ content: "Production Board", onAction: () => navigate("/app/erp/production") }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Import print log</Text>
                  <Text as="p" tone="subdued">Export or copy job history from VersaWorks/RasterLink, then paste it here. The app matches rows by GSO job ticket.</Text>
                </BlockStack>
                <Badge tone="success">Job ticket matching</Badge>
              </InlineStack>

              {actionData?.message ? <Text as="p" tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Text> : null}

              <Form method="post" encType="multipart/form-data">
                <input type="hidden" name="intent" value="importPrintLog" />
                <BlockStack gap="300">
                  <InlineStack gap="300">
                    <div style={{ minWidth: 260, flex: 1 }}>
                      <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Print software / source</label>
                      <SourceSelect name="source" />
                    </div>
                    <div style={{ minWidth: 260, flex: 1 }}>
                      <TextField label="File name / batch name" name="fileName" autoComplete="off" />
                    </div>
                  </InlineStack>

                  <div>
                    <label style={{ display: "block", fontWeight: 600, marginBottom: 6 }}>Upload CSV/TXT/XML file</label>
                    <input type="file" name="logFile" accept=".csv,.txt,.tsv,.xml" />
                  </div>

                  <TextField
                    label="Or paste CSV / TSV / XML log text"
                    name="logText"
                    multiline={10}
                    autoComplete="off"
                    placeholder={'Job Name,Sqft,Total Ink ML,Print Time\nGSO-20260510-0042-STK-BAG-4X5-250,32.4,38,00:14:22'}
                  />
                  <TextField label="Import notes" name="notes" autoComplete="off" />
                  <Button submit variant="primary" loading={busy}>Import and match logs</Button>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Recent imports</Text>
              {imports.length ? imports.map((logImport: any) => (
                <Card key={logImport.id}>
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="050">
                        <Text as="p" fontWeight="bold">{logImport.fileName || logImport.source}</Text>
                        <Text as="p" tone="subdued">{new Date(logImport.createdAt).toLocaleString()}</Text>
                      </BlockStack>
                      <Badge tone={logImport.unmatchedCount ? "warning" : "success"}>{logImport.matchedCount}/{logImport.rowCount} matched</Badge>
                    </InlineStack>
                    <InlineStack gap="300" wrap>
                      <Text as="p">Sqft: {money(logImport.totalSqft)}</Text>
                      <Text as="p">Ink: {money(logImport.totalInkMl)} ml</Text>
                      <Text as="p">Print time: {money(logImport.totalPrintMinutes)} min</Text>
                    </InlineStack>
                    <Divider />
                    {(logImport.entries || []).slice(0, 8).map((entry: any) => (
                      <Text as="p" key={entry.id} tone="subdued">
                        {entry.productionJobId ? "Matched" : "Unmatched"}: {entry.sourceJobName || entry.jobTicket || entry.id} | Ink {money(entry.inkMl)} ml | Sqft {money(entry.sqft)} | Time {money(entry.printMinutes)} min
                      </Text>
                    ))}
                  </BlockStack>
                </Card>
              )) : <Text as="p" tone="subdued">No print logs imported yet.</Text>}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Unmatched rows</Text>
              <Text as="p" tone="subdued">If a row cannot be matched automatically, choose the correct production job manually.</Text>
              {unmatchedEntries.length ? unmatchedEntries.map((entry: any) => (
                <Card key={entry.id}>
                  <Form method="post">
                    <input type="hidden" name="intent" value="matchEntry" />
                    <input type="hidden" name="entryId" value={entry.id} />
                    <BlockStack gap="200">
                      <Text as="p" fontWeight="bold">{entry.sourceJobName || entry.jobTicket || entry.id}</Text>
                      <InlineStack gap="300" wrap>
                        <Text as="p">Ticket: {entry.jobTicket || "Not detected"}</Text>
                        <Text as="p">Ink: {money(entry.inkMl)} ml</Text>
                        <Text as="p">Sqft: {money(entry.sqft)}</Text>
                        <Text as="p">Time: {money(entry.printMinutes)} min</Text>
                      </InlineStack>
                      <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Match to production job</label>
                      <select name="jobId" defaultValue="" style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #aaa" }}>
                        {jobOptions.map((job) => <option key={job.value} value={job.value}>{job.label}</option>)}
                      </select>
                      <Button submit>Match row</Button>
                    </BlockStack>
                  </Form>
                </Card>
              )) : <Text as="p" tone="subdued">No unmatched rows.</Text>}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
