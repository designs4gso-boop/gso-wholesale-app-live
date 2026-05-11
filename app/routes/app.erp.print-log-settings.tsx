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
import { randomBytes } from "crypto";
import { Form, useActionData, useLoaderData, useNavigation, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

function makeToken() {
  return `gso_plog_${randomBytes(24).toString("hex")}`;
}

async function ensureSetting(shop: string) {
  const existing = await db.printLogAutoImportSetting.findUnique({ where: { shop } });
  if (existing) return existing;

  return db.printLogAutoImportSetting.create({
    data: {
      shop,
      enabled: true,
      uploadToken: makeToken(),
      incomingFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\print-logs\\incoming",
      versaworksFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\print-logs\\incoming\\versaworks",
      rasterlinkFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\print-logs\\incoming\\rasterlink",
      processedFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\print-logs\\processed",
      errorFolder: "\\\\SynologyNAS\\GSOP\\GSOP\\print-logs\\errors",
      expectedTicketPattern: "GSO-{date}-{jobNumber}-{sku}-{qty}",
      notes: "Auto-import endpoint created by GSO ERP setup.",
    },
  });
}

function getBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const setting = await ensureSetting(shop);
  const baseUrl = getBaseUrl(request);

  const [recentImports, unmatchedCount, matchedCount] = await Promise.all([
    db.printLogImport.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    db.printLogEntry.count({ where: { shop, productionJobId: null } }),
    db.printLogEntry.count({ where: { shop, productionJobId: { not: null } } }),
  ]);

  return Response.json({
    setting,
    baseUrl,
    uploadEndpoint: `${baseUrl}/api/print-logs/upload`,
    recentImports,
    unmatchedCount,
    matchedCount,
  });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "save") {
    const enabled = String(formData.get("enabled") || "") === "on";
    await db.printLogAutoImportSetting.upsert({
      where: { shop },
      update: {
        enabled,
        incomingFolder: String(formData.get("incomingFolder") || "") || null,
        versaworksFolder: String(formData.get("versaworksFolder") || "") || null,
        rasterlinkFolder: String(formData.get("rasterlinkFolder") || "") || null,
        processedFolder: String(formData.get("processedFolder") || "") || null,
        errorFolder: String(formData.get("errorFolder") || "") || null,
        expectedTicketPattern: String(formData.get("expectedTicketPattern") || "GSO-{date}-{jobNumber}-{sku}-{qty}"),
        notes: String(formData.get("notes") || "") || null,
      },
      create: {
        shop,
        enabled,
        uploadToken: makeToken(),
        incomingFolder: String(formData.get("incomingFolder") || "") || null,
        versaworksFolder: String(formData.get("versaworksFolder") || "") || null,
        rasterlinkFolder: String(formData.get("rasterlinkFolder") || "") || null,
        processedFolder: String(formData.get("processedFolder") || "") || null,
        errorFolder: String(formData.get("errorFolder") || "") || null,
        expectedTicketPattern: String(formData.get("expectedTicketPattern") || "GSO-{date}-{jobNumber}-{sku}-{qty}"),
        notes: String(formData.get("notes") || "") || null,
      },
    });
    return Response.json({ ok: true, message: "Print log auto-import settings saved." });
  }

  if (intent === "rotateToken") {
    await db.printLogAutoImportSetting.upsert({
      where: { shop },
      update: { uploadToken: makeToken() },
      create: { shop, enabled: true, uploadToken: makeToken() },
    });
    return Response.json({ ok: true, message: "Upload token rotated. Update the local watcher script with the new token." });
  }

  return Response.json({ ok: false, message: "Unknown settings action." }, { status: 400 });
}

export default function PrintLogSettingsPage() {
  const data = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const busy = navigation.state !== "idle";
  const setting = data.setting;

  const powershellExample = `$Endpoint = "${data.uploadEndpoint}"
$Token = "${setting.uploadToken}"
$IncomingFolder = "${setting.incomingFolder || "\\\\SynologyNAS\\GSOP\\GSOP\\print-logs\\incoming"}"
$ProcessedFolder = "${setting.processedFolder || "\\\\SynologyNAS\\GSOP\\GSOP\\print-logs\\processed"}"
$ErrorFolder = "${setting.errorFolder || "\\\\SynologyNAS\\GSOP\\GSOP\\print-logs\\errors"}"

New-Item -ItemType Directory -Force -Path $IncomingFolder, $ProcessedFolder, $ErrorFolder | Out-Null

Get-ChildItem -Path $IncomingFolder -File -Include *.csv,*.txt,*.xml -Recurse | ForEach-Object {
  try {
    $rawText = Get-Content $_.FullName -Raw
    $body = @{
      token = $Token
      source = if ($_.FullName -match "raster") { "rasterlink" } else { "versaworks" }
      fileName = $_.Name
      rawText = $rawText
      notes = "Auto import from $env:COMPUTERNAME"
    }
    Invoke-RestMethod -Uri $Endpoint -Method Post -Body ($body | ConvertTo-Json -Depth 4) -ContentType "application/json"
    Move-Item $_.FullName (Join-Path $ProcessedFolder $_.Name) -Force
  } catch {
    Move-Item $_.FullName (Join-Path $ErrorFolder $_.Name) -Force
  }
}`;

  return (
    <Page
      title="Print Log Auto Import Settings"
      subtitle="Configure the secure endpoint and local watch-folder details for automatic VersaWorks/RasterLink log imports."
      backAction={{ content: "Print Logs", onAction: () => navigate("/app/erp/print-logs") }}
      primaryAction={{ content: "Open Print Logs", onAction: () => navigate("/app/erp/print-logs") }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Auto-import endpoint</Text>
                  <Text as="p" tone="subdued">The local watcher sends exported CSV/XML/TXT logs here. The ERP matches rows by GSO job ticket.</Text>
                </BlockStack>
                {setting.enabled ? <Badge tone="success">Enabled</Badge> : <Badge tone="critical">Disabled</Badge>}
              </InlineStack>

              {actionData?.message ? <Text as="p" tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Text> : null}

              <BlockStack gap="200">
                <Text as="p"><strong>Upload endpoint:</strong></Text>
                <div style={{ padding: 10, border: "1px solid #ccc", borderRadius: 8, wordBreak: "break-all", background: "#f7f7f7" }}>{data.uploadEndpoint}</div>
                <Text as="p"><strong>Upload token:</strong></Text>
                <div style={{ padding: 10, border: "1px solid #ccc", borderRadius: 8, wordBreak: "break-all", background: "#f7f7f7" }}>{setting.uploadToken}</div>
                <Form method="post">
                  <input type="hidden" name="intent" value="rotateToken" />
                  <Button submit tone="critical" loading={busy}>Rotate token</Button>
                </Form>
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Form method="post">
              <input type="hidden" name="intent" value="save" />
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Watch-folder settings</Text>
                <Checkbox label="Enable automatic print log uploads" name="enabled" defaultChecked={setting.enabled} />
                <TextField label="Incoming folder" name="incomingFolder" defaultValue={setting.incomingFolder || ""} autoComplete="off" />
                <TextField label="VersaWorks folder" name="versaworksFolder" defaultValue={setting.versaworksFolder || ""} autoComplete="off" />
                <TextField label="RasterLink folder" name="rasterlinkFolder" defaultValue={setting.rasterlinkFolder || ""} autoComplete="off" />
                <TextField label="Processed folder" name="processedFolder" defaultValue={setting.processedFolder || ""} autoComplete="off" />
                <TextField label="Error folder" name="errorFolder" defaultValue={setting.errorFolder || ""} autoComplete="off" />
                <TextField label="Expected job ticket pattern" name="expectedTicketPattern" defaultValue={setting.expectedTicketPattern || "GSO-{date}-{jobNumber}-{sku}-{qty}"} autoComplete="off" />
                <TextField label="Notes" name="notes" defaultValue={setting.notes || ""} multiline={3} autoComplete="off" />
                <Button submit variant="primary" loading={busy}>Save settings</Button>
              </BlockStack>
            </Form>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Import stats</Text>
              <InlineStack gap="300">
                <Badge tone="success">Matched rows: {data.matchedCount}</Badge>
                <Badge tone={data.unmatchedCount ? "warning" : "success"}>Unmatched rows: {data.unmatchedCount}</Badge>
              </InlineStack>
              <Divider />
              {data.recentImports.length ? data.recentImports.map((item: any) => (
                <Card key={item.id}>
                  <BlockStack gap="100">
                    <Text as="p" fontWeight="bold">{item.source} | {item.fileName || "No file name"}</Text>
                    <Text as="p" tone="subdued">{new Date(item.createdAt).toLocaleString()} | {item.matchedCount}/{item.rowCount} matched</Text>
                  </BlockStack>
                </Card>
              )) : <Text as="p" tone="subdued">No imports yet.</Text>}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Local PowerShell watcher starter</Text>
              <Text as="p" tone="subdued">Save this as a local script on the print computer. Later we can turn it into a scheduled task or small desktop helper.</Text>
              <textarea readOnly value={powershellExample} style={{ width: "100%", minHeight: 420, fontFamily: "Consolas, monospace", fontSize: 12, padding: 12 }} />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
