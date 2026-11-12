---
row: M07
---

Direct edits with no construction history (exact sleeve and blend-ladder wall
resizes, analytic cap offsets, blend resizes and removals, face-feature
removals, imported hole resizes, and moves the kernel journals only by
inference) now carry face names by exact predicted carrier instead of
dropping them: untouched faces keep their quantized plane or cylinder, the
edited face lands on the carrier the command constructs, and a name crosses
only when that carrier is unique among the source faces and in the result.
Names the retired positional reader placed elsewhere stay withheld so saved
references keep their exact-witness fallback (ADR-013 H01/M07 predicted-carrier
amendment; `remus-predicted-carrier-lineage.test.ts`,
`test/direct-edit-predicted-carrier-lineage.test.ts`). On a reported 52-feature
box ∪ cylinder history, changing an upstream seam fillet from R2 to R3 now
fails 4 later features instead of 20.
