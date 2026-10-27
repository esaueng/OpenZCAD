---
row: U03
---
Two design reviews' remaining eight findings are covered by this slice: phone
sign-in uses the documented compact Turnstile size when its container cannot
fit 300 px; sparse phone model panels hug content and keep the modeling rail
clear; More tools wraps complete labels; exact entry closes its parent Options
and re-clamps after resize; command options scroll within the available stage;
320 px headers keep project navigation and mode controls in separate rows;
canceling an extrusion edit replaces its stale preview instruction; disabled
menu actions keep their explanatory text at normal contrast.

`test/e2e/design-review-followups.spec.ts` exercises these rendered states in
light and dark, including 1440, 390, 360 and 320 px widths, comfortable density,
844 × 390 landscape, real keypad Apply clicks, and reopening a canceled edit
to check the stored distance. The challenge test models the vendor's intrinsic
widget sizes while retaining the unverified sign-in gate. Screenshots are
attached to the Playwright run. The existing command-action contrast tests
continue to cover the Done shortcut and mobile action fixes from #966; their
toast case now triggers fresh feedback instead of depending on an expired
completion message. U03 remains Partial.
