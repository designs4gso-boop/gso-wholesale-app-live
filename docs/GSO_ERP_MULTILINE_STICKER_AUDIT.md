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
