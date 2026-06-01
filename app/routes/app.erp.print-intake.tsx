import { useLoaderData } from "react-router";
import crypto from "crypto";
import { authenticate } from "../shopify.server";
import db from "../db.server";

async function ensureSetting(shop: string) {
  return db.printLogAutoImportSetting.upsert({
    where: { shop },
    update: {},
    create: {
      shop,
      uploadToken: crypto.randomUUID(),
      incomingFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\Prints For Today",
      versaworksFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\versaworks\\incoming",
      rasterlinkFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\rasterlink\\incoming",
      processedFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\processed",
      errorFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\error",
      expectedTicketPattern: "GSO-{jobNumber}_{customer}_{product}_{side}_{material}_{route}_R{revision}",
    },
  });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const setting = await ensureSetting(session.shop);
  return { setting };
}

export default function PrintIntake() {
  const { setting } = useLoaderData<typeof loader>();
  const code = `GSO-{JOBID}_{CUSTOMER}_{PRODUCT}_{SIDE}_{MATERIAL}_{ROUTE}_R{REV}.pdf`;
  return (
    <main style={{ maxWidth: 1050, margin: "40px auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <section style={{ background: "linear-gradient(135deg,#111827,#064e3b)", color: "white", padding: 24, borderRadius: 14 }}>
        <h1 style={{ margin: 0 }}>Print Intake Automation</h1>
        <p style={{ margin: "8px 0 0" }}>v14.0 foundation: keep using Prints For Today, but add a naming/validation script before files hit Roland or Mimaki hot folders.</p>
      </section>
      <section style={{ marginTop: 16, border: "1px solid #bfdbfe", background: "#eff6ff", borderRadius: 12, padding: 16 }}>
        <b>Current source folder</b>
        <p style={{ marginBottom: 0 }}><code>{setting.incomingFolder}</code></p>
      </section>
      <section style={{ marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" }}>
        <h2>Required naming rule after automation</h2>
        <p>The local watcher renames files into this format before copying to the RIP hot folder:</p>
        <pre style={{ background: "#f3f4f6", padding: 12, borderRadius: 8, overflowX: "auto" }}>{code}</pre>
        <p>Example:</p>
        <pre style={{ background: "#f3f4f6", padding: 12, borderRadius: 8, overflowX: "auto" }}>GSO-1042_Cookies_4x5Label_FRONT_Matte_LG640-CMYK_R1.pdf</pre>
      </section>
      <section style={{ marginTop: 16, border: "1px solid #e5e7eb", borderRadius: 12, padding: 16, background: "white" }}>
        <h2>Recommended folders</h2>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <tbody>
            {[
              ["Print ready intake", "\\\\SynologyNAS\\GSOP\\GSOP\\Prints For Today"],
              ["Needs review", "\\\\SynologyNAS\\GSOP\\GSOP\\print-intake\\needs-review"],
              ["Renamed archive", "\\\\SynologyNAS\\GSOP\\GSOP\\print-intake\\renamed"],
              ["Sent to RIP archive", "\\\\SynologyNAS\\GSOP\\GSOP\\print-intake\\sent-to-rip"],
              ["VersaWorks CMYK hot folder", "\\\\SynologyNAS\\GSOP\\GSOP\\rip-hotfolders\\versaworks\\LG640-CMYK"],
              ["VersaWorks white/gloss hot folders", "\\\\SynologyNAS\\GSOP\\GSOP\\rip-hotfolders\\versaworks\\LG640-CMYK-WHITE / LG640-CMYK-GLOSS / LG640-CMYK-WHITE-GLOSS"],
              ["RasterLink hot folder", "\\\\SynologyNAS\\GSOP\\GSOP\\rip-hotfolders\\rasterlink\\MIMAKI-CMYK"],
              ["RIP log uploads", "\\\\SynologyNAS\\GSOP\\GSOP\\rip-logs\\versaworks\\incoming and rasterlink\\incoming"],
            ].map(([label, path]) => <tr key={label} style={{ borderTop: "1px solid #e5e7eb" }}><td style={{ padding: 10, fontWeight: 700 }}>{label}</td><td><code>{path}</code></td></tr>)}
          </tbody>
        </table>
      </section>
      <section style={{ marginTop: 16, border: "1px solid #fcd34d", background: "#fffbeb", borderRadius: 12, padding: 16 }}>
        <b>Local watcher token</b>
        <p>Paste this token into the PowerShell watcher config so it can upload RIP logs to the ERP endpoint.</p>
        <pre style={{ background: "white", padding: 12, borderRadius: 8, overflowX: "auto" }}>{setting.uploadToken}</pre>
      </section>
    </main>
  );
}
