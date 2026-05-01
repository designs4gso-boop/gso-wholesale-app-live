import { useLoaderData } from "react-router";
import db from "../db.server";

export async function loader({ params }: { params: { id: string } }) {
  const quote = await db.quote.findUnique({
    where: { id: params.id },
    include: { items: true },
  });

  if (!quote) {
    throw new Response("Quote not found", { status: 404 });
  }

  const total = quote.items.reduce((sum, item) => {
    return sum + Number(item.quantity || 0) * Number(item.unitPrice || 0);
  }, 0);

  return Response.json({ quote, total });
}

export default function QuotePortal() {
  const { quote, total } = useLoaderData<typeof loader>() as any;

  return (
    <main style={{ maxWidth: 900, margin: "40px auto", padding: 24, fontFamily: "Arial" }}>
      <h1>GSO Packaging Quote</h1>

      <p><strong>Customer:</strong> {quote.customerName || "Customer"}</p>
      <p><strong>Company:</strong> {quote.company || "N/A"}</p>
      <p><strong>Status:</strong> {quote.status}</p>

      <hr />

      <h2>Quote Items</h2>

      {quote.items.map((item: any) => (
        <div key={item.id} style={{ border: "1px solid #ddd", padding: 16, marginBottom: 12 }}>
          <strong>{item.productName}</strong>
          <p>Variant: {item.variant || "N/A"}</p>
          <p>Qty: {item.quantity}</p>
          <p>Unit Price: ${Number(item.unitPrice).toFixed(2)}</p>
          <p>Line Total: ${(Number(item.quantity) * Number(item.unitPrice)).toFixed(2)}</p>
        </div>
      ))}

      <hr />

      <h2>Total: ${total.toFixed(2)}</h2>

      {quote.depositCreated && (
        <>
          <p><strong>Deposit:</strong> ${Number(quote.depositAmount || 0).toFixed(2)}</p>
          <p><strong>Balance Due:</strong> ${Number(quote.balanceDue || 0).toFixed(2)}</p>
        </>
      )}

      <hr />

      <h2>Payment Status</h2>

      <p>
        Deposit Created: {quote.depositCreated ? "Yes" : "No"}
      </p>

      <p>
        Balance Created: {quote.balanceCreated ? "Yes" : "No"}
      </p>

      <p>
        Full Order Created: {quote.fullOrderCreated ? "Yes" : "No"}
      </p>

      <p style={{ marginTop: 32 }}>
        Questions? Contact GSO Packaging directly.
      </p>
    </main>
  );
}