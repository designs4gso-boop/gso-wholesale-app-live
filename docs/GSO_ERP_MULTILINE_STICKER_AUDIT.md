# GSO ERP — Multi-line Sticker Audit (15F.0J-R, 2026-07-25)

## Reproduced defects (code-verified)
1. "Number of lines" = 1 (or "01") is SILENTLY IGNORED: the loader/action
   gate is lineCount >= 2 (app.erp.cost-calculator.tsx, both pipelines), so
   an employee adding ONE extra line gets a single-line quote with no
   warning. "01" parses to 1 via Math.floor(Number()) — same silent drop.
2. Incomplete/zero-quantity lines VANISH: combineStickerLines filters
   quantity > 0 with no error surface; a line missing its quantity (or
   material/dims -> engine blockers surface, but qty-0 does not) simply
   disappears from cost, price, and snapshot.
3. PRIMARY-LINE REPLACEMENT is unstated: when multi-line is active the
   combined block uses ONLY psl* lines — the main form's product line is
   NOT included, and nothing tells the employee it was replaced.
4. No per-line field errors; totals panel lacks total designs/sqft;
   save/reopen via psearch replay preserves lines correctly (no defect);
   snapshot multiLine block records what priced (correct, but records the
   silently-reduced job).

## Target safety behavior (for the fix patch)
- Any psl row containing ANY value counts as an ACTIVE line; active-but-
  incomplete lines produce exact field-level errors (quantity/designs/
  width/height/material) and BLOCK READY TO QUOTE until fixed or removed.
- lineCount >= 1 activates multi-line; the main line either becomes Line 1
  (visible) or the UI states "line entries replace the single-line form".
- Visible totals: active lines, total pieces, total designs, total printed
  sqft, total adjusted sqft, per-line subtotal, job total.
- Tests: "01" one-line job prices the extra line; qty-blank line blocks
  with a named field error; primary+2 lines totals include all three (or
  the replacement banner asserts).

## 15F.0J.2 FIXED (2026-07-26)
All audited defects closed: (1) pslcount now counts ADDITIONAL lines and
>=1 activates ("01" = exactly one line; invalid counts REJECTED with
messages via normalizeAdditionalLineCount — never clamped); (2) the primary
form is ALWAYS Line 1 and additional lines start at Line 2 (stated in the
UI — nothing is replaced); (3) active-but-incomplete lines stay visible
with exact field-level errors (validateStickerLine), price $0, force
BLOCKED, and REFUSE the save until fixed or removed — the silent qty>0
filter in combineStickerLines is dead (qty-0 without errors still
blocks); (4) explicit Remove line / Add line buttons (hidden pslcount
always posts rows.length); (5) totals panel shows active lines, pieces,
designs, finished + adjusted sqft, machine, ink, cutting, line costs,
job packing (once), job cost, selling price; per-line table shows number,
qty, size, designs, finish, printer, sqft, adjusted sqft, machine, ink,
cutting, subtotal. Save/psearch replay preserved; snapshots carry the
combined lines/totals; historical snapshots untouched. 8 regression tests
(incl. the exact 585 + blank-lid-quantity scenario). Tests 621 -> 629.
