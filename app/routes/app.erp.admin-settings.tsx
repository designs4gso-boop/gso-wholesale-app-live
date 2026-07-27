import { Page, Layout, Card, Text, Button, Badge, BlockStack, InlineStack } from "@shopify/polaris";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type SettingDefinition = {
  category: string;
  key: string;
  label: string;
  defaultValue: string;
  valueType?: string;
  unit?: string;
  description?: string;
  options?: { label: string; value: string }[];
};

const settingDefinitions: SettingDefinition[] = [
  { category: "Shop", key: "jobTicketPrefix", label: "Job ticket prefix", defaultValue: "GSO", valueType: "text", description: "Prefix used for production job tickets, RIP names, and file names." },
  { category: "Shop", key: "defaultTimezone", label: "Shop timezone", defaultValue: "America/Los_Angeles", valueType: "text", description: "Used for date grouping, due dates, and reports." },
  { category: "Shop", key: "publicAppBaseUrl", label: "Public app base URL", defaultValue: "https://gso-wholesale-app-live.onrender.com", valueType: "text", description: "Used for proof approval links and customer-facing URLs." },

  { category: "Pricing", key: "defaultWholesaleMarginPct", label: "Default wholesale margin", defaultValue: "40", valueType: "number", unit: "%", description: "Default target margin when generating wholesale pricing." },
  { category: "Pricing", key: "defaultRetailMarginPct", label: "Default retail margin", defaultValue: "55", valueType: "number", unit: "%", description: "Default margin for retail reference pricing." },
  { category: "Pricing", key: "quoteExpirationDays", label: "Quote expiration days", defaultValue: "14", valueType: "number", unit: "days", description: "Default valid-through window for quotes." },
  { category: "Pricing", key: "roundPricesTo", label: "Round prices to", defaultValue: "0.01", valueType: "number", unit: "$", description: "Smallest price rounding increment." },

  { category: "Production Cost", key: "defaultLaborRateHr", label: "Default labor rate", defaultValue: "25", valueType: "number", unit: "$/hr", description: "Used in actual cost finalization when no custom labor rate is entered." },
  { category: "Production Cost", key: "defaultMachineRecoveryHr", label: "Machine recovery", defaultValue: "5", valueType: "number", unit: "$/hr", description: "Default depreciation/recovery rate used for print cost estimates." },
  { category: "Production Cost", key: "defaultMaintenanceCostSqft", label: "Maintenance allowance", defaultValue: "0.08", valueType: "number", unit: "$/sqft", description: "General maintenance/purge allowance for print jobs." },
  { category: "Production Cost", key: "defaultPowerRateKwh", label: "Power rate", defaultValue: "0.15", valueType: "number", unit: "$/kWh", description: "Electricity rate used for machine cost estimates." },
  { category: "Production Cost", key: "defaultOverheadPct", label: "Overhead allowance", defaultValue: "10", valueType: "number", unit: "%", description: "Default overhead buffer on production costs." },

  { category: "Ink + Print Defaults", key: "rolandInkCostMl", label: "Roland ink cost", defaultValue: "0.209", valueType: "number", unit: "$/ml", description: "Roland LG-640 EUV5P ink pouch cost per ml." },
  { category: "Ink + Print Defaults", key: "mimakiInkCostMl", label: "Mimaki ink cost", defaultValue: "0.209", valueType: "number", unit: "$/ml", description: "Default Mimaki ink cost per ml. Update during backend setup." },
  { category: "Ink + Print Defaults", key: "cmykInkMlSqft", label: "CMYK ink usage", defaultValue: "1.2", valueType: "number", unit: "ml/sqft", description: "Default CMYK ink estimate for normal full-color jobs." },
  { category: "Ink + Print Defaults", key: "inkAllowancePct", label: "Ink allowance", defaultValue: "15", valueType: "number", unit: "%", description: "Maintenance/purge allowance added to ink estimates." },
  { category: "Ink + Print Defaults", key: "whiteInkMlSqft", label: "White ink per layer", defaultValue: "1.5", valueType: "number", unit: "ml/sqft", description: "Default white ink coverage estimate per layer." },
  { category: "Ink + Print Defaults", key: "glossInkMlSqft", label: "Gloss ink per layer", defaultValue: "1", valueType: "number", unit: "ml/sqft", description: "Default gloss/emboss ink estimate per layer." },

  { category: "Waste Defaults", key: "mediaWastePct", label: "Media waste", defaultValue: "10", valueType: "number", unit: "%", description: "Default media waste for normal roll production." },
  { category: "Waste Defaults", key: "smallDecalWastePct", label: "Small decal waste", defaultValue: "18", valueType: "number", unit: "%", description: "Default waste for small decals / contour-cut jobs." },
  { category: "Waste Defaults", key: "whiteGlossWastePct", label: "White/gloss waste", defaultValue: "22", valueType: "number", unit: "%", description: "Default waste buffer for white/gloss/texture jobs." },
  { category: "Waste Defaults", key: "newMaterialWastePct", label: "New material/testing waste", defaultValue: "20", valueType: "number", unit: "%", description: "Default waste when testing or dialing in a new material." },

  { category: "Proof Defaults", key: "autoCreateProof", label: "Auto-create proof", defaultValue: "yes", valueType: "select", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], description: "Create a standard proof sheet when a production job is created." },
  { category: "Proof Defaults", key: "proofRevisionPrefix", label: "Proof revision prefix", defaultValue: "REV", valueType: "text", description: "Default proof revision label." },
  { category: "Proof Defaults", key: "proofApprovalText", label: "Proof approval text", defaultValue: "Customer is responsible for verifying spelling, layout, color expectation, size, strain/product details, barcode/QR, compliance text, and final artwork before production.", valueType: "textarea", description: "Default language shown on proof sheets and customer proof portal." },

  { category: "Purchasing", key: "defaultPoFollowUpDays", label: "PO follow-up days", defaultValue: "3", valueType: "number", unit: "days", description: "Default follow-up reminder after a PO is sent." },
  { category: "Purchasing", key: "defaultReorderBufferDays", label: "Reorder buffer", defaultValue: "7", valueType: "number", unit: "days", description: "Extra days of stock coverage when suggesting reorder quantities." },
  { category: "Purchasing", key: "defaultPoTerms", label: "Default PO terms", defaultValue: "Net 30", valueType: "text", description: "Fallback payment terms for purchase orders." },

  { category: "Notifications", key: "productionAlertsEnabled", label: "Production alerts", defaultValue: "yes", valueType: "select", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], description: "Send alerts when production jobs are created if webhook is configured." },
  { category: "Notifications", key: "poFollowUpAlertsEnabled", label: "PO follow-up alerts", defaultValue: "yes", valueType: "select", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], description: "Enable follow-up warnings for sent purchase orders." },
  { category: "Notifications", key: "lowStockAlertsEnabled", label: "Low stock alerts", defaultValue: "yes", valueType: "select", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], description: "Enable low-stock warnings and reorder prompts." },
];

function byCategory(settings: any[]) {
  return settings.reduce((groups: Record<string, any[]>, setting: any) => {
    groups[setting.category] = groups[setting.category] || [];
    groups[setting.category].push(setting);
    return groups;
  }, {});
}

function nativeInput(setting: any) {
  const inputName = `setting:${setting.key}`;
  const commonStyle = { width: "100%", padding: 8, borderRadius: 8, border: "1px solid #bbb" };

  if (setting.valueType === "textarea") {
    return <textarea name={inputName} defaultValue={setting.value} rows={4} style={commonStyle} />;
  }

  if (setting.valueType === "select") {
    return (
      <select name={inputName} defaultValue={setting.value} style={commonStyle}>
        {(setting.options || []).map((option: any) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    );
  }

  return <input name={inputName} defaultValue={setting.value} type={setting.valueType === "number" ? "number" : "text"} step="any" style={commonStyle} />;
}

function getMergedSettings(saved: any[]) {
  const savedByKey = new Map(saved.map((setting) => [setting.key, setting]));
  return settingDefinitions.map((definition) => {
    const savedSetting = savedByKey.get(definition.key) as any;
    return {
      ...definition,
      value: savedSetting?.value ?? definition.defaultValue,
      saved: Boolean(savedSetting),
      updatedAt: savedSetting?.updatedAt || null,
    };
  });
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const savedSettings = await db.erpAdminSetting.findMany({ where: { shop }, orderBy: [{ category: "asc" }, { key: "asc" }] });
  const settings = getMergedSettings(savedSettings);
  return Response.json({ settings });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "saveSettings");

  if (intent === "resetDefaults") {
    await db.erpAdminSetting.deleteMany({ where: { shop } });
    return Response.json({ ok: true, message: "Defaults reset. The app is showing built-in defaults again." });
  }

  let savedCount = 0;
  for (const definition of settingDefinitions) {
    const value = String(formData.get(`setting:${definition.key}`) ?? definition.defaultValue);
    await db.erpAdminSetting.upsert({
      where: { shop_key: { shop, key: definition.key } },
      update: {
        category: definition.category,
        label: definition.label,
        value,
        valueType: definition.valueType || "text",
        unit: definition.unit || null,
        description: definition.description || null,
      },
      create: {
        shop,
        category: definition.category,
        key: definition.key,
        label: definition.label,
        value,
        valueType: definition.valueType || "text",
        unit: definition.unit || null,
        description: definition.description || null,
      },
    });
    savedCount += 1;
  }

  return Response.json({ ok: true, message: `Saved ${savedCount} admin default setting(s).` });
}

export default function AdminSettingsPage() {
  const { settings } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const groups = byCategory(settings);

  return (
    <Page title="Admin Settings / Defaults" subtitle="Centralize GSO ERP defaults before backend setup and employee training.">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">ERP default control center</Text>
                  <Text as="p" tone="subdued">These values are the shop defaults. During backend setup we will dial them in with your real GSO numbers.</Text>
                </BlockStack>
                <Badge tone="success">{settings.length} defaults</Badge>
              </InlineStack>
              {actionData?.message ? <Text as="p" tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Text> : null}
              <InlineStack gap="200">
                <Button url="/app/erp/reports-dashboard">Reports Dashboard</Button>
                <Button url="/app/erp/production">Production Board</Button>
                <Button url="/app/erp/materials">Materials</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Form method="post">
            <input type="hidden" name="intent" value="saveSettings" />
            <BlockStack gap="400">
              {Object.entries(groups).map(([category, groupSettings]: any) => (
                <Card key={category}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingMd">{category}</Text>
                      <Badge>{groupSettings.length}</Badge>
                    </InlineStack>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
                      {groupSettings.map((setting: any) => (
                        <div key={setting.key} style={{ border: "1px solid #e2e2e2", borderRadius: 12, padding: 12 }}>
                          <label style={{ display: "block", fontWeight: 700, marginBottom: 6 }}>{setting.label}</label>
                          {nativeInput(setting)}
                          <div style={{ fontSize: 12, color: "#666", marginTop: 6 }}>
                            <div>{setting.description}</div>
                            <div>Key: {setting.key}{setting.unit ? ` | Unit: ${setting.unit}` : ""}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </BlockStack>
                </Card>
              ))}
              <InlineStack gap="300">
                <Button submit variant="primary" loading={busy}>Save admin defaults</Button>
              </InlineStack>
            </BlockStack>
          </Form>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Reset built-in defaults</Text>
              <Text as="p" tone="subdued">This deletes saved overrides and shows the built-in defaults again. It does not delete jobs, materials, quotes, vendors, or reports.</Text>
              <Form method="post">
                <input type="hidden" name="intent" value="resetDefaults" />
                <Button submit tone="critical">Reset saved defaults</Button>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
