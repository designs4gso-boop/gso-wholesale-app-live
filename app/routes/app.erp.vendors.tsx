import {
  Page,
  Layout,
  Card,
  Text,
  Button,
  Badge,
  BlockStack,
  InlineStack,
  Divider,
} from "@shopify/polaris";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const vendorTypeOptions = [
  ["supplier", "Supplier"],
  ["print_vendor", "Print Vendor"],
  ["packaging_vendor", "Packaging Vendor"],
  ["service", "Service"],
  ["other", "Other"],
];

const statusOptions = [
  ["active", "Active"],
  ["preferred", "Preferred"],
  ["backup", "Backup"],
  ["inactive", "Inactive"],
];

function clean(value: FormDataEntryValue | null) {
  return String(value || "").trim();
}

function numberOrNull(value: FormDataEntryValue | null) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function money(value: any) {
  return (Number(value) || 0).toFixed(2);
}

function normalizeName(name: string) {
  return name.trim().replace(/\s+/g, " ");
}

async function vendorUsageSummary(shop: string) {
  const [materials, vendorProducts, purchaseRequests] = await Promise.all([
    db.material.findMany({
      where: { shop, active: true, vendor: { not: null } },
      select: { id: true, vendor: true, name: true, sku: true, costPerUnit: true, stockOnHand: true, reorderPoint: true },
    }),
    db.vendorProduct.findMany({
      where: { shop, active: true, vendor: { not: null } },
      select: { id: true, vendor: true, name: true, vendorSku: true, defaultUnitCost: true, moq: true, leadTimeDays: true },
    }),
    db.purchaseRequest.findMany({
      where: { shop, vendor: { not: null } },
      select: { id: true, vendor: true, status: true, materialName: true, requestedQty: true, estimatedCost: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const summary = new Map<string, any>();

  function ensure(vendor: string) {
    const key = normalizeName(vendor);
    if (!key) return null;
    if (!summary.has(key)) {
      summary.set(key, {
        name: key,
        materialCount: 0,
        vendorProductCount: 0,
        purchaseRequestCount: 0,
        openPurchaseRequestCount: 0,
        estimatedSpend: 0,
        materialExamples: [] as any[],
        vendorProductExamples: [] as any[],
        purchaseExamples: [] as any[],
      });
    }
    return summary.get(key);
  }

  for (const material of materials) {
    const row = ensure(material.vendor || "");
    if (!row) continue;
    row.materialCount += 1;
    if (row.materialExamples.length < 4) row.materialExamples.push(material);
  }

  for (const vendorProduct of vendorProducts) {
    const row = ensure(vendorProduct.vendor || "");
    if (!row) continue;
    row.vendorProductCount += 1;
    if (row.vendorProductExamples.length < 4) row.vendorProductExamples.push(vendorProduct);
  }

  for (const request of purchaseRequests) {
    const row = ensure(request.vendor || "");
    if (!row) continue;
    row.purchaseRequestCount += 1;
    if (!["received", "cancelled"].includes(request.status)) row.openPurchaseRequestCount += 1;
    row.estimatedSpend += Number(request.estimatedCost || 0);
    if (row.purchaseExamples.length < 4) row.purchaseExamples.push(request);
  }

  return Array.from(summary.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function createVendorsFromExistingNames(shop: string) {
  const usage = await vendorUsageSummary(shop);
  let created = 0;

  for (const row of usage) {
    const existing = await db.vendor.findUnique({ where: { shop_name: { shop, name: row.name } } });
    if (existing) continue;

    await db.vendor.create({
      data: {
        shop,
        name: row.name,
        vendorType: row.vendorProductCount > 0 ? "packaging_vendor" : "supplier",
        status: row.openPurchaseRequestCount > 0 ? "active" : "backup",
        leadTimeDays: row.vendorProductExamples[0]?.leadTimeDays || null,
        notes: `Created from existing material/vendor product/purchase request vendor text. Review contact info, terms, MOQ, and lead time.`,
      },
    });
    created += 1;
  }

  return created;
}

export async function loader({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [vendors, usage, openPurchaseRequests, lowStockMaterials] = await Promise.all([
    db.vendor.findMany({
      where: { shop },
      orderBy: [{ active: "desc" }, { status: "asc" }, { name: "asc" }],
      include: { contacts: { where: { active: true }, orderBy: [{ primary: "desc" }, { name: "asc" }] } },
    }),
    vendorUsageSummary(shop),
    db.purchaseRequest.count({ where: { shop, status: { in: ["draft", "requested", "ordered", "partially_received"] } } }),
    db.material.count({ where: { shop, active: true, stockOnHand: { not: null }, reorderPoint: { not: null } } }),
  ]);

  return Response.json({ vendors, usage, openPurchaseRequests, lowStockMaterials });
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = clean(formData.get("intent"));

  if (intent === "seedFromExisting") {
    const created = await createVendorsFromExistingNames(shop);
    return Response.json({ ok: true, message: `Created ${created} vendor record(s) from existing vendor names.` });
  }

  if (intent === "createVendor") {
    const name = normalizeName(clean(formData.get("name")));
    if (!name) return Response.json({ ok: false, message: "Vendor name is required." }, { status: 400 });

    await db.vendor.upsert({
      where: { shop_name: { shop, name } },
      update: {
        vendorType: clean(formData.get("vendorType")) || "supplier",
        status: clean(formData.get("status")) || "active",
        contactName: clean(formData.get("contactName")) || null,
        email: clean(formData.get("email")) || null,
        phone: clean(formData.get("phone")) || null,
        website: clean(formData.get("website")) || null,
        paymentTerms: clean(formData.get("paymentTerms")) || null,
        leadTimeDays: numberOrNull(formData.get("leadTimeDays")),
        notes: clean(formData.get("notes")) || null,
        active: true,
      },
      create: {
        shop,
        name,
        vendorType: clean(formData.get("vendorType")) || "supplier",
        status: clean(formData.get("status")) || "active",
        contactName: clean(formData.get("contactName")) || null,
        email: clean(formData.get("email")) || null,
        phone: clean(formData.get("phone")) || null,
        website: clean(formData.get("website")) || null,
        paymentTerms: clean(formData.get("paymentTerms")) || null,
        leadTimeDays: numberOrNull(formData.get("leadTimeDays")),
        notes: clean(formData.get("notes")) || null,
        active: true,
      },
    });

    return Response.json({ ok: true, message: `${name} saved.` });
  }

  if (intent === "updateVendor") {
    const id = clean(formData.get("id"));
    await db.vendor.updateMany({
      where: { shop, id },
      data: {
        vendorType: clean(formData.get("vendorType")) || "supplier",
        status: clean(formData.get("status")) || "active",
        contactName: clean(formData.get("contactName")) || null,
        email: clean(formData.get("email")) || null,
        phone: clean(formData.get("phone")) || null,
        website: clean(formData.get("website")) || null,
        address1: clean(formData.get("address1")) || null,
        city: clean(formData.get("city")) || null,
        state: clean(formData.get("state")) || null,
        zip: clean(formData.get("zip")) || null,
        paymentTerms: clean(formData.get("paymentTerms")) || null,
        leadTimeDays: numberOrNull(formData.get("leadTimeDays")),
        moqNotes: clean(formData.get("moqNotes")) || null,
        shippingNotes: clean(formData.get("shippingNotes")) || null,
        qualityNotes: clean(formData.get("qualityNotes")) || null,
        notes: clean(formData.get("notes")) || null,
      },
    });
    return Response.json({ ok: true, message: "Vendor updated." });
  }

  if (intent === "toggleVendorActive") {
    const id = clean(formData.get("id"));
    const active = clean(formData.get("active")) === "true";
    await db.vendor.updateMany({ where: { shop, id }, data: { active, status: active ? "active" : "inactive" } });
    return Response.json({ ok: true, message: active ? "Vendor restored." : "Vendor archived." });
  }

  if (intent === "addContact") {
    const vendorId = clean(formData.get("vendorId"));
    const name = clean(formData.get("contactName"));
    if (!name) return Response.json({ ok: false, message: "Contact name is required." }, { status: 400 });

    await db.vendorContact.create({
      data: {
        shop,
        vendorId,
        name,
        role: clean(formData.get("role")) || null,
        email: clean(formData.get("contactEmail")) || null,
        phone: clean(formData.get("contactPhone")) || null,
        notes: clean(formData.get("contactNotes")) || null,
        primary: clean(formData.get("primary")) === "on",
      },
    });
    return Response.json({ ok: true, message: "Vendor contact added." });
  }

  return Response.json({ ok: false, message: "Unknown vendor action." }, { status: 400 });
}

function Field({ label, name, defaultValue, type = "text", placeholder = "" }: { label: string; name: string; defaultValue?: any; type?: string; placeholder?: string }) {
  return (
    <label style={{ display: "block", fontSize: 12, fontWeight: 600 }}>
      {label}
      <input
        name={name}
        type={type}
        defaultValue={defaultValue || ""}
        placeholder={placeholder}
        style={{ width: "100%", padding: 8, border: "1px solid #bbb", borderRadius: 8, marginTop: 4 }}
      />
    </label>
  );
}

function SelectField({ label, name, defaultValue, options }: { label: string; name: string; defaultValue?: string; options: string[][] }) {
  return (
    <label style={{ display: "block", fontSize: 12, fontWeight: 600 }}>
      {label}
      <select name={name} defaultValue={defaultValue || options[0][0]} style={{ width: "100%", padding: 8, border: "1px solid #bbb", borderRadius: 8, marginTop: 4 }}>
        {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
  );
}

function TextArea({ label, name, defaultValue, placeholder = "" }: { label: string; name: string; defaultValue?: any; placeholder?: string }) {
  return (
    <label style={{ display: "block", fontSize: 12, fontWeight: 600 }}>
      {label}
      <textarea
        name={name}
        defaultValue={defaultValue || ""}
        placeholder={placeholder}
        rows={3}
        style={{ width: "100%", padding: 8, border: "1px solid #bbb", borderRadius: 8, marginTop: 4 }}
      />
    </label>
  );
}

function usageForVendor(usage: any[], name: string) {
  return usage.find((row) => row.name.toLowerCase() === String(name || "").toLowerCase());
}

export default function VendorCenter() {
  const { vendors, usage, openPurchaseRequests } = useLoaderData<any>();
  const actionData = useActionData<any>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const vendorsByName = new Set(vendors.map((vendor: any) => String(vendor.name).toLowerCase()));
  const uncreatedUsage = usage.filter((row: any) => !vendorsByName.has(String(row.name).toLowerCase()));

  return (
    <Page
      title="Vendor Center"
      subtitle="Centralize supplier contacts, terms, lead times, vendor SKUs, notes, and purchase activity."
      secondaryActions={[
        { content: "PO Requests", url: "/app/erp/purchase-requests" },
        { content: "Reorder Report", url: "/app/erp/reorder-report" },
      ]}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">Vendor command center</Text>
                  <Text as="p" tone="subdued">Create clean vendor records and seed them from existing material, vendor product, and PO request vendor names.</Text>
                </BlockStack>
                <InlineStack gap="200">
                  <Badge tone="success">{vendors.filter((vendor: any) => vendor.active).length} active</Badge>
                  <Badge>{openPurchaseRequests} open PO(s)</Badge>
                  {uncreatedUsage.length ? <Badge tone="warning">{uncreatedUsage.length} vendor name(s) need records</Badge> : null}
                </InlineStack>
              </InlineStack>

              {actionData?.message ? <Text as="p" tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Text> : null}

              <InlineStack gap="200">
                <Form method="post">
                  <input type="hidden" name="intent" value="seedFromExisting" />
                  <Button submit loading={busy}>Create vendors from existing names</Button>
                </Form>
                <Button url="/app/erp/purchase-requests">Open PO Requests</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Add vendor</Text>
              <Form method="post">
                <input type="hidden" name="intent" value="createVendor" />
                <BlockStack gap="250">
                  <InlineStack gap="250" wrap>
                    <div style={{ minWidth: 220, flex: 2 }}><Field label="Vendor name" name="name" placeholder="Example: ImageTech, Uline, Pack Vendor" /></div>
                    <div style={{ minWidth: 180, flex: 1 }}><SelectField label="Vendor type" name="vendorType" options={vendorTypeOptions} /></div>
                    <div style={{ minWidth: 180, flex: 1 }}><SelectField label="Status" name="status" options={statusOptions} /></div>
                  </InlineStack>
                  <InlineStack gap="250" wrap>
                    <div style={{ minWidth: 200, flex: 1 }}><Field label="Main contact" name="contactName" /></div>
                    <div style={{ minWidth: 200, flex: 1 }}><Field label="Email" name="email" type="email" /></div>
                    <div style={{ minWidth: 180, flex: 1 }}><Field label="Phone" name="phone" /></div>
                    <div style={{ minWidth: 180, flex: 1 }}><Field label="Lead time days" name="leadTimeDays" type="number" /></div>
                  </InlineStack>
                  <InlineStack gap="250" wrap>
                    <div style={{ minWidth: 240, flex: 1 }}><Field label="Website" name="website" /></div>
                    <div style={{ minWidth: 240, flex: 1 }}><Field label="Payment terms" name="paymentTerms" placeholder="Net 30, due on receipt, COD" /></div>
                  </InlineStack>
                  <TextArea label="Notes" name="notes" placeholder="What does this vendor supply? Terms, quality notes, ordering process." />
                  <Button submit variant="primary" loading={busy}>Save vendor</Button>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>

        {uncreatedUsage.length ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Vendor names found but not created yet</Text>
                {uncreatedUsage.map((row: any) => (
                  <InlineStack key={row.name} align="space-between" blockAlign="center">
                    <Text as="p"><strong>{row.name}</strong> | Materials: {row.materialCount} | Vendor products: {row.vendorProductCount} | PO requests: {row.purchaseRequestCount}</Text>
                    <Badge tone="warning">Needs vendor record</Badge>
                  </InlineStack>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}

        <Layout.Section>
          <BlockStack gap="400">
            {vendors.length ? vendors.map((vendor: any) => {
              const vendorUsage = usageForVendor(usage, vendor.name) || {
                materialCount: 0,
                vendorProductCount: 0,
                purchaseRequestCount: 0,
                openPurchaseRequestCount: 0,
                estimatedSpend: 0,
                materialExamples: [],
                vendorProductExamples: [],
                purchaseExamples: [],
              };

              return (
                <Card key={vendor.id}>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="start">
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="h2" variant="headingMd">{vendor.name}</Text>
                          <Badge tone={vendor.active ? "success" : "critical"}>{vendor.active ? vendor.status : "inactive"}</Badge>
                          <Badge>{vendor.vendorType}</Badge>
                        </InlineStack>
                        <Text as="p" tone="subdued">{vendor.contactName || "No main contact"} {vendor.email ? `| ${vendor.email}` : ""} {vendor.phone ? `| ${vendor.phone}` : ""}</Text>
                        <Text as="p" tone="subdued">Lead time: {vendor.leadTimeDays || "TBD"} day(s) | Terms: {vendor.paymentTerms || "TBD"}</Text>
                      </BlockStack>
                      <InlineStack gap="200">
                        {vendor.website ? <Button url={vendor.website} target="_blank">Website</Button> : null}
                        <Form method="post">
                          <input type="hidden" name="intent" value="toggleVendorActive" />
                          <input type="hidden" name="id" value={vendor.id} />
                          <input type="hidden" name="active" value={vendor.active ? "false" : "true"} />
                          <Button submit tone={vendor.active ? "critical" : undefined}>{vendor.active ? "Archive" : "Restore"}</Button>
                        </Form>
                      </InlineStack>
                    </InlineStack>

                    <InlineStack gap="250" wrap>
                      <Badge>Materials: {vendorUsage.materialCount}</Badge>
                      <Badge>Vendor products: {vendorUsage.vendorProductCount}</Badge>
                      <Badge>POs: {vendorUsage.purchaseRequestCount}</Badge>
                      <Badge tone={vendorUsage.openPurchaseRequestCount ? "warning" : undefined}>Open POs: {vendorUsage.openPurchaseRequestCount}</Badge>
                      <Badge>Est. PO spend: ${money(vendorUsage.estimatedSpend)}</Badge>
                    </InlineStack>

                    <Divider />

                    <InlineStack align="start" gap="300" wrap>
                      <div style={{ minWidth: 320, flex: 2 }}>
                        <Form method="post">
                          <input type="hidden" name="intent" value="updateVendor" />
                          <input type="hidden" name="id" value={vendor.id} />
                          <BlockStack gap="200">
                            <InlineStack gap="200" wrap>
                              <div style={{ minWidth: 160, flex: 1 }}><SelectField label="Vendor type" name="vendorType" defaultValue={vendor.vendorType} options={vendorTypeOptions} /></div>
                              <div style={{ minWidth: 160, flex: 1 }}><SelectField label="Status" name="status" defaultValue={vendor.status} options={statusOptions} /></div>
                              <div style={{ minWidth: 160, flex: 1 }}><Field label="Lead time days" name="leadTimeDays" type="number" defaultValue={vendor.leadTimeDays} /></div>
                            </InlineStack>
                            <InlineStack gap="200" wrap>
                              <div style={{ minWidth: 180, flex: 1 }}><Field label="Main contact" name="contactName" defaultValue={vendor.contactName} /></div>
                              <div style={{ minWidth: 180, flex: 1 }}><Field label="Email" name="email" defaultValue={vendor.email} /></div>
                              <div style={{ minWidth: 180, flex: 1 }}><Field label="Phone" name="phone" defaultValue={vendor.phone} /></div>
                            </InlineStack>
                            <InlineStack gap="200" wrap>
                              <div style={{ minWidth: 220, flex: 1 }}><Field label="Website" name="website" defaultValue={vendor.website} /></div>
                              <div style={{ minWidth: 220, flex: 1 }}><Field label="Payment terms" name="paymentTerms" defaultValue={vendor.paymentTerms} /></div>
                            </InlineStack>
                            <InlineStack gap="200" wrap>
                              <div style={{ minWidth: 220, flex: 2 }}><Field label="Address" name="address1" defaultValue={vendor.address1} /></div>
                              <div style={{ minWidth: 140, flex: 1 }}><Field label="City" name="city" defaultValue={vendor.city} /></div>
                              <div style={{ minWidth: 90, flex: 1 }}><Field label="State" name="state" defaultValue={vendor.state} /></div>
                              <div style={{ minWidth: 110, flex: 1 }}><Field label="Zip" name="zip" defaultValue={vendor.zip} /></div>
                            </InlineStack>
                            <TextArea label="MOQ notes" name="moqNotes" defaultValue={vendor.moqNotes} />
                            <TextArea label="Shipping notes" name="shippingNotes" defaultValue={vendor.shippingNotes} />
                            <TextArea label="Quality notes" name="qualityNotes" defaultValue={vendor.qualityNotes} />
                            <TextArea label="General notes" name="notes" defaultValue={vendor.notes} />
                            <Button submit loading={busy}>Save vendor details</Button>
                          </BlockStack>
                        </Form>
                      </div>

                      <div style={{ minWidth: 280, flex: 1 }}>
                        <Card>
                          <BlockStack gap="200">
                            <Text as="h3" variant="headingSm">Contacts</Text>
                            {vendor.contacts?.length ? vendor.contacts.map((contact: any) => (
                              <Text as="p" key={contact.id}>
                                <strong>{contact.primary ? "★ " : ""}{contact.name}</strong>{contact.role ? `, ${contact.role}` : ""}<br />
                                {contact.email || "No email"} {contact.phone ? `| ${contact.phone}` : ""}
                              </Text>
                            )) : <Text as="p" tone="subdued">No extra contacts yet.</Text>}

                            <Form method="post">
                              <input type="hidden" name="intent" value="addContact" />
                              <input type="hidden" name="vendorId" value={vendor.id} />
                              <BlockStack gap="150">
                                <Field label="Contact name" name="contactName" />
                                <Field label="Role" name="role" placeholder="Sales rep, accounting, owner" />
                                <Field label="Email" name="contactEmail" />
                                <Field label="Phone" name="contactPhone" />
                                <label style={{ fontSize: 12 }}><input type="checkbox" name="primary" /> Primary contact</label>
                                <Button submit>Add contact</Button>
                              </BlockStack>
                            </Form>
                          </BlockStack>
                        </Card>
                      </div>
                    </InlineStack>

                    <InlineStack gap="300" wrap align="start">
                      <div style={{ minWidth: 260, flex: 1 }}>
                        <Text as="h3" variant="headingSm">Materials using this vendor</Text>
                        {vendorUsage.materialExamples.length ? vendorUsage.materialExamples.map((material: any) => (
                          <Text as="p" key={material.id}>{material.name} | SKU: {material.sku || "none"} | Cost: ${money(material.costPerUnit)} | Stock: {material.stockOnHand ?? "n/a"}</Text>
                        )) : <Text as="p" tone="subdued">No matching materials yet.</Text>}
                      </div>
                      <div style={{ minWidth: 260, flex: 1 }}>
                        <Text as="h3" variant="headingSm">Vendor products</Text>
                        {vendorUsage.vendorProductExamples.length ? vendorUsage.vendorProductExamples.map((product: any) => (
                          <Text as="p" key={product.id}>{product.name} | SKU: {product.vendorSku || "none"} | MOQ: {product.moq || "n/a"} | Cost: ${money(product.defaultUnitCost)}</Text>
                        )) : <Text as="p" tone="subdued">No vendor product templates yet.</Text>}
                      </div>
                      <div style={{ minWidth: 260, flex: 1 }}>
                        <Text as="h3" variant="headingSm">Recent PO requests</Text>
                        {vendorUsage.purchaseExamples.length ? vendorUsage.purchaseExamples.map((po: any) => (
                          <Text as="p" key={po.id}>{po.materialName} | {po.status} | Qty: {po.requestedQty} | Est: ${money(po.estimatedCost)}</Text>
                        )) : <Text as="p" tone="subdued">No PO requests yet.</Text>}
                      </div>
                    </InlineStack>
                  </BlockStack>
                </Card>
              );
            }) : <Card><Text as="p" tone="subdued">No vendor records yet. Create one or seed from existing names.</Text></Card>}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
