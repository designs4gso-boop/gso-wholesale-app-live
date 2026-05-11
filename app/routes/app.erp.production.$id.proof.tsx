import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
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
  return job.artworkUrl || job.files?.find((file: any) => file.fileType === "artwork")?.fileUrl || "";
}

async function createEvent(shop: string, jobId: string, eventType: string, message: string) {
  return db.productionJobEvent.create({ data: { shop, jobId, eventType, message } });
}

export async function loader({ request, params }: { request: Request; params: any }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const id = params.id;

  const job = await db.productionJob.findFirst({
    where: { shop, id },
    include: {
      items: { orderBy: { sortOrder: "asc" } },
      files: { orderBy: { createdAt: "desc" } },
      events: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  if (!job) throw new Response("Production job not found", { status: 404 });

  return Response.json({ job });
}

export async function action({ request, params }: { request: Request; params: any }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const id = params.id;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  const job = await db.productionJob.findFirst({ where: { shop, id } });
  if (!job) throw new Response("Production job not found", { status: 404 });

  if (intent === "saveProof") {
    const productImageUrl = String(formData.get("productImageUrl") || "").trim();
    const artworkUrl = String(formData.get("artworkUrl") || "").trim();
    const proofNotes = String(formData.get("proofNotes") || "").trim();
    const revision = String(formData.get("revision") || "1").trim() || "1";
    const proofUrl = `/app/erp/production/${id}/proof?rev=${encodeURIComponent(revision)}`;

    await db.productionJob.update({
      where: { id },
      data: {
        productImageUrl: productImageUrl || job.productImageUrl,
        artworkUrl: artworkUrl || job.artworkUrl,
        proofUrl,
        internalNotes: proofNotes ? `${job.internalNotes || ""}\n\nProof Rev ${revision}: ${proofNotes}`.trim() : job.internalNotes,
      },
    });

    await db.productionJobFile.create({
      data: {
        shop,
        jobId: id,
        fileName: `Standard GSO Proof Rev ${revision}`,
        fileType: "proof",
        fileUrl: proofUrl,
        notes: proofNotes || "Saved standard GSO proof revision.",
      },
    });

    await createEvent(shop, id, "proof_saved", `Standard GSO proof revision ${revision} saved.`);
    return Response.json({ ok: true, message: `Proof revision ${revision} saved.` });
  }

  if (intent === "approveProof") {
    await db.productionJob.update({ where: { id }, data: { status: "proof_approved" } });
    await createEvent(shop, id, "proof_approved", "Proof approved internally/customer-approved and job moved to Proof Approved.");
    return Response.json({ ok: true, message: "Proof approved." });
  }

  return Response.json({ ok: false, message: "Unknown proof action." }, { status: 400 });
}

export default function StandardGsoProofSheet() {
  const { job } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const productImage = bestImage(job);
  const artwork = bestArtwork(job);
  const revisionCount = (job.files || []).filter((file: any) => file.fileType === "proof").length || 1;

  return (
    <div style={{ fontFamily: "Arial, sans-serif", color: "#111", padding: 24 }}>
      <style>{`
        .no-print { margin-bottom: 18px; }
        .proof-page { max-width: 1100px; margin: 0 auto; border: 1px solid #222; padding: 24px; }
        .top { display: flex; justify-content: space-between; gap: 24px; border-bottom: 3px solid #111; padding-bottom: 16px; }
        .logo { font-size: 34px; font-weight: 900; letter-spacing: 2px; }
        .pill { display: inline-block; border: 1px solid #111; border-radius: 999px; padding: 6px 10px; margin: 4px 4px 4px 0; font-size: 12px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 18px; }
        .card { border: 1px solid #999; border-radius: 12px; padding: 14px; min-height: 90px; }
        .preview { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 18px; }
        .imageBox { border: 2px dashed #999; border-radius: 14px; min-height: 320px; display: flex; align-items: center; justify-content: center; background: #fafafa; overflow: hidden; }
        .imageBox img { max-width: 100%; max-height: 420px; object-fit: contain; }
        table { width: 100%; border-collapse: collapse; margin-top: 14px; }
        th, td { border: 1px solid #999; padding: 8px; text-align: left; vertical-align: top; }
        th { background: #eee; }
        input, textarea { width: 100%; padding: 8px; border: 1px solid #999; border-radius: 8px; }
        button { padding: 9px 14px; border-radius: 8px; border: 1px solid #222; cursor: pointer; }
        @media print { .no-print { display: none !important; } body { margin: 0; } .proof-page { border: none; padding: 0; } }
      `}</style>

      <div className="no-print">
        <Form method="post">
          <input type="hidden" name="intent" value="saveProof" />
          <div className="grid">
            <div className="card">
              <strong>Edit proof assets</strong>
              <p>Use Shopify/customer artwork links, then save a revision. The printable proof below updates immediately after refresh.</p>
              <label>Product image URL</label>
              <input name="productImageUrl" defaultValue={productImage} />
              <br /><br />
              <label>Artwork URL</label>
              <input name="artworkUrl" defaultValue={artwork} />
            </div>
            <div className="card">
              <label>Revision</label>
              <input name="revision" defaultValue={String(revisionCount + 1)} />
              <br /><br />
              <label>Proof notes</label>
              <textarea name="proofNotes" defaultValue="Standard GSO proof layout. Review image placement, product info, and customer approval notes." />
              <br /><br />
              <button type="submit">Save Proof Revision</button>{" "}
              <button type="button" onClick={() => window.print()}>Print / Save PDF</button>
            </div>
          </div>
        </Form>
        <Form method="post" style={{ marginTop: 12 }}>
          <input type="hidden" name="intent" value="approveProof" />
          <button type="submit">Mark Proof Approved</button>
        </Form>
        {actionData?.message ? <p>{actionData.message}</p> : null}
      </div>

      <div className="proof-page">
        <div className="top">
          <div>
            <div className="logo">GSO PACKAGING</div>
            <h1>Production Proof Sheet</h1>
            <span className="pill">Job: {job.id}</span>
            <span className="pill">Quote: {job.quoteId || "N/A"}</span>
            <span className="pill">Status: {labelForStatus(job.status)}</span>
          </div>
          <div style={{ textAlign: "right" }}>
            <h2>REV {revisionCount}</h2>
            <div>{safeDate(new Date())}</div>
            <div>{job.company || job.customerName || "Customer"}</div>
          </div>
        </div>

        <div className="grid">
          <div className="card">
            <h3>Customer</h3>
            <div><strong>Company:</strong> {job.company || ""}</div>
            <div><strong>Name:</strong> {job.customerName || ""}</div>
            <div><strong>Email:</strong> {job.email || ""}</div>
            <div><strong>Phone:</strong> {job.phone || ""}</div>
          </div>
          <div className="card">
            <h3>Approval</h3>
            <p>Customer is responsible for verifying spelling, layout, color expectation, size, strain/product details, barcode/QR, compliance text, and final artwork before production.</p>
            <p>Approved by: _______________________ Date: _____________</p>
          </div>
        </div>

        <div className="preview">
          <div className="card">
            <h3>Product / Mockup Image</h3>
            <div className="imageBox">
              {productImage ? <img src={productImage} alt="Product" /> : <span>No product image linked</span>}
            </div>
          </div>
          <div className="card">
            <h3>Customer Artwork / Proof Art</h3>
            <div className="imageBox">
              {artwork ? <img src={artwork} alt="Artwork" /> : <span>No artwork image linked yet</span>}
            </div>
          </div>
        </div>

        <div className="card" style={{ marginTop: 18 }}>
          <h3>Items / Variants</h3>
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Variant / SKU</th>
                <th>Qty</th>
                <th>Finish / Add-ons</th>
                <th>Recipe</th>
              </tr>
            </thead>
            <tbody>
              {(job.items || []).map((item: any) => (
                <tr key={item.id}>
                  <td>{item.productTitle}</td>
                  <td>{item.variantTitle || ""}<br />{item.sku || ""}</td>
                  <td>{item.quantity}</td>
                  <td>{item.selectedFinish || item.selectedAddOns || ""}</td>
                  <td>{item.recipeName || item.recipeId || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card" style={{ marginTop: 18 }}>
          <h3>Production / Proof Notes</h3>
          <p>{job.internalNotes || ""}</p>
          <p>{job.customerNotes || ""}</p>
        </div>

        <div className="card" style={{ marginTop: 18 }}>
          <h3>Files</h3>
          <p><strong>Artwork:</strong> {job.artworkUrl || "Not linked"}</p>
          <p><strong>Current Proof:</strong> {job.proofUrl || `/app/erp/production/${job.id}/proof`}</p>
          <p><strong>Print File:</strong> {job.printFileUrl || "Not linked"}</p>
        </div>
      </div>
    </div>
  );
}
