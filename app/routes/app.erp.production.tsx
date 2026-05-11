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
  Checkbox,
} from "@shopify/polaris";
import { Form, useActionData, useLoaderData, useNavigation, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const productionStatuses = [
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

const priorityOptions = [
  { label: "Low", value: "low" },
  { label: "Normal", value: "normal" },
  { label: "Rush", value: "rush" },
  { label: "Critical", value: "critical" },
];

const fileTypeOptions = [
  { label: "Artwork", value: "artwork" },
  { label: "Proof", value: "proof" },
  { label: "Dieline", value: "dieline" },
  { label: "Customer PDF", value: "customer_pdf" },
  { label: "Print File", value: "print_file" },
  { label: "Product Image", value: "image" },
  { label: "Other", value: "other" },
];

const defaultChecklist = [
  { section: "prepress", label: "Artwork received / linked", sortOrder: 10 },
  { section: "prepress", label: "Dieline / size confirmed", sortOrder: 20 },
  { section: "prepress", label: "Proof sent if required", sortOrder: 30 },
  { section: "prepress", label: "Proof approved", sortOrder: 40 },
  { section: "production", label: "Material pulled", sortOrder: 50 },
  { section: "production", label: "Machine assigned", sortOrder: 60 },
  { section: "production", label: "Print complete", sortOrder: 70 },
  { section: "production", label: "Cut / laminate / finish complete", sortOrder: 80 },
  { section: "qc", label: "QC passed", sortOrder: 90 },
  { section: "packing", label: "Packed and labeled", sortOrder: 100 },
];

function labelForStatus(value: string) {
  return productionStatuses.find((status) => status.value === value)?.label || value;
}

function money(value: any) {
  return (Number(value) || 0).toFixed(2);
}

function safeDateInput(value: any) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function parseJson(value: any) {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (_error) {
    return null;
  }
}

function firstImageFromQuoteItem(item: any) {
  const costSnapshot = parseJson(item.costSnapshot);
  const priceSnapshot = parseJson(item.priceSnapshot);
  return (
    item.productImageUrl ||
    costSnapshot?.productImageUrl ||
    costSnapshot?.imageUrl ||
    priceSnapshot?.productImageUrl ||
    priceSnapshot?.imageUrl ||
    ""
  );
}

function snapshotValue(item: any, key: string) {
  return item?.[key] || parseJson(item.costSnapshot)?.[key] || parseJson(item.priceSnapshot)?.[key] || "";
}

async function createEvent(shop: string, jobId: string, eventType: string, message: string, data?: { oldValue?: string; newValue?: string; createdBy?: string }) {
  return db.productionJobEvent.create({
    data: {
      shop,
      jobId,
      eventType,
      message,
      oldValue: data?.oldValue || null,
      newValue: data?.newValue || null,
      createdBy: data?.createdBy || null,
    },
  });
}

async function sendProductionAlert(job: any) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL || process.env.PRODUCTION_SLACK_WEBHOOK_URL;
  if (!webhookUrl) return { sent: false, reason: "No Slack webhook configured." };

  const text = [
    "🚨 New GSO Production Job",
    `Customer: ${job.company || job.customerName || "Unknown"}`,
    `Job: ${job.id}`,
    `Quote: ${job.quoteId || "N/A"}`,
    `Priority: ${job.priority}`,
    `Status: ${labelForStatus(job.status)}`,
  ].join("\n");

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return { sent: response.ok, reason: response.ok ? "Slack alert sent." : `Slack returned ${response.status}` };
  } catch (error: any) {
    return { sent: false, reason: error?.message || "Slack alert failed." };
  }
}

async function createProductionJobFromQuote(shop: string, quoteId: string) {
  const existingJob = await db.productionJob.findFirst({ where: { shop, quoteId } });
  if (existingJob) return { job: existingJob, created: false };

  const quote = await db.quote.findFirst({
    where: { shop, id: quoteId },
    include: { items: true },
  });

  if (!quote) throw new Error("Quote not found.");
  if (!quote.items.length) throw new Error("Quote has no items to send to production.");

  const job = await db.productionJob.create({
    data: {
      shop,
      quoteId: quote.id,
      quoteNumber: quote.id,
      customerName: quote.customerName || null,
      company: quote.company || null,
      email: quote.email || null,
      phone: quote.phone || null,
      status: "new",
      priority: "normal",
      customerNotes: quote.notes || null,
      internalNotes: "Created from quote.",
      productImageUrl: firstImageFromQuoteItem(quote.items[0]),
      proofUrl: null,
      items: {
        create: quote.items.map((item: any, index: number) => ({
          shop,
          quoteItemId: item.id,
          productTitle: item.productName || "Custom item",
          variantTitle: item.variant || null,
          sku: item.sku || null,
          quantity: Number(item.quantity) || 1,
          unitPrice: Number(item.unitPrice) || 0,
          unitCost: Number(item.unitCost) || 0,
          productImageUrl: firstImageFromQuoteItem(item) || null,
          shopifyProductGid: snapshotValue(item, "shopifyProductGid") || snapshotValue(item, "shopifyProductId") || null,
          shopifyVariantGid: snapshotValue(item, "shopifyVariantGid") || snapshotValue(item, "shopifyVariantId") || null,
          recipeId: item.recipeId || snapshotValue(item, "recipeId") || null,
          recipeName: item.recipeName || snapshotValue(item, "recipeName") || null,
          selectedFinish: item.selectedFinish || snapshotValue(item, "selectedFinish") || null,
          selectedAddOns: item.selectedAddOnIds || snapshotValue(item, "selectedAddOns") || null,
          costSnapshot: item.costSnapshot || null,
          priceSnapshot: item.priceSnapshot || null,
          productionNotes: item.notes || null,
          sortOrder: index + 1,
        })),
      },
      checklistItems: {
        create: defaultChecklist.map((check) => ({ shop, ...check })),
      },
      events: {
        create: [
          {
            shop,
            eventType: "created_from_quote",
            message: `Production job created from quote ${quote.id}.`,
          },
        ],
      },
    },
    include: { items: true, events: true },
  });

  await db.quote.updateMany({
    where: { shop, id: quote.id, status: { not: "paid" } },
    data: { status: "production" },
  });

  const proofUrl = `/app/erp/production/${job.id}/proof`;
  await db.productionJob.update({
    where: { id: job.id },
    data: { proofUrl },
  });
  await db.productionJobFile.create({
    data: {
      shop,
      jobId: job.id,
      fileName: "Standard GSO Proof Sheet",
      fileType: "proof",
      fileUrl: proofUrl,
      notes: "Auto-created internal proof sheet. Open to edit images/artwork and print/export.",
    },
  });
  await createEvent(shop, job.id, "proof_created", "Standard GSO proof sheet auto-created.");

  const alertResult = await sendProductionAlert(job);
  await createEvent(
    shop,
    job.id,
    alertResult.sent ? "alert_sent" : "alert_skipped",
    alertResult.reason || "Production alert processed."
  );

  await db.productionJob.update({
    where: { id: job.id },
    data: { alertSentAt: alertResult.sent ? new Date() : null },
  });

  return { job, created: true };
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [jobs, quotes] = await Promise.all([
    db.productionJob.findMany({
      where: { shop, active: true },
      orderBy: [{ updatedAt: "desc" }],
      include: {
        items: { orderBy: { sortOrder: "asc" } },
        files: { orderBy: { createdAt: "desc" } },
        events: { orderBy: { createdAt: "desc" }, take: 20 },
        checklistItems: { orderBy: [{ section: "asc" }, { sortOrder: "asc" }] },
      },
    }),
    db.quote.findMany({
      where: { shop, status: { in: ["approved", "paid", "production"] } },
      orderBy: { updatedAt: "desc" },
      include: { items: true },
    }),
  ]);

  return Response.json({ jobs, quotes });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "createFromQuote") {
    const quoteId = String(formData.get("quoteId") || "");
    const result = await createProductionJobFromQuote(shop, quoteId);
    return Response.json({ ok: true, message: result.created ? "Production job created." : "Production job already exists.", jobId: result.job.id });
  }

  if (intent === "changeStatus") {
    const jobId = String(formData.get("jobId") || "");
    const status = String(formData.get("status") || "new");
    const job = await db.productionJob.findFirst({ where: { shop, id: jobId } });
    if (!job) return Response.json({ ok: false, message: "Job not found." }, { status: 404 });

    await db.productionJob.update({
      where: { id: jobId },
      data: {
        status,
        completedAt: status === "completed" ? new Date() : job.completedAt,
      },
    });
    await createEvent(shop, jobId, "status_change", `Status changed from ${labelForStatus(job.status)} to ${labelForStatus(status)}.`, {
      oldValue: job.status,
      newValue: status,
    });
    return Response.json({ ok: true, message: "Status updated." });
  }

  if (intent === "updateJob") {
    const jobId = String(formData.get("jobId") || "");
    const dueDate = String(formData.get("dueDate") || "");
    await db.productionJob.updateMany({
      where: { shop, id: jobId },
      data: {
        priority: String(formData.get("priority") || "normal"),
        assignedTo: String(formData.get("assignedTo") || "") || null,
        dueDate: dueDate ? new Date(`${dueDate}T12:00:00`) : null,
        internalNotes: String(formData.get("internalNotes") || "") || null,
        customerNotes: String(formData.get("customerNotes") || "") || null,
        artworkUrl: String(formData.get("artworkUrl") || "") || null,
        proofUrl: String(formData.get("proofUrl") || "") || null,
        printFileUrl: String(formData.get("printFileUrl") || "") || null,
        productImageUrl: String(formData.get("productImageUrl") || "") || null,
      },
    });
    await createEvent(shop, jobId, "job_updated", "Production job details updated.");
    return Response.json({ ok: true, message: "Job updated." });
  }

  if (intent === "addFile") {
    const jobId = String(formData.get("jobId") || "");
    const fileUrl = String(formData.get("fileUrl") || "").trim();
    if (!fileUrl) return Response.json({ ok: false, message: "File URL is required." }, { status: 400 });
    const fileName = String(formData.get("fileName") || "") || fileUrl.split("/").pop() || "Production file";
    const fileType = String(formData.get("fileType") || "artwork");

    await db.productionJobFile.create({
      data: {
        shop,
        jobId,
        fileName,
        fileType,
        fileUrl,
        notes: String(formData.get("fileNotes") || "") || null,
      },
    });
    await createEvent(shop, jobId, "file_added", `${fileType} file added: ${fileName}.`);
    return Response.json({ ok: true, message: "File added." });
  }

  if (intent === "toggleChecklist") {
    const checklistId = String(formData.get("checklistId") || "");
    const jobId = String(formData.get("jobId") || "");
    const completed = String(formData.get("completed") || "false") === "true";
    await db.productionChecklistItem.updateMany({
      where: { shop, id: checklistId, jobId },
      data: { completed, completedAt: completed ? new Date() : null },
    });
    await createEvent(shop, jobId, "checklist_updated", `Checklist item marked ${completed ? "complete" : "incomplete"}.`);
    return Response.json({ ok: true, message: "Checklist updated." });
  }

  if (intent === "addNote") {
    const jobId = String(formData.get("jobId") || "");
    const note = String(formData.get("note") || "").trim();
    if (!note) return Response.json({ ok: false, message: "Note cannot be empty." }, { status: 400 });
    await createEvent(shop, jobId, "note", note);
    return Response.json({ ok: true, message: "Note added." });
  }

  if (intent === "markPrinted") {
    const jobId = String(formData.get("jobId") || "");
    await db.productionJob.updateMany({ where: { shop, id: jobId }, data: { printedAt: new Date() } });
    await createEvent(shop, jobId, "work_order_printed", "Work order marked printed.");
    return Response.json({ ok: true, message: "Work order print event tracked." });
  }

  return Response.json({ ok: false, message: "Unknown production action." }, { status: 400 });
}

function JobCard({ job }: { job: any }) {
  const navigate = useNavigate();
  const firstImage = job.productImageUrl || job.items?.find((item: any) => item.productImageUrl)?.productImageUrl;
  const totalRevenue = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
  const totalCost = (job.items || []).reduce((sum: number, item: any) => sum + Number(item.quantity || 0) * Number(item.unitCost || 0), 0);

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="start">
          <InlineStack gap="300" blockAlign="start">
            {firstImage ? (
              <img src={firstImage} alt="Product" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 12, border: "1px solid #ddd" }} />
            ) : (
              <div style={{ width: 96, height: 96, borderRadius: 12, border: "1px dashed #bbb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>
                No image
              </div>
            )}
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">{job.company || job.customerName || "Production Job"}</Text>
              <Text as="p" tone="subdued">Job {job.id} | Quote {job.quoteId || "N/A"}</Text>
              <InlineStack gap="200">
                <Badge tone="success">{labelForStatus(job.status)}</Badge>
                <Badge>{job.priority}</Badge>
                {job.dueDate ? <Badge>Due {new Date(job.dueDate).toLocaleDateString()}</Badge> : null}
              </InlineStack>
            </BlockStack>
          </InlineStack>
          <InlineStack gap="200">
            <Button onClick={() => navigate(`/app/erp/production/${job.id}/proof`)}>Edit Proof</Button>
            <Button onClick={() => navigate(`/app/erp/production/${job.id}/print`)}>Print Work Order</Button>
            <Form method="post">
              <input type="hidden" name="intent" value="markPrinted" />
              <input type="hidden" name="jobId" value={job.id} />
              <Button submit>Mark printed</Button>
            </Form>
          </InlineStack>
        </InlineStack>

        <InlineStack gap="300" wrap>
          <Text as="p">Revenue: ${money(totalRevenue)}</Text>
          <Text as="p">Cost: ${money(totalCost)}</Text>
          <Text as="p">Profit: ${money(totalRevenue - totalCost)}</Text>
          <Text as="p">Assigned: {job.assignedTo || "Unassigned"}</Text>
        </InlineStack>

        <Divider />

        <BlockStack gap="200">
          <Text as="h4" variant="headingSm">Items / variants</Text>
          {(job.items || []).map((item: any) => (
            <Card key={item.id}>
              <InlineStack gap="300" blockAlign="start" wrap>
                {item.productImageUrl ? (
                  <img src={item.productImageUrl} alt="Item" style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 10, border: "1px solid #ddd" }} />
                ) : null}
                <BlockStack gap="050">
                  <Text as="p" fontWeight="bold">{item.productTitle}</Text>
                  <Text as="p" tone="subdued">Variant: {item.variantTitle || "None"} | SKU: {item.sku || "None"}</Text>
                  <Text as="p">Qty: {item.quantity} | Finish/Add-ons: {item.selectedFinish || item.selectedAddOns || "None"}</Text>
                  {item.recipeName ? <Text as="p" tone="subdued">Recipe: {item.recipeName}</Text> : null}
                </BlockStack>
              </InlineStack>
            </Card>
          ))}
        </BlockStack>

        <InlineStack gap="300" wrap>
          <div style={{ minWidth: 260, flex: 1 }}>
            <Form method="post">
              <input type="hidden" name="intent" value="changeStatus" />
              <input type="hidden" name="jobId" value={job.id} />
              <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Move job to</label>
              <select name="status" defaultValue={job.status} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }}>
                {productionStatuses.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
              </select>
              <Button submit>Update status</Button>
            </Form>
          </div>

          <div style={{ minWidth: 320, flex: 2 }}>
            <Form method="post">
              <input type="hidden" name="intent" value="updateJob" />
              <input type="hidden" name="jobId" value={job.id} />
              <BlockStack gap="200">
                <InlineStack gap="200">
                  <div style={{ minWidth: 160 }}>
                    <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Priority</label>
                    <select name="priority" defaultValue={job.priority || "normal"} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }}>
                      {priorityOptions.map((priority) => <option key={priority.value} value={priority.value}>{priority.label}</option>)}
                    </select>
                  </div>
                  <TextField label="Due date" name="dueDate" type="date" defaultValue={safeDateInput(job.dueDate)} autoComplete="off" />
                  <TextField label="Assigned to" name="assignedTo" defaultValue={job.assignedTo || ""} autoComplete="off" />
                </InlineStack>
                <TextField label="Product image URL" name="productImageUrl" defaultValue={job.productImageUrl || ""} autoComplete="off" />
                <TextField label="Artwork URL" name="artworkUrl" defaultValue={job.artworkUrl || ""} autoComplete="off" />
                <TextField label="Proof URL" name="proofUrl" defaultValue={job.proofUrl || ""} autoComplete="off" />
                <TextField label="Print file URL" name="printFileUrl" defaultValue={job.printFileUrl || ""} autoComplete="off" />
                <TextField label="Internal notes" name="internalNotes" defaultValue={job.internalNotes || ""} multiline={3} autoComplete="off" />
                <TextField label="Customer notes" name="customerNotes" defaultValue={job.customerNotes || ""} multiline={2} autoComplete="off" />
                <Button submit>Save job details</Button>
              </BlockStack>
            </Form>
          </div>
        </InlineStack>

        <InlineStack gap="300" align="start" wrap>
          <div style={{ minWidth: 280, flex: 1 }}>
            <Card>
              <BlockStack gap="200">
                <Text as="h4" variant="headingSm">Checklist</Text>
                {(job.checklistItems || []).map((check: any) => (
                  <Form method="post" key={check.id}>
                    <input type="hidden" name="intent" value="toggleChecklist" />
                    <input type="hidden" name="jobId" value={job.id} />
                    <input type="hidden" name="checklistId" value={check.id} />
                    <input type="hidden" name="completed" value={check.completed ? "false" : "true"} />
                    <Checkbox label={`${check.section}: ${check.label}`} checked={check.completed} onChange={() => {}} />
                    <Button submit>{check.completed ? "Undo" : "Complete"}</Button>
                  </Form>
                ))}
              </BlockStack>
            </Card>
          </div>

          <div style={{ minWidth: 320, flex: 1 }}>
            <Card>
              <BlockStack gap="200">
                <Text as="h4" variant="headingSm">Files / attachments</Text>
                {(job.files || []).length ? (job.files || []).map((file: any) => (
                  <Text as="p" key={file.id}><a href={file.fileUrl} target="_blank" rel="noreferrer">{file.fileName}</a> ({file.fileType})</Text>
                )) : <Text as="p" tone="subdued">No file links yet.</Text>}
                <Form method="post">
                  <input type="hidden" name="intent" value="addFile" />
                  <input type="hidden" name="jobId" value={job.id} />
                  <BlockStack gap="150">
                    <TextField label="File name" name="fileName" autoComplete="off" />
                    <div>
                      <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>File type</label>
                      <select name="fileType" defaultValue="artwork" style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }}>
                        {fileTypeOptions.map((fileType) => <option key={fileType.value} value={fileType.value}>{fileType.label}</option>)}
                      </select>
                    </div>
                    <TextField label="File URL / PDF / artwork link" name="fileUrl" autoComplete="off" />
                    <TextField label="Notes" name="fileNotes" autoComplete="off" />
                    <Button submit>Add file link</Button>
                  </BlockStack>
                </Form>
              </BlockStack>
            </Card>
          </div>

          <div style={{ minWidth: 320, flex: 1 }}>
            <Card>
              <BlockStack gap="200">
                <Text as="h4" variant="headingSm">Event log / notes</Text>
                <Form method="post">
                  <input type="hidden" name="intent" value="addNote" />
                  <input type="hidden" name="jobId" value={job.id} />
                  <TextField label="Add production note" name="note" autoComplete="off" />
                  <Button submit>Add note</Button>
                </Form>
                {(job.events || []).map((event: any) => (
                  <Text as="p" key={event.id} tone="subdued">{new Date(event.createdAt).toLocaleString()}: {event.message}</Text>
                ))}
              </BlockStack>
            </Card>
          </div>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

export default function ProductionBoard() {
  const { jobs, quotes } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const quoteOptions = [
    { label: "Choose approved / paid quote", value: "" },
    ...quotes.map((quote: any) => ({
      label: `${quote.company || quote.customerName || quote.email || quote.id} | ${quote.status} | ${quote.items?.length || 0} item(s)`,
      value: quote.id,
    })),
  ];

  const statusGroups = productionStatuses
    .map((status) => ({ ...status, jobs: jobs.filter((job: any) => job.status === status.value) }))
    .filter((group) => group.jobs.length || ["new", "prepress", "printing", "qc", "completed"].includes(group.value));

  return (
    <Page title="Production Board" subtitle="Create production jobs from approved/paid quotes, track stages, files, variants, notes, alerts, and printable work orders.">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Create production job</Text>
                  <Text as="p" tone="subdued">Production jobs snapshot quote items, variants, quantities, images, recipes, file links, and pricing/cost data.</Text>
                </BlockStack>
                <Badge tone="success">{jobs.length} active job(s)</Badge>
              </InlineStack>
              {actionData?.message ? <Text as="p" tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Text> : null}
              <Form method="post">
                <input type="hidden" name="intent" value="createFromQuote" />
                <InlineStack gap="300" blockAlign="end">
                  <div style={{ minWidth: 360, flex: 1 }}>
                    <label style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>Approved / paid quote</label>
                    <select name="quoteId" defaultValue="" style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" }}>
                      {quoteOptions.map((quote) => <option key={quote.value} value={quote.value}>{quote.label}</option>)}
                    </select>
                  </div>
                  <Button submit variant="primary" loading={busy}>Create from quote</Button>
                </InlineStack>
              </Form>
              <Text as="p" tone="subdued">Slack alerts are sent automatically if SLACK_WEBHOOK_URL or PRODUCTION_SLACK_WEBHOOK_URL is set in Render.</Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {statusGroups.map((group) => (
          <Layout.Section key={group.value}>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">{group.label}</Text>
                <Badge>{group.jobs.length}</Badge>
              </InlineStack>
              {group.jobs.length ? group.jobs.map((job: any) => <JobCard key={job.id} job={job} />) : <Card><Text as="p" tone="subdued">No jobs in this stage.</Text></Card>}
            </BlockStack>
          </Layout.Section>
        ))}
      </Layout>
    </Page>
  );
}
