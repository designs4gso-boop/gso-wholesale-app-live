import { data, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { Page, Card, BlockStack, Text, Button } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const registrations = await db.wholesaleApplication.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });
  return data({ registrations });
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const id = Number(form.get("id"));
  const status = String(form.get("status") || "pending");
  if (!["approved", "rejected", "pending"].includes(status)) return redirect("/app/wholesale/customers");

  // shop-scoped: an id from another shop can never be updated here
  await db.wholesaleApplication.updateMany({
    where: { id, shop: session.shop },
    data: { status },
  });

  return redirect("/app/wholesale/customers");
}

const STATUS_LABEL: Record<string, string> = { pending: "Pending review", approved: "Approved", rejected: "Rejected" };

export default function WholesaleCustomersPage() {
  const { registrations } = useLoaderData<typeof loader>();

  return (
    <Page title="Wholesale applications" subtitle="Storefront wholesale sign-ups. Approve or reject here, then start the customer's first quote in Quotes / CRM." backAction={{ content: "Dashboard", url: "/app" }} primaryAction={{ content: "Open Quotes / CRM", url: "/app/quotes" }}>
      <Card>
        <BlockStack gap="300">
          <Text as="p" variant="bodySm" tone="subdued">Approving records the decision on this list only — it does not change the customer's Shopify tags or pricing. Create the quote in Quotes / CRM with the details below.</Text>
          {registrations.length === 0 ? <Text as="p" variant="bodyMd">No applications yet.</Text> : null}
          {registrations.map((row: any) => (
            <Card key={row.id}>
              <BlockStack gap="150">
                <Text as="p" variant="bodyMd"><strong>{row.companyName || row.email}</strong></Text>
                <Text as="p" variant="bodySm">{row.email}</Text>
                <Text as="p" variant="bodySm">Phone: {row.phone || "—"}</Text>
                <Text as="p" variant="bodySm">Resale number: {row.resaleNumber || "—"}</Text>
                <Text as="p" variant="bodySm">Status: {STATUS_LABEL[String(row.status)] || String(row.status || "pending").replaceAll("_", " ")}</Text>
                <Form method="post">
                  <input type="hidden" name="id" value={row.id} />
                  <Button submit name="status" value="approved" variant="primary">Approve</Button>{" "}
                  <Button submit name="status" value="rejected" tone="critical">Reject</Button>
                </Form>
              </BlockStack>
            </Card>
          ))}
        </BlockStack>
      </Card>
    </Page>
  );
}