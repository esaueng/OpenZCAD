# Roadmap evidence fragments

An implementation PR records its delivery evidence here, one file per PR,
instead of appending to its row in [ROADMAP.md](../../ROADMAP.md). Ledger rows
are single-line table cells, so two open PRs that both append to a row (or to
neighbouring rows) always conflict, and each merge used to make the rest of the
open PRs un-mergeable. Separate files never conflict.

## Format

Name the file `<row>--<slug>.md` in lowercase, for example
`h02--lineage-cache-reuse.md`:

```markdown
---
row: H02
state: In review
---
Cached feature reuse keeps qualified lineage (`exact-history-cache.test.ts`,
PR #805).
```

- `row` (required): the master ID shown in the ledger (`H02`) or its anchor
  id (`h02`). It must match exactly one table row.
- `state` (optional): replaces the row's Status cell. Only one pending
  fragment may set the state of a given row.
- Body: the evidence text, written as you would have appended it to the row.
  Line breaks are folded into spaces.

`node scripts/roadmap-evidence.mjs` checks every fragment against the ledger;
the root Vitest suite runs the same check.

## Folding

`node scripts/roadmap-evidence.mjs --fold` appends each fragment to its row's
evidence cell (in file-name order), applies any `state`, and deletes the
folded files. Run it on a fresh branch from `main` and deliver the result as a
standalone `docs(roadmap): fold evidence` PR, so the ledger rewrite never rides
along with feature work.
