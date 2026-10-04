# GSO Art Approval Contract

Code: `app/lib/ops/art-preflight.server.ts`, `app/lib/ops/art-approval.ts`. Tests: `tests/ops-art-workflow.test.ts`.

## Preflight (technical, deterministic)

Input: job spec (family, width/height in, sides, design count, white/gloss layers, white coverage, printer selection, cut type) + **supplied** file facts (name, hash, artboard, pages, colour space, min raster dpi, cutline layer, fonts outlined).

| Check | Result |
|---|---|
| no file / unsupported extension (`ARTWORK_EXTENSIONS`) | FAIL |
| artboard ≠ spec (±0.01 in) | FAIL; rotated 90° = WARN |
| artboard unknown (dimensioned families) | NEEDS_DESIGNER |
| raster < 150 dpi | FAIL; 150–299 | WARN |
| RGB/mixed colour | WARN; unknown | NEEDS_DESIGNER |
| fonts not outlined | WARN |
| labels/sticker bags: cutline layer missing | WARN; unknown | NEEDS_DESIGNER |
| GSO cutline (−0.0625 in per side) underivable | FAIL |
| white/gloss with Mimaki explicitly selected (`MIMAKI_SPECIALTY_UNSUPPORTED`) | FAIL |
| white selected without coverage | WARN (coverage is operator-supplied, never defaulted) |
| fewer files/pages than designs; sides vs files | WARN |

Expected cutline is reported (e.g. 4×5 in → `3.875 x 4.875 in`). No PDF is parsed by the agent; unknown facts are never guessed.

## Approval states and who may set them

| State | Who | Binding |
|---|---|---|
| TECHNICAL_PREFLIGHT_PASSED | agent (`art_preflight`) or staff | versionId + fileHash |
| CUSTOMER_APPROVED | customer proof portal (`proofStatus=approved`), or staff recording the customer's explicit decision **with evidence** | versionId + fileHash + approver + source + timestamp |
| FINAL_ART_APPROVED | staff/owner, only when CUSTOMER_APPROVED and TECHNICAL_PREFLIGHT_PASSED exist on the **same** version + hash | same |

An agent may never set CUSTOMER_APPROVED or FINAL_ART_APPROVED. Recording the same state twice is idempotent.

## Versioning

`registerNewVersion` invalidates every live approval on any other version/hash (stamps `invalidatedAt`, `invalidatedBy`). `productionArtReadiness(records, currentVersion)` is **computed**; it is true only with all three states live on the current version. The production transition guard requires `artApproved` to enter routed/printing/cutting/production.

## ERP bridge

`approvalFromProofPortal(job, version)` maps the existing proof portal fields to a CUSTOMER_APPROVED record. No ERP write is performed by the agent; persisting approval records is part of deployment Phase 2.

## OPS-2 update (2026-10-04)

Unchanged contract. With the reasoning layer, a model may summarise preflight findings, explain corrections, draft designer notes and classify issue descriptions through `getArtStatus` / `proposeArtReview`. A model can NEVER set CUSTOMER_APPROVED, FINAL_ART_APPROVED or a QC pass: those states are written only by `recordApproval` with a human/portal approver, and `record_final_art_approval` intents need a mapped human approver plus the execution kill switch. A revised file version still invalidates all prior approvals.
