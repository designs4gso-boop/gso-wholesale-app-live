# GSO ERP — Production Event Presentation (Patch 15E.3, 2026-07-24)

## Summary rules
app/lib/production-event-presenter.server.ts turns raw ProductionJob events
into human-readable cards. Known types (finalize/reopen/update, all four
job-created sources, proof events, alerts, status/notes) get titled summaries;
finalize events show Final cost / profit / margin / Variance / Gate / Reason
parsed from the embedded "SNAPSHOT {json}" payload; reopen events show the
previous final figures + reason from "PRIOR FINAL {json}". Raw JSON NEVER
renders inline in the summary.

## Expandable audit detail
"Show audit details" (collapsed by default) renders formatted sections —
Inputs / Cost components / Revenue and totals / Variance / Gate and warnings /
Actor and timestamp / DTP details — with empty fields omitted. A nested
"Raw event data" block shows the pretty-printed payload in a scrollable code
area. The original event message is always preserved; nothing is lost or
rewritten.

## Legacy / blank events
Events without structured data render a compact "Legacy event" card (title
from the event type, timestamp kept, raw detail available). Cards never render
rows of empty labels. Malformed embedded JSON falls back to the readable
message head — display never crashes and never mutates the record.

## Historical name display cleanup (display-only)
The shared commercial-name resolver cleans product names AT DISPLAY TIME in:
Reports Dashboard top products + job profitability + events, the production
board item titles (loader-computed displayTitle), Quotes/CRM headers (15D.2),
and CSV exports (which already use the normalized clean labels). Stored DB
values, IDs, snapshots, tickets, source links, Shopify orders, and historical
filenames are NEVER altered.

## Dry-run historical name audit
Reports Dashboard -> "Historical Name Audit (dry run)" (?nameaudit=1):
READ-ONLY scan of recent QuoteItem.productName and
ProductionJobItem.productTitle via assessCommercialName. Rows show record
type/ID, related quote/ticket, current stored value, proposed display value,
reason, confidence: HIGH = known placeholder-corruption pattern (fragments +
clean remainder) — the only class eligible for future backfill; MEDIUM =
placeholder-only value; LOW = cosmetic/ambiguous. No update method exists in
the audit path (test-pinned).

## Future owner-approved backfill (NOT built)
1) run dry report; 2) export/record the rows; 3) owner reviews; 4) apply ONLY
selected HIGH-confidence IDs; 5) write an audit event per changed record;
6) preserve the prior value in the event. Until then, history is immutable.
