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
  const isPaid = quote.status === "paid";

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <div style={styles.header}>
          <div>
            <h1 style={styles.title}>GSO Packaging Quote</h1>
            <p style={styles.subtitle}>Custom wholesale packaging invoice portal</p>
          </div>
          <div style={styles.badge}>{quote.status}</div>
        </div>

        <div style={styles.infoGrid}>
          <div>
            <p style={styles.label}>Customer</p>
            <p style={styles.value}>{quote.customerName || "Customer"}</p>
          </div>
          <div>
            <p style={styles.label}>Company</p>
            <p style={styles.value}>{quote.company || "N/A"}</p>
          </div>
          <div>
            <p style={styles.label}>Quote ID</p>
            <p style={styles.value}>{quote.id}</p>
          </div>
        </div>

        <hr style={styles.hr} />

        <h2 style={styles.sectionTitle}>Quote Items</h2>

        {quote.items.map((item: any) => {
          const lineTotal = Number(item.quantity || 0) * Number(item.unitPrice || 0);

          return (
            <div key={item.id} style={styles.itemCard}>
              <div>
                <h3 style={styles.itemTitle}>{item.productName}</h3>
                <p style={styles.muted}>Variant: {item.variant || "N/A"}</p>
                <p style={styles.muted}>SKU: {item.sku || "N/A"}</p>
              </div>

              <div style={styles.itemNumbers}>
                <p>Qty: {item.quantity}</p>
                <p>Unit: ${Number(item.unitPrice || 0).toFixed(2)}</p>
                <strong>${lineTotal.toFixed(2)}</strong>
              </div>
            </div>
          );
        })}

        <div style={styles.totalBox}>
          <span>Total Quote</span>
          <strong>${total.toFixed(2)}</strong>
        </div>

        <hr style={styles.hr} />

        <h2 style={styles.sectionTitle}>Payments</h2>

<div style={styles.paymentGrid}>
  {isPaid ? (
    <div
      style={{
        display: "inline-block",
        padding: "12px 18px",
        borderRadius: 999,
        background: "#22c55e",
        color: "#000",
        fontWeight: 700,
      }}
    >
      Paid
    </div>
  ) : (
    <>
      {quote.depositCreated && quote.depositInvoiceUrl && (
        <a
          href={quote.depositInvoiceUrl}
          target="_blank"
          rel="noreferrer"
          style={styles.primaryButton}
        >
          Pay Deposit
        </a>
      )}

      {quote.balanceCreated && quote.balanceInvoiceUrl && (
        <a
          href={quote.balanceInvoiceUrl}
          target="_blank"
          rel="noreferrer"
          style={styles.secondaryButton}
        >
          Pay Remaining Balance
        </a>
      )}

      {quote.fullOrderCreated && quote.fullInvoiceUrl && (
        <a
          href={quote.fullInvoiceUrl}
          target="_blank"
          rel="noreferrer"
          style={styles.primaryButton}
        >
          Pay Full Invoice
        </a>
      )}
    </>
  )}
</div>

        <hr style={styles.hr} />

        <h2 style={styles.sectionTitle}>Payment Status</h2>

        <div style={styles.statusBox}>
          {isPaid ? (
            <p>✅ Payment received. Your order is confirmed and being processed.</p>
          ) : quote.fullOrderCreated ? (
            <p>✅ Full payment invoice has been created. Please complete payment using the checkout link above.</p>
          ) : null}

          {quote.depositCreated && !quote.balanceCreated && !quote.fullOrderCreated && (
            <p>✅ Deposit invoice has been created. Once deposit is paid, GSO will prepare your order and send the remaining balance invoice.</p>
          )}

          {quote.depositCreated && quote.balanceCreated && !quote.fullOrderCreated && (
            <p>✅ Deposit invoice created. ✅ Remaining balance invoice created. Please complete any unpaid invoices above.</p>
          )}

          {!quote.depositCreated && !quote.balanceCreated && !quote.fullOrderCreated && (
            <p>Your quote is ready. GSO will send your payment invoice when approved.</p>
          )}
        </div>

        <p style={styles.footer}>Questions? Contact GSO Packaging directly.</p>
      </section>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "#f4f4f4",
    padding: "40px 16px",
    fontFamily: "Inter, Arial, sans-serif",
  },
  card: {
    maxWidth: 960,
    margin: "0 auto",
    background: "#111",
    color: "#fff",
    borderRadius: 18,
    padding: 28,
    boxShadow: "0 20px 60px rgba(0,0,0,0.18)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    alignItems: "flex-start",
    flexWrap: "wrap",
  },
  title: {
    margin: 0,
    fontSize: 32,
    letterSpacing: "-0.04em",
  },
  subtitle: {
    marginTop: 8,
    color: "#bbb",
  },
  badge: {
    background: "#22c55e",
    color: "#07130a",
    padding: "8px 12px",
    borderRadius: 999,
    fontWeight: 700,
    textTransform: "capitalize",
  },
  infoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 16,
    marginTop: 28,
  },
  label: {
    color: "#999",
    margin: 0,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  value: {
    margin: "6px 0 0",
    fontWeight: 700,
    wordBreak: "break-word",
  },
  hr: {
    border: 0,
    borderTop: "1px solid #333",
    margin: "28px 0",
  },
  sectionTitle: {
    margin: "0 0 14px",
    fontSize: 20,
  },
  itemCard: {
    border: "1px solid #333",
    borderRadius: 14,
    padding: 18,
    marginBottom: 12,
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
    background: "#181818",
  },
  itemTitle: {
    margin: 0,
    fontSize: 18,
  },
  muted: {
    color: "#bbb",
    margin: "6px 0 0",
  },
  itemNumbers: {
    textAlign: "right",
    minWidth: 150,
  },
  totalBox: {
    marginTop: 20,
    background: "#fff",
    color: "#111",
    borderRadius: 14,
    padding: 18,
    display: "flex",
    justifyContent: "space-between",
    fontSize: 22,
  },
  paymentGrid: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
  },
  primaryButton: {
    background: "#fff",
    color: "#111",
    padding: "13px 20px",
    borderRadius: 10,
    textDecoration: "none",
    fontWeight: 800,
  },
  secondaryButton: {
    background: "#333",
    color: "#fff",
    padding: "13px 20px",
    borderRadius: 10,
    textDecoration: "none",
    fontWeight: 800,
    border: "1px solid #555",
  },
  balanceBox: {
    marginTop: 18,
    background: "#181818",
    border: "1px solid #333",
    padding: 16,
    borderRadius: 14,
  },
  statusBox: {
    background: "#181818",
    border: "1px solid #333",
    padding: 16,
    borderRadius: 14,
    color: "#ddd",
  },
  footer: {
    marginTop: 30,
    color: "#bbb",
  },
};