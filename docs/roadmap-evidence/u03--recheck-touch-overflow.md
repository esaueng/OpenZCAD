---
row: U03
---

13 November design review recheck (I1, I23, I8): on a touch tablet wide
enough to label them, the top bar's actions grow past 44 px to hold "File",
"Settings" and "Cloud unavailable" instead of drawing them over the next
action; at phone width a disabled command's wrapped reason stays in its own
command-list row instead of running over the next name; signed out, or
signed in with a project that has no account copy, the import card no longer
offers Archive now, which could only fail (`touch-targets.spec.ts`,
`ActivityPill.test.tsx`, `cloudArchivable.test.ts`).
