---
row: L07
state: Partial
---

Status correction (2026-11-22 ledger review): Revalidate → Partial. The 2026-10-02 audit merged removals with proof: it "removed `lib/extrudePreview.ts`, `lib/previewBodies.ts`, six unused exports and about twenty orphaned CSS selector groups with zero-reference proof". Remaining: `sketch-mode.css` orphans, the unused `ExtrudePreview` type, and two unreferenced exports that need a public-API decision.
