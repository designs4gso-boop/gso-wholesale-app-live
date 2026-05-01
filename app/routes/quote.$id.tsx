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
    <main style={{
      maxWidth: 900,
      margin: "40px auto",
      padding: 24,
      fontFamily: "Inter, Arial",
      background: "#111",
      color: "#fff",
      borderRadius: 12
    }}>

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

<hr />

<h2>Payments</h2>

{quote.depositCreated && quote.depositDraftOrderId && (
  <a
    href={`https://admin.shopify.com/store/942075-2/draft_orders/${quote.depositDraftOrderId}`}
    target="_blank"
  >
    <button style={{ padding: "12px 20px", marginRight: 10 }}>
      Pay Deposit
    </button>
  </a>
)}

{quote.balanceCreated && quote.balanceDraftOrderId && (
  <a
    href={`https://admin.shopify.com/store/YOUR_STORE/draft_orders/${quote.balanceDraftOrderId}`}
    target="_blank"
  >
    <button style={{ padding: "12px 20px" }}>
      Pay Remaining Balance
    </button>
  </a>
)}

      {quote.depositCreated && (
        <>
          <p><strong>Deposit:</strong> ${Number(quote.depositAmount || 0).toFixed(2)}</p>
          <p><strong>Balance Due:</strong> ${Number(quote.balanceDue || 0).toFixed(2)}</p>
        </>
      )}

      <hr />

      <h2>Payment Status</h2>

      {quote.fullOrderCreated && (
        <p>
          ✅ Full payment invoice has been created. Please complete payment using the checkout link provided by GSO.
        </p>
     )}

      {quote.depositCreated && !quote.balanceCreated && !quote.fullOrderCreated && (
        <p>
          ✅ Deposit invoice has been created. Once deposit is paid, GSO will prepare your order and send the remaining balance invoice.
        </p>
     )}

      {quote.depositCreated && quote.balanceCreated && !quote.fullOrderCreated && (
        <p>
          ✅ Deposit invoice created. ✅ Remaining balance invoice created. Please complete any unpaid invoices sent by GSO.
        </p>
     )}

      {!quote.depositCreated && !quote.balanceCreated && !quote.fullOrderCreated && (
        <p>
          Your quote is ready. GSO will send your payment invoice when approved.
       </p>
     )}

      {quote.depositCreated && (
        <>
         <p>
           <strong>Deposit Amount:</strong> ${Number(quote.depositAmount || 0).toFixed(2)}
         </p>
         <p>
          <strong>Balance Due:</strong> ${Number(quote.balanceDue || 0).toFixed(2)}
         </p>
       </>
     )}

      <p style={{ marginTop: 32 }}>
        Questions? Contact GSO Packaging directly.
      </p>
    </main>
  );
}