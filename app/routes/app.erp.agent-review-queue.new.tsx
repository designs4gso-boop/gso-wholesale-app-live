import {
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Page,
  Text,
} from "@shopify/polaris";
import { Form, redirect, useActionData, useNavigation, useNavigate } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

type FieldValues = Record<string, string>;
type ActionData = {
  ok: false;
  errors: string[];
  values: FieldValues;
};

const FIELD_LIMITS: Record<string, number> = {
  customerName: 120,
  company: 160,
  email: 180,
  phone: 80,
  productFamily: 120,
  productType: 160,
  quantity: 80,
  dimensionsOrSize: 160,
  materialOrSubstrate: 180,
  finish: 160,
  deadline: 120,
  shippingCityState: 160,
  customerSafeSummary: 1200,
  customerSafeDraftReply: 1200,
  internalNotes: 1600,
  recommendedStaffAction: 300,
};

const TEXT_FIELDS = Object.keys(FIELD_LIMITS);

function formText(formData: FormData, key: string) {
  const raw = String(formData.get(key) || "").trim();
  const limit = FIELD_LIMITS[key] || 500;
  return raw.slice(0, limit);
}

function valuesFromForm(formData: FormData) {
  return TEXT_FIELDS.reduce<FieldValues>((values, key) => {
    values[key] = formText(formData, key);
    return values;
  }, {});
}

function actorNameFromSession(session: any) {
  const name = [session?.firstName, session?.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

function Field({
  label,
  name,
  values,
  required = false,
  multiline = false,
  helpText,
}: {
  label: string;
  name: string;
  values: FieldValues;
  required?: boolean;
  multiline?: boolean;
  helpText?: string;
}) {
  const id = `field-${name}`;
  const commonStyle = {
    border: "1px solid #c9cccf",
    borderRadius: 6,
    font: "inherit",
    padding: "8px 10px",
    width: "100%",
  };

  return (
    <label htmlFor={id} style={{ display: "grid", gap: 4 }}>
      <Text as="span" variant="bodySm" fontWeight="semibold">
        {label} {required ? "*" : ""}
      </Text>
      {multiline ? (
        <textarea id={id} name={name} defaultValue={values[name] || ""} rows={4} style={commonStyle} />
      ) : (
        <input id={id} name={name} defaultValue={values[name] || ""} style={commonStyle} />
      )}
      {helpText ? (
        <Text as="span" variant="bodySm" tone="subdued">
          {helpText}
        </Text>
      ) : null}
    </label>
  );
}

export async function loader({ request }: { request: Request }) {
  await authenticate.admin(request);
  return null;
}

export async function action({ request }: { request: Request }) {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const values = valuesFromForm(formData);
  const errors: string[] = [];

  if (!values.productFamily) errors.push("Product family is required.");
  if (!values.quantity) errors.push("Quantity is required.");
  if (!values.customerName && !values.company && !values.email) {
    errors.push("Enter at least one customer identifier: customer name, company, or email.");
  }
  if (!values.customerSafeSummary && !values.internalNotes) {
    errors.push("Enter a customer-safe summary or internal notes.");
  }

  if (errors.length) {
    return Response.json({ ok: false, errors, values } satisfies ActionData, { status: 400 });
  }

  const recommendedStaffAction = values.recommendedStaffAction || "Review intake details";
  const contact = {
    customerName: values.customerName,
    company: values.company,
    email: values.email,
    phone: values.phone,
  };
  const productRequest = {
    productFamily: values.productFamily,
    productType: values.productType,
    quantity: values.quantity,
    dimensionsOrSize: values.dimensionsOrSize,
    materialOrSubstrate: values.materialOrSubstrate,
    finish: values.finish,
    deadline: values.deadline,
    shippingCityState: values.shippingCityState,
  };
  const normalizedDraft = {
    source: "staff_manual",
    status: "needs_staff_review",
    reviewLevel: "basic_staff_review",
    contact,
    productRequest,
    missingFields: [],
    escalationReasons: [],
    customerSafeSummary: values.customerSafeSummary,
    customerSafeDraftReply: values.customerSafeDraftReply,
    internalNotes: values.internalNotes,
    recommendedStaffAction,
    createdBy: "staff",
    requiresStaffApproval: true,
    canBecomeRealQuoteAutomatically: false,
  };
  const actorId = (session as any).userId ? String((session as any).userId) : null;
  const actorName = actorNameFromSession(session);
  const actorEmail = (session as any).email || null;

  await db.$transaction(async (tx) => {
    const item = await tx.agentReviewQueueItem.create({
      data: {
        shop: session.shop,
        source: "staff_manual",
        status: "needs_staff_review",
        reviewLevel: "basic_staff_review",
        customerName: values.customerName || null,
        company: values.company || null,
        email: values.email || null,
        phone: values.phone || null,
        productFamily: values.productFamily,
        productType: values.productType || null,
        quantity: values.quantity,
        dimensionsOrSize: values.dimensionsOrSize || null,
        materialOrSubstrate: values.materialOrSubstrate || null,
        finish: values.finish || null,
        deadline: values.deadline || null,
        shippingCityState: values.shippingCityState || null,
        contact,
        productRequest,
        missingFields: [],
        escalationReasons: [],
        customerSafeSummary: values.customerSafeSummary || null,
        customerSafeDraftReply: values.customerSafeDraftReply || null,
        internalNotes: values.internalNotes || null,
        recommendedStaffAction,
        originalAgentDraftSnapshot: normalizedDraft,
        normalizedDraft,
        createdBy: "staff",
        requiresStaffApproval: true,
        canBecomeRealQuoteAutomatically: false,
      },
    });

    await tx.agentReviewQueueEvent.create({
      data: {
        shop: session.shop,
        queueItemId: item.id,
        eventType: "queue_item_created",
        actorType: "staff",
        actorId,
        actorName,
        actorEmail,
        message: "Staff created internal review queue item.",
        afterSnapshot: normalizedDraft,
        metadata: { source: "staff_manual", phase: "6H" },
      },
    });
  });

  return redirect("/app/erp/agent-review-queue?created=1");
}

export default function NewAgentReviewQueueItemPage() {
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  const navigation = useNavigation();
  const navigate = useNavigate();
  const values = actionData?.values || {};
  const saving = navigation.state === "submitting";

  return (
    <Page
      title="Internal Staff Queue Item"
      subtitle="Create a staff-review draft for future queue workflows"
      backAction={{ content: "Agent Review Queue", onAction: () => navigate("/app/erp/agent-review-queue") }}
    >
      <BlockStack gap="400">
        <Banner tone="warning">
          <Text as="p">
            This creates a staff-review draft only. It does not create a quote, send a customer
            message, create a Shopify order, or start production.
          </Text>
        </Banner>

        {actionData?.errors?.length ? (
          <Banner tone="critical">
            <BlockStack gap="100">
              {actionData.errors.map((error) => (
                <Text as="p" key={error}>
                  {error}
                </Text>
              ))}
            </BlockStack>
          </Banner>
        ) : null}

        <Form method="post">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Customer
                </Text>
                <Field label="Customer name" name="customerName" values={values} />
                <Field label="Company" name="company" values={values} />
                <Field label="Email" name="email" values={values} />
                <Field label="Phone" name="phone" values={values} />
                <Text as="p" variant="bodySm" tone="subdued">
                  Enter at least one customer identifier: customer name, company, or email.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Product request
                </Text>
                <Field label="Product family" name="productFamily" values={values} required />
                <Field label="Quantity" name="quantity" values={values} required />
                <Field label="Product type" name="productType" values={values} />
                <Field label="Dimensions or size" name="dimensionsOrSize" values={values} />
                <Field label="Material or substrate" name="materialOrSubstrate" values={values} />
                <Field label="Finish" name="finish" values={values} />
                <Field label="Deadline" name="deadline" values={values} />
                <Field label="Shipping city/state" name="shippingCityState" values={values} />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Staff review notes
                </Text>
                <Field
                  label="Customer-safe summary"
                  name="customerSafeSummary"
                  values={values}
                  multiline
                  helpText="Safe summary staff can review before any customer response."
                />
                <Field
                  label="Customer-safe draft reply"
                  name="customerSafeDraftReply"
                  values={values}
                  multiline
                  helpText="Draft text only. Nothing is sent from this page."
                />
                <Field label="Internal notes" name="internalNotes" values={values} multiline />
                <Field
                  label="Recommended staff action"
                  name="recommendedStaffAction"
                  values={values}
                  helpText="Defaults to Review intake details."
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  Enter a customer-safe summary or internal notes before creating the queue item.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Fixed safety defaults
                </Text>
                <Text as="p">Source: staff_manual</Text>
                <Text as="p">Status: needs_staff_review</Text>
                <Text as="p">Review level: basic_staff_review</Text>
                <Text as="p">Requires staff approval: yes</Text>
                <Text as="p">Can become a real quote automatically: no</Text>
              </BlockStack>
            </Card>

            <InlineStack gap="300">
              <Button submit variant="primary" loading={saving}>
                Create staff review draft
              </Button>
              <Button onClick={() => navigate("/app/erp/agent-review-queue")}>Cancel</Button>
            </InlineStack>
          </BlockStack>
        </Form>
      </BlockStack>
    </Page>
  );
}
