import { Form } from "react-router";

// 2026-11-18: per-item apply for Cost Verification → Approved Cost Updates.
// Posts to the SAME owner-only route action as the bulk form, with the row's
// exact registry key as `onlyKey`, so exactly one approved update is applied.
// `applyScope=single` makes the server refuse the post if the key is missing,
// so this control can never fall through to an apply-everything.
export function ApprovedUpdateApplyOne({
  updateKey,
  label,
  confirmPhrase,
  applying,
}: {
  updateKey: string;
  label: string;
  confirmPhrase: string;
  applying: boolean;
}) {
  const key = String(updateKey ?? "").trim();
  if (!key) return null;
  return (
    <Form method="post" data-apply-one={key} style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 190 }}>
      <input type="hidden" name="intent" value="applyApprovedCosts" />
      <input type="hidden" name="applyScope" value="single" />
      <input type="hidden" name="onlyKey" value={key} />
      <input
        name="confirmPhrase"
        autoComplete="off"
        placeholder={confirmPhrase}
        aria-label={`Type ${confirmPhrase} to apply only ${label}`}
        style={{ padding: 6, border: "1px solid #d1d5db", borderRadius: 6, fontSize: 12 }}
      />
      <button
        type="submit"
        disabled={applying}
        style={{ background: applying ? "#9ca3af" : "#1d4ed8", color: "white", border: 0, borderRadius: 8, padding: "7px 10px", fontWeight: 700, fontSize: 12 }}
      >
        {applying ? "Applying..." : "Apply only this update"}
      </button>
    </Form>
  );
}
