# Configurations and customizer links (F06)

[ROADMAP F06](../../ROADMAP.md#f06): a variant table on the document whose rows
are named configurations and whose columns are parameters, feature
suppression, body visibility and material; one active configuration per view
and per assembly instance; exact export of any row; and a Tweak link that
selects a row and exports STL or 3MF. Switching rows must rebuild within the
W01 budgets ([baselines](../performance/2026-11-15-active1-baselines.md)).

It grows from the L05 [on/off body parameters](../body-visibility-parameters.md):
an on/off parameter is an ordinary parameter column, and a body hidden by the
active row is hidden exactly where an off switch hides it.

## User task

A part comes in sizes or variants (a bracket in 20, 30 and 45 mm, with and
without a lug, in aluminium or steel). The owner keeps one history and names
each variant as a row, switches between them while modelling, exports any of
them, and shares a link where someone else picks a row and downloads a
printable file.

## Data contract (schema v72)

`ProjectDocument.configurations?: ConfigurationSet`
(`packages/shared/src/configurations.ts`):

```ts
type ConfigurationColumn =
  | { kind: 'parameter'; parameterId }
  | { kind: 'suppression'; featureId }
  | { kind: 'body'; bodyId }
  | { kind: 'material' };

interface ConfigurationRow {
  id;
  name;
  parameters: Record<ParameterId, string>; // expression
  suppressed: Record<FeatureId, boolean>; // true: suppressed
  bodies: Record<BodyId, boolean>; // true: shown
  material?: MassDensitySelection; // present iff a material column
}

interface ConfigurationSet {
  columns;
  rows;
  activeRowId;
}
```

- **Dense.** Every row holds a value for every column, so a row means the same
  thing whichever row was active before it. A new column takes the model's
  current value in every row (shown, unit density for body and material); a
  new row copies the active row as the model holds it.
- **The model is the active row.** The active row's parameter and suppression
  values are the parameters' own expressions and the features' own
  `suppressed` flags, so every rebuild, panel, export and the agent API read
  the active row without knowing the table exists. Activating another row
  first copies those live values back into the row being left (an edit made
  while a row is active stays in that row), then writes the new row's values
  into the model, as one undoable command. Setting a parameter or suppression
  cell of the active row changes the model in the same step.
- **Body and material read from the table.** They have no other home in the
  document, so the active row's value is read directly:
  `getParameterHiddenBodyIds` adds the bodies it hides (display, STEP/mesh
  export and the exact adapter's export filter, as for L05), and the
  Inspector's mass properties use its material in place of the per-browser
  density choice.
- **Stable ids.** Columns name parameters, features and bodies by id, so a
  rename keeps the column. A column whose target is deleted stays, labelled
  as deleted, and is skipped when a row is applied; the owner removes it.
- **Refusals.** A row the model cannot take (an unevaluable expression, a
  non-0/1 value for an on/off parameter, a value that would change a sketch's
  boundary topology) is refused naming the row, and nothing changes.
  Duplicate names (case-insensitive), deleting the active row, and duplicate
  columns are refused. Bounds: 100 rows, 200 columns, 80-character names.
- **Validation and gates.** `configurationSetError` runs on load, on every
  stored history change and on undo/redo. The section, its history changes
  and `configuration.*` commands need schema v72; an older client refuses the
  document rather than showing bodies the active row hides. Diagnostic
  reproductions keep the table (it decides what is exported) with row names
  replaced, and drop the commands, whose labels are the user's words.

## Slices

1. **Variant table and active row** (schema v72). Data contract above,
   commands (`configuration.create/delete`, `row.add/rename/delete`,
   `column.add/delete`, `cell.set`, `activate`), the Parameters panel table
   with a radio per row, undo/redo, replay, reload.
2. **Exact export of any row.** Export takes a configuration: the active row
   exports as today; another row is built from
   `documentForConfiguration(document, rowId)` in a disposable exact build,
   so nothing in the open document changes. STEP, STL and 3MF.
3. **Tweak link for a row.** A share link may name a row; Tweak shows the
   rows as a picker, builds the chosen row and exports STL or 3MF. The link
   carries the row id only; the row's values come from the shared document.
4. **Per view and per assembly instance.** A view (a drawing view, and the
   model viewer) and an assembly component may name a row; each is built
   from `documentForConfiguration` and shown at its own place, while the
   document's own active row stays the model being edited.
5. **Row-switch rebuild time.** A browser probe beside `perf-cad-edit`
   measures Switch → frame on the W01 fixtures and records the result
   against the W01 budgets on a quiet host.
