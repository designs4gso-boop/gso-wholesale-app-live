import { Page, Layout, Card, Text, Badge, Button, InlineStack, BlockStack, Divider } from "@shopify/polaris";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const statuses = [
  { label: "New", value: "new" },
  { label: "Prepress", value: "prepress" },
  { label: "Proof Needed", value: "proof_needed" },
  { label: "Proof Sent", value: "proof_sent" },
  { label: "Proof Approved", value: "proof_approved" },
  { label: "Ready to Print", value: "ready_to_print" },
  { label: "Printing", value: "printing" },
  { label: "Cutting", value: "cutting" },
  { label: "Laminating", value: "laminating" },
  { label: "QC", value: "qc" },
  { label: "Packing", value: "packing" },
  { label: "Ready for Pickup", value: "ready_for_pickup" },
  { label: "Shipped", value: "shipped" },
  { label: "Completed", value: "completed" },
  { label: "On Hold", value: "on_hold" },
  { label: "Reprint Needed", value: "reprint_needed" },
  { label: "Cancelled", value: "cancelled" },
];

const priorities = ["low", "normal", "rush", "critical"];

function statusLabel(value: string) {
  return statuses.find((status) => status.value === value)?.label || value;
}

function dateInput(value: any) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function localDate(value: any) {
  if (!value) return "No due date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No due date";
  return date.toLocaleDateString();
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(from: Date, to: Date) {
  const start = startOfLocalDay(from).getTime();
  const end = startOfLocalDay(to).getTime();
  return Math.round((end - start) / 86400000);
}

function dueTone(job: any) {
  if (!job.dueDate) return undefined;
  const diff = daysBetween(new Date(), new Date(job.dueDate));
  if (diff < 0) return "critical" as const;
  if (diff === 0) return "warning" as const;
  if (diff <= 2) return "attention" as const;
  return "success" as const;
}

function dueText(job: any) {
  if (!job.dueDate) return "No due date";
  const diff = daysBetween(new Date(), new Date(job.dueDate));
  if (diff < 0) return `${Math.abs(diff)} day(s) overdue`;
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  return `Due in ${diff} day(s)`;
}

function suggestedMachine(job: any) {
  const itemText = (job.items || [])
    .map((item: any) => `${item.productTitle || ""} ${item.recipeName || ""} ${item.machineSummary || ""}`)
    .join(" ")
    .toLowerCase();
  if (itemText.includes("roland") || itemText.includes("lg-540") || itemText.includes("label")) return "Roland LG-540";
  if (itemText.includes("mimaki") || itemText.includes("ucjv")) return "Mimaki UCJV300-130";
  if (itemText.includes("box") || itemText.includes("outsource")) return "Outsource / Vendor";
  return "Unassigned machine";
}

function jobSearchText(job: any) {
  return [
    job.jobTicket,
    job.quoteId,
    job.company,
    job.customerName,
    job.email,
    job.status,
    job.priority,
    job.assignedTo,
    ...(job.items || []).map((item: any) => `${item.itemTicket || ""} ${item.productTitle || ""} ${item.variantTitle || ""} ${item.sku || ""}`),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function groupJobs(jobs: any[]) {
  const today = startOfLocalDay();
  const endOfWeek = new Date(today);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  const activeJobs = jobs.filter((job) => !["completed", "cancelled"].includes(job.status));

  return {
    overdue: activeJobs.filter((job) => job.dueDate && new Date(job.dueDate) < today),
    today: activeJobs.filter((job) => job.dueDate && daysBetween(today, new Date(job.dueDate)) === 0),
    tomorrow: activeJobs.filter((job) => job.dueDate && daysBetween(today, new Date(job.dueDate)) === 1),
    week: activeJobs.filter((job) => job.dueDate && daysBetween(today, new Date(job.dueDate)) >= 2 && new Date(job.dueDate) <= endOfWeek),
    noDueDate: activeJobs.filter((job) => !job.dueDate),
    rush: activeJobs.filter((job) => ["rush", "critical"].includes(job.priority)),
    completed: jobs.filter((job) => job.status === "completed"),
  };
}

async function createEvent(shop: string, jobId: string, eventType: string, message: string, oldValue?: string, newValue?: string) {
  return db.productionJobEvent.create({
    data: { shop, jobId, eventType, message, oldValue: oldValue || null, newValue: newValue || null },
  });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  const range = url.searchParams.get("range") || "active";

  const jobs = await db.productionJob.findMany({
    where: range === "all" ? { shop, active: true } : { shop, active: true, status: { notIn: ["completed", "cancelled"] } },
    orderBy: [{ dueDate: "asc" }, { priority: "desc" }, { updatedAt: "desc" }],
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      events: { orderBy: { createdAt: "desc" }, take: 5 },
    },
  });

  const filteredJobs = q ? jobs.filter((job) => jobSearchText(job).includes(q)) : jobs;
  const groups = groupJobs(filteredJobs);

  const statusCounts = statuses.map((status) => ({
    ...status,
    count: filteredJobs.filter((job) => job.status === status.value).length,
  }));

  const machineCounts = filteredJobs.reduce((acc: Record<string, number>, job: any) => {
    const machine = suggestedMachine(job);
    acc[machine] = (acc[machine] || 0) + 1;
    return acc;
  }, {});

  return Response.json({ jobs: filteredJobs, groups, statusCounts, machineCounts, q, range });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "updateSchedule") {
    const jobId = String(formData.get("jobId") || "");
    const job = await db.productionJob.findFirst({ where: { shop, id: jobId } });
    if (!job) return Response.json({ ok: false, message: "Production job not found." }, { status: 404 });

    const dueDate = String(formData.get("dueDate") || "");
    const status = String(formData.get("status") || job.status || "new");
    const priority = String(formData.get("priority") || job.priority || "normal");
    const assignedTo = String(formData.get("assignedTo") || "").trim();
    const oldSummary = `${job.status || ""}|${job.priority || ""}|${dateInput(job.dueDate)}|${job.assignedTo || ""}`;
    const newSummary = `${status}|${priority}|${dueDate}|${assignedTo}`;

    await db.productionJob.update({
      where: { id: jobId },
      data: {
        status,
        priority,
        dueDate: dueDate ? new Date(`${dueDate}T12:00:00`) : null,
        assignedTo: assignedTo || null,
        completedAt: status === "completed" ? new Date() : job.completedAt,
      },
    });

    await createEvent(shop, jobId, "schedule_updated", "Production schedule updated from calendar board.", oldSummary, newSummary);
    return Response.json({ ok: true, message: "Production schedule updated." });
  }

  if (intent === "quickDueDate") {
    const jobId = String(formData.get("jobId") || "");
    const days = Number(formData.get("days") || 0);
    const job = await db.productionJob.findFirst({ where: { shop, id: jobId } });
    if (!job) return Response.json({ ok: false, message: "Production job not found." }, { status: 404 });
    const due = startOfLocalDay();
    due.setDate(due.getDate() + days);
    due.setHours(12, 0, 0, 0);
    await db.productionJob.update({ where: { id: jobId }, data: { dueDate: due } });
    await createEvent(shop, jobId, "due_date_updated", `Due date changed to ${due.toLocaleDateString()} from calendar quick action.`, dateInput(job.dueDate), dateInput(due));
    return Response.json({ ok: true, message: "Due date updated." });
  }

  return Response.json({ ok: false, message: "Unknown calendar action." }, { status: 400 });
}

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(value)}
      style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #bbb", background: "white", cursor: "pointer" }}
    >
      {label}
    </button>
  );
}

function JobMiniCard({ job }: { job: any }) {
  const image = job.productImageUrl || job.items?.find((item: any) => item.productImageUrl)?.productImageUrl;
  return (
    <Card>
      <BlockStack gap="250">
        <InlineStack align="space-between" blockAlign="start">
          <InlineStack gap="250" blockAlign="start">
            {image ? (
              <img src={image} alt="Product" style={{ width: 74, height: 74, objectFit: "cover", borderRadius: 10, border: "1px solid #ddd" }} />
            ) : (
              <div style={{ width: 74, height: 74, borderRadius: 10, border: "1px dashed #bbb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>No image</div>
            )}
            <BlockStack gap="100">
              <Text as="h3" variant="headingSm">{job.company || job.customerName || "Production Job"}</Text>
              <Text as="p" tone="subdued">Ticket: {job.jobTicket || job.id}</Text>
              <Text as="p" tone="subdued">{(job.items || []).map((item: any) => item.productTitle).filter(Boolean).join(", ") || "No items"}</Text>
              <InlineStack gap="150">
                <Badge tone={dueTone(job)}>{dueText(job)}</Badge>
                <Badge>{statusLabel(job.status)}</Badge>
                <Badge tone={job.priority === "critical" ? "critical" : job.priority === "rush" ? "warning" : undefined}>{job.priority}</Badge>
              </InlineStack>
            </BlockStack>
          </InlineStack>
          <InlineStack gap="150">
            <a href="/app/erp/production" style={{ textDecoration: "none" }}><Button>Production Board</Button></a>
            <CopyButton value={job.jobTicket || job.id} label="Copy Ticket" />
          </InlineStack>
        </InlineStack>

        <Divider />

        <Form method="post">
          <input type="hidden" name="intent" value="updateSchedule" />
          <input type="hidden" name="jobId" value={job.id} />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(140px, 1fr))", gap: 10 }}>
            <div>
              <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Status</label>
              <select name="status" defaultValue={job.status} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }}>
                {statuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Priority</label>
              <select name="priority" defaultValue={job.priority || "normal"} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }}>
                {priorities.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
              </select>
            </div>
            <div>
              <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Due date</label>
              <input name="dueDate" type="date" defaultValue={dateInput(job.dueDate)} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }} />
            </div>
            <div>
              <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Assigned to</label>
              <input name="assignedTo" defaultValue={job.assignedTo || ""} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }} />
            </div>
          </div>
          <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button submit>Save schedule</Button>
          </div>
        </Form>

        <InlineStack gap="150">
          {[0, 1, 2, 7].map((days) => (
            <Form method="post" key={days}>
              <input type="hidden" name="intent" value="quickDueDate" />
              <input type="hidden" name="jobId" value={job.id} />
              <input type="hidden" name="days" value={days} />
              <Button submit>{days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due +${days} days`}</Button>
            </Form>
          ))}
        </InlineStack>

        <BlockStack gap="100">
          {(job.items || []).map((item: any) => (
            <div key={item.id} style={{ padding: 10, border: "1px solid #eee", borderRadius: 10 }}>
              <Text as="p" fontWeight="bold">{item.productTitle}</Text>
              <Text as="p" tone="subdued">Item ticket: {item.itemTicket || "Not set"} | Qty: {item.quantity} | Variant: {item.variantTitle || "None"}</Text>
              <Text as="p" tone="subdued">Machine: {item.machineSummary || suggestedMachine(job)} | SKU: {item.sku || "None"}</Text>
            </div>
          ))}
        </BlockStack>
      </BlockStack>
    </Card>
  );
}

function GroupSection({ title, jobs, tone }: { title: string; jobs: any[]; tone?: any }) {
  return (
    <Layout.Section>
      <InlineStack align="space-between" blockAlign="center">
        <Text as="h2" variant="headingMd">{title}</Text>
        <Badge tone={tone}>{jobs.length}</Badge>
      </InlineStack>
      <div style={{ height: 10 }} />
      <BlockStack gap="300">
        {jobs.length ? jobs.map((job) => <JobMiniCard key={job.id} job={job} />) : <Card><Text as="p" tone="subdued">No jobs in this group.</Text></Card>}
      </BlockStack>
    </Layout.Section>
  );
}

export default function ProductionCalendar() {
  const { groups, statusCounts, machineCounts, q, range } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <Page title="Production Calendar / Due Date Board" subtitle="Schedule jobs by due date, rush priority, status, assigned person, and machine." backAction={{ content: "Production", url: "/app/erp/production" }}>
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Schedule overview</Text>
                  <Text as="p" tone="subdued">Use this page for daily production planning. Production Board remains the detailed job workspace.</Text>
                </BlockStack>
                <InlineStack gap="200">
                  <a href="/app/erp/production" style={{ textDecoration: "none" }}><Button>Production Board</Button></a>
                  <a href="/app/erp/print-logs" style={{ textDecoration: "none" }}><Button>Print Logs</Button></a>
                </InlineStack>
              </InlineStack>

              {actionData?.message ? <Text as="p" tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Text> : null}

              <Form method="get">
                <div style={{ display: "grid", gridTemplateColumns: "1fr 180px 120px", gap: 10, alignItems: "end" }}>
                  <div>
                    <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Search jobs</label>
                    <input name="q" defaultValue={q || ""} placeholder="Ticket, customer, product, assigned person, status..." style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }} />
                  </div>
                  <div>
                    <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Range</label>
                    <select name="range" defaultValue={range || "active"} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }}>
                      <option value="active">Active jobs</option>
                      <option value="all">All jobs</option>
                    </select>
                  </div>
                  <Button submit loading={busy}>Filter</Button>
                </div>
              </Form>

              <InlineStack gap="200" wrap>
                <Badge tone="critical">Overdue {groups.overdue.length}</Badge>
                <Badge tone="warning">Today {groups.today.length}</Badge>
                <Badge tone="attention">Tomorrow {groups.tomorrow.length}</Badge>
                <Badge>Week {groups.week.length}</Badge>
                <Badge tone="warning">Rush/Critical {groups.rush.length}</Badge>
                <Badge>No due date {groups.noDueDate.length}</Badge>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Status + machine snapshot</Text>
              <InlineStack gap="200" wrap>
                {statusCounts.filter((status: any) => status.count > 0).map((status: any) => <Badge key={status.value}>{status.label}: {status.count}</Badge>)}
              </InlineStack>
              <InlineStack gap="200" wrap>
                {Object.entries(machineCounts).map(([machine, count]: any) => <Badge key={machine}>{machine}: {count}</Badge>)}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <GroupSection title="Overdue" jobs={groups.overdue} tone="critical" />
        <GroupSection title="Due Today" jobs={groups.today} tone="warning" />
        <GroupSection title="Due Tomorrow" jobs={groups.tomorrow} tone="attention" />
        <GroupSection title="Due This Week" jobs={groups.week} />
        <GroupSection title="Rush / Critical" jobs={groups.rush} tone="warning" />
        <GroupSection title="No Due Date" jobs={groups.noDueDate} />
      </Layout>
    </Page>
  );
}
