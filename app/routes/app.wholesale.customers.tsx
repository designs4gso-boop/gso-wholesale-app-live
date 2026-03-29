import { json, redirect } from "react-router";
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
  return json({ registrations });
}

export async function action({ request }: ActionFunctionArgs) {
  const form = await request.formData();
  const id = Number(form.get("id"));
  const status = String(form.get("status") || "pending");

  await db.wholesaleApplication.update({
    where: { id },
    data: { status },
  });

  return redirect("/app/wholesale/customers");
}

export default function WholesaleCustomersPage() {
  const { registrations } = useLoaderData<typeof loader>();

  return (
    <Page title="Wholesale applications" backAction={{ content: "Dashboard", url: "/app" }}>
      <Card>
        <BlockStack gap="300">
          {registrations.length === 0 ? <Text as="p" variant="bodyMd">No applications yet.</Text> : null}
          {registrations.map((row: any) => (
            <Card key={row.id}>
              <BlockStack gap="150">
                <Text as="p" variant="bodyMd"><strong>{row.companyName || row.email}</strong></Text>
                <Text as="p" variant="bodySm">{row.email}</Text>
                <Text as="p" variant="bodySm">Phone: {row.phone || "—"}</Text>
                <Text as="p" variant="bodySm">Resale number: {row.resaleNumber || "—"}</Text>
                <Text as="p" variant="bodySm">Status: {row.status}</Text>
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
