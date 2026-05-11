import { Form, useActionData, useLoaderData } from "react-router";
import db from "../db.server";

function safeDate(value: any) {
  if (!value) return new Date().toLocaleDateString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toLocaleDateString();
  return date.toLocaleDateString();
}

function labelForStatus(status: string) {
  return String(status || "new").replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function bestImage(job: any) {
  return job.productImageUrl || job.items?.find((item: any) => item.productImageUrl)?.productImageUrl || "";
}

function bestArtwork(job: any) {
  return job.artworkUrl || job.files?.find((file: any) => file.assetRole === "artwork" || file.fileType === "artwork")?.fileUrl || "";
}

async function createEvent(shop: string, jobId: string, eventType: string, message: string, data?: { createdBy?: string }) {
  return db.productionJobEvent.create({
    data: {
      shop,
      jobId,
      eventType,
      message,
      createdBy: data?.createdBy || "customer_portal",
    },
  });
}

export async function loader({ params }: { params: any }) {
  const token = String(params.token || "");

  const job = await db.productionJob.findFirst({
    where: { proofApprovalToken: token, active: true },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      files: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!job) throw new Response("Proof link not found or expired.", { status: 404 });

  if (!job.proofViewedAt && job.proofStatus !== "approved") {
    await db.productionJob.update({
      where: { id: job.id },
      data: { proofViewedAt: new Date(), proofStatus: job.proofStatus === "draft" ? "viewed" : job.proofStatus },
    });
    await createEvent(job.shop, job.id, "proof_viewed", "Customer proof link opened.");
  }

  return Response.json({ job });
}

export async function action({ request, params }: { request: Request; params: any }) {
  const token = String(params.token || "");
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const customerName = String(formData.get("customerName") || "").trim();
  const customerEmail = String(formData.get("customerEmail") || "").trim();
  const comment = String(formData.get("comment") || "").trim();

  const job = await db.productionJob.findFirst({ where: { proofApprovalToken: token, active: true } });
  if (!job) throw new Response("Proof link not found or expired.", { status: 404 });

  if (intent === "approve") {
    await db.productionJob.update({
      where: { id: job.id },
      data: {
        status: "proof_approved",
        proofStatus: "approved",
        proofApprovedAt: new Date(),
        proofCustomerName: customerName || job.customerName,
        proofCustomerEmail: customerEmail || job.email,
        proofCustomerComment: comment || "Approved through customer proof portal.",
      },
    });
    await createEvent(job.shop, job.id, "proof_approved_customer", `Customer approved proof.${comment ? ` Comment: ${comment}` : ""}`);
    return Response.json({ ok: true, message: "Proof approved. Thank you — production has been notified." });
  }

  if (intent === "requestChanges") {
    if (!comment) return Response.json({ ok: false, message: "Please enter the changes needed before submitting." }, { status: 400 });
    await db.productionJob.update({
      where: { id: job.id },
      data: {
        status: "proof_needed",
        proofStatus: "changes_requested",
        proofRejectedAt: new Date(),
        proofCustomerName: customerName || job.customerName,
        proofCustomerEmail: customerEmail || job.email,
        proofCustomerComment: comment,
      },
    });
    await createEvent(job.shop, job.id, "proof_changes_requested", `Customer requested proof changes: ${comment}`);
    return Response.json({ ok: true, message: "Change request sent. GSO will review and update your proof." });
  }

  return Response.json({ ok: false, message: "Unknown proof action." }, { status: 400 });
}

export default function CustomerProofApproval() {
  const { job } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const productImage = bestImage(job);
  const artwork = bestArtwork(job);
  const approved = job.proofStatus === "approved";
  const changesRequested = job.proofStatus === "changes_requested";

  return (
    <main style={{ fontFamily: "Arial, sans-serif", background: "#f4f4f4", minHeight: "100vh", padding: 24, color: "#111" }}>
      <style>{`
        .page { max-width: 1040px; margin: 0 auto; }
        .card { background: white; border: 1px solid #ddd; border-radius: 16px; padding: 18px; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.04); }
        .header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
        .logo { font-size: 32px; font-weight: 900; letter-spacing: 2px; }
        .pill { display: inline-block; padding: 6px 10px; border-radius: 999px; border: 1px solid #111; margin: 4px 4px 0 0; font-size: 12px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
        .imageBox { border: 2px dashed #aaa; border-radius: 14px; min-height: 300px; display: flex; align-items: center; justify-content: center; background: #fafafa; overflow: hidden; text-align: center; }
        .imageBox img { max-width: 100%; max-height: 380px; object-fit: contain; }
        table { width: 100%; border-collapse: collapse; margin-top: 8px; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }
        th { background: #f1f1f1; }
        input, textarea { width: 100%; padding: 10px; border: 1px solid #aaa; border-radius: 10px; font-size: 14px; box-sizing: border-box; }
        button { padding: 12px 16px; border-radius: 10px; border: 1px solid #111; cursor: pointer; font-weight: 700; }
        .approve { background: #111; color: white; }
        .changes { background: white; color: #111; }
        .statusApproved { background: #dcfce7; border-color: #16a34a; }
        .statusChanges { background: #fee2e2; border-color: #dc2626; }
        @media (max-width: 800px) { .grid, .header { grid-template-columns: 1fr; display: block; } }
        @media print { .actions { display: none; } body { background: white; } .card { box-shadow: none; } }
      `}</style>

      <div className="page">
        <section className="card header">
          <div>
            <div className="logo">GSO PACKAGING</div>
            <h1>Proof Approval</h1>
            <span className="pill">Job Ticket: {job.jobTicket || job.id}</span>
            <span className="pill">Status: {labelForStatus(job.proofStatus || job.status)}</span>
            <span className="pill">Date: {safeDate(new Date())}</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <strong>{job.company || job.customerName || "Customer"}</strong><br />
            {job.email || ""}<br />
            {job.phone || ""}
          </div>
        </section>

        {actionData?.message ? (
          <section className={`card ${actionData.ok ? "statusApproved" : "statusChanges"}`}>
            <strong>{actionData.message}</strong>
          </section>
        ) : null}

        {approved ? (
          <section className="card statusApproved">
            <h2>Proof Approved</h2>
            <p>This proof was approved on {safeDate(job.proofApprovedAt)}. GSO has been notified.</p>
          </section>
        ) : null}

        {changesRequested ? (
          <section className="card statusChanges">
            <h2>Changes Requested</h2>
            <p>GSO has received the requested changes and will update the proof.</p>
          </section>
        ) : null}

        <section className="grid">
          <div className="card">
            <h2>Product / Mockup</h2>
            <div className="imageBox">{productImage ? <img src={productImage} alt="Product mockup" /> : <span>No product image available yet.</span>}</div>
          </div>
          <div className="card">
            <h2>Artwork / Proof Art</h2>
            <div className="imageBox">{artwork ? <img src={artwork} alt="Artwork" /> : <span>No artwork image available yet.</span>}</div>
          </div>
        </section>

        <section className="card">
          <h2>Items / Variants</h2>
          <table>
            <thead>
              <tr>
                <th>Item Ticket</th>
                <th>Product</th>
                <th>Variant / SKU</th>
                <th>Qty</th>
                <th>Finish / Add-ons</th>
              </tr>
            </thead>
            <tbody>
              {(job.items || []).map((item: any) => (
                <tr key={item.id}>
                  <td>{item.itemTicket || item.ripJobName || ""}</td>
                  <td>{item.productTitle}</td>
                  <td>{item.variantTitle || ""}<br />{item.sku || ""}</td>
                  <td>{item.quantity}</td>
                  <td>{item.selectedFinish || item.selectedAddOns || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Approval Responsibility</h2>
          <p>Please review spelling, layout, colors, size, product details, barcode/QR codes, compliance text, and all final artwork details before approving. Once approved, the job may move into production.</p>
        </section>

        {!approved ? (
          <section className="card actions">
            <h2>Approve or Request Changes</h2>
            <Form method="post">
              <div className="grid">
                <div>
                  <label>Your name</label>
                  <input name="customerName" defaultValue={job.proofCustomerName || job.customerName || ""} />
                </div>
                <div>
                  <label>Your email</label>
                  <input name="customerEmail" defaultValue={job.proofCustomerEmail || job.email || ""} />
                </div>
              </div>
              <br />
              <label>Comments / requested changes</label>
              <textarea name="comment" rows={5} placeholder="Leave blank if approving, or describe the exact changes needed." defaultValue={job.proofCustomerComment || ""} />
              <br /><br />
              <button className="approve" type="submit" name="intent" value="approve">Approve Proof</button>{" "}
              <button className="changes" type="submit" name="intent" value="requestChanges">Request Changes</button>{" "}
              <button type="button" onClick={() => window.print()}>Print / Save PDF</button>
            </Form>
          </section>
        ) : null}
      </div>
    </main>
  );
}
