# L15 scripting and custom features design

**Status:** design for delivery. Slices A–D below are the L15 delivery; each
lands as its own pull request with a `l15--…` evidence fragment.

[L15](../../ROADMAP.md#l15) asks for three things:

1. a typed text form of the feature history that round-trips with the GUI,
   so an edit in either updates the other;
2. scripted custom features whose inputs are parameters and query-based
   picks rather than face indices;
3. a versioned stability contract for published scripts.

Scripts run in the kernel worker under the same exact-or-refuse rules as
every other feature, and the row shares its operation surface with
[L14](../../ROADMAP.md#l14) ([design note](l14-agent-api-design.md)).

## Principles

- **The document stays the only source of truth.** The text form is a
  projection of the canonical `ProjectDocument`, printed on demand. It is
  never stored beside the document, so the GUI and the text cannot drift:
  a GUI edit changes the document and the next print shows it, and a text
  edit is compiled into commands that change the document.
- **One change path.** A text edit becomes a `CadPatchProposal`, the same
  value the assistant and the L14 agent API submit. It passes
  `parseCadPatchProposal`, `validateCadPatchProposalAgainstDigest` and
  `preflightCadPatch` on the exact kernel, and commits through
  `CommandManager.runTransaction` as one ADR-023 undo entry. There is no
  second validator and no second commit path.
- **No general-purpose code runs.** A script is data interpreted by our own
  bounded interpreter: no `eval`, no `Function`, no imports, no I/O, no
  unbounded loops. Projects are shared, collaborated on and end-to-end
  encrypted; a script in a shared project must be as inert as a sketch.
  This is the main design decision, and the reason the language is
  declarative rather than an embedded JavaScript or Python runtime.
- **Exact or refuse.** Every query resolves to exactly the number of
  entities it declares or the feature fails, naming the query. Inputs are
  evaluated by the F05 typed evaluator with their declared quantity. A
  failing step fails the whole custom feature with the step named; no
  partial body is published.

## What already exists

| Need                                | Code                                                                                                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expressions (F05)                   | `evaluateExpression` / `evaluateFieldExpression` in `@openzcad/document-core`; typed parameters (`quantity`: length, angle, number) refuse dimensional mismatches on one throw path.                                                                        |
| Edit vocabulary (L14)               | `CadPatchOperation`, `CAD_PATCH_JSON_SCHEMA`, `parseCadPatchProposal` and `commandsForCadPatch`; app-compiled operations (such as `add_raised_feature_control`) are already excluded from the model's schema.                                               |
| Generic feature edit                | `commandFactories.updateFeature` (`feature.update`, a partial data patch plus `clearData`) validated per kind by `validateModelingFeatureUpdate`; `feature.delete`, `feature.reorder`, `node.rename`, `parameter.*`, `sketch.object.*`.                     |
| Exact preflight                     | `preflightCadPatch` (`apps/web/src/lib/aiPatchPreflight.ts`), already run headless by `openzcad-mcp`.                                                                                                                                                       |
| Verified references (K05, R01, I01) | `FaceTopologyReferenceV5` / `EdgeTopologyReferenceV5`: producing feature, lineage name, ADR-011 hash and an exact witness (surface or curve type, quantized centroid or end points, analytic carrier). Builders re-find them through verified lineage only. |
| Build loop                          | `exact-build-loop.ts` walks `featureOrder` and calls `buildFeature` per kind in the kernel worker, with cooperative cancellation and suppression pass-through.                                                                                              |

## Part 1: history text

### Format

A UTF-8 text, versioned by its first line. One statement per parameter,
sketch and feature, in document order (`parameterOrder`, then `featureOrder`
with each sketch printed at its feature's position):

```text
openzcad history 1
units mm

param width: length = 40 mm
param holes: number = 4

sketch #s_base "Base" on XY offset 0 {
  rectangle #o_rect { x: 0, y: 0, width: =width, height: 20 }
}

extrude #f_pad "Pad" {
  sketchId: #s_base,
  distance: =width / 2,
  operation: "new-body"
}

fillet #f_round "Round" {
  targetBodyId: #b_pad,
  edges: [ref(#f_pad, "<lineage name of the edge>")],
  radius: 2
}
```

- `#id` is a document id (feature, sketch, object or body). Ids are printed
  verbatim so a text edit addresses exactly what the GUI shows; a new
  statement may use `#new_name`, minted into a real id at compile time.
- A field value is a literal (number, string, boolean, list, record) or an
  expression introduced by `=`, which is a `ParamValue` string the F05
  evaluator reads. `=width / 2` prints and parses back as the stored string
  `"width / 2"`; a stored number prints as a number.
- `ref(#feature, "lineage")` is a verified topology reference. The printer
  writes the lineage name; the stored witness and hash are kept from the
  document when the name is unchanged and re-read from the exact build when
  it changes, so the text never carries a raw face index or hash.
- `//` comments are allowed and ignored. Comments and layout are not
  preserved: the text is re-printed canonically after every commit. A node's
  description is the place for durable notes.
- Fields follow the stored `FeatureData` names, so the format covers every
  feature kind, including kinds added later, without a per-kind grammar.
  The one per-kind rule is for picks: a stored pair of a hash list and its V5
  references (`edgeHashes` with `edgeReferences`, `openingFaceHashes` with
  `openingFaceReferences`, and the like) prints as one `edges` or `faces`
  list of `ref()` values. A legacy pick stored as a hash alone prints as
  `legacyHash(n)`: it round-trips unchanged but cannot be authored, and the
  checker says to re-pick it in the app.

### Types

The parser produces an AST with line and column on every node. The checker
validates each statement against the kind's shape (`document-validation.ts`)
and each expression field against its F05 field quantity, so `distance:
=angle_param` fails at its line with the evaluator's own sentence. Unknown
kinds, fields or ids are refused by name; nothing is silently dropped.

### Round trip

- **Text from the document:** `printHistory(document)` is pure and
  deterministic.
- **Document from the text:** `compileHistoryEdit(document, text)` diffs the
  parsed text against the document and returns a `CadPatchProposal`:
  `set_parameter` / `rename_parameter` / `delete_parameter`,
  `rename_feature`, `delete_feature`, and two new **app- and agent-compiled**
  operations, `update_feature` (a partial `FeatureData` patch plus
  `clearData`, compiled to `feature.update`) and `reorder_feature`
  (`feature.reorder`). New statements compile to the existing `add_*`
  operations; a kind the vocabulary cannot create (a loft, a sweep, an
  import) is refused with "create it in the app, then edit it here".
- **Identity law:** for every document `d`, `compileHistoryEdit(d,
printHistory(d))` yields no operations. A test asserts this over every
  parity-corpus document and sample project.
- **Fence:** the edit carries the document version it was printed from;
  compiling against a newer version refuses as stale, as the app's version
  fence does.

The two new operations are kept out of the assistant's strict output schema
(as app-compiled operations are today), but are part of the L14 surface, so
an agent and the text editor submit the same values.

### Where it shows

- **Web app:** a History text panel (lazily loaded with the scripting
  package, outside the entry bundle) shows the printed text, re-printed on
  every document change while the editor is clean. Apply runs exact
  preflight and commits one transaction ("Edit history text"); diagnostics
  point at line and column. A dirty editor whose base version moved shows a
  stale banner instead of overwriting the edit.
- **Agent API:** `get_history_text` (read), `preflight_history_text`
  (preflight) and `apply_history_text` (edit) beside the patch tools, with the
  same scopes, rate limits, fence and atomic write.

## Part 2: custom features

### Definitions and instances

A **script** is a named, versioned definition stored in the document (so a
project is self-contained and works offline and encrypted):

```text
script "openzcad.example/mounting-boss" 1.2.0 api 1 {
  input target: body
  input diameter: length = 8 mm
  input height: length = 6 mm
  pick seat: face = faces(of: target).plane().normal(+z).max(z)

  sketch #s on seat {
    circle #c { cx: 0, cy: 0, radius: =diameter / 2 }
  }
  extrude #e { sketchId: #s, distance: =height, operation: "add", targetBodyId: target }
  result target
}
```

An **instance** is a history feature of a new kind, `custom-feature`, that
names a script version and supplies its inputs:

```text
custom-feature #f_boss "Boss" uses "openzcad.example/mounting-boss" 1.2.0 {
  target: #b_pad,
  diameter: =boss_d
}
```

Schema (claimed when slice C opens, after checking open PRs; v95 and v96 are
in flight at the time of writing, so the expected number is v97):

- `ProjectDocument.scripts?: ScriptLibrary`, a record of definitions keyed by
  `id@version`, each with its canonical text, parsed form and SHA-256 digest.
  Absent means none; older documents are not rewritten.
- `FeatureData` gains `{ featureKind: 'custom-feature'; script: { id;
version; digest }; inputs: Record<string, ParamValue | BodyId> }`.
  Picks are not stored on the instance: they are queries in the definition,
  evaluated on every build.

### Language

The body of a script uses the history-text statements (sketch, extrude,
revolve, boolean, transform, mirror, shell, offset, fillet, chamfer, pattern,
datum plane and axis), with three additions:

- `input name: body | length | angle | number | count | boolean [= default]`.
  Numeric inputs are F05 expressions evaluated against the document's
  parameters, then checked against the declared quantity.
- `pick name: face | edge | faces N | edges N = <query>`, resolved on the
  exact topology at the instance's history position (or after an earlier
  step of the same script).
- `repeat i in 0..<count> { … }`, with a count that evaluates to an integer
  of at most 64 and a total expansion of at most `MAX_PATCH_OPERATIONS` (60)
  steps. There is no other control flow; there are no user-defined
  functions, recursion or I/O.

### Queries

A query starts from `faces(of: body)` or `edges(of: body | face)` and narrows
with filters that read only exact, kernel-neutral witness data:

| Filter                                                                                                                | Reads                                                                  |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `plane()`, `cylinder()`, `cone()`, `sphere()`, `torus()`, `freeform()`; `line()`, `circle()`, `ellipse()`, `spline()` | Surface or curve type of the witness.                                  |
| `normal(±x \| ±y \| ±z \| datum)`, `axis(…)`                                                                          | Analytic carrier direction, compared in the ADR-011 direction quantum. |
| `radius(expr)`                                                                                                        | Analytic radius, compared in the ADR-011 length quantum.               |
| `max(axis)`, `min(axis)`                                                                                              | Keeps the entities whose centroid is extreme along the axis.           |
| `created-by(#feature)`, `lineage(#feature, "name")`                                                                   | K05 producing feature and lineage name.                                |
| `adjacent(pick)`                                                                                                      | Exact face/edge adjacency of the B-rep.                                |

Equality is exact in the quantum; there is no user tolerance. A query that
yields a different count from its declaration refuses ("pick `seat` found 2
faces; it needs exactly 1"), and so does a tie at an extreme. A resolved pick
is published in the derived state as V5 references, so the viewport can
highlight it and downstream features can reference the instance's faces by
lineage.

### Exact build

The build loop gains one case. At a `custom-feature` it:

1. loads the pinned definition and checks its digest (a mismatch refuses);
2. evaluates the inputs with their quantities;
3. expands `repeat` and resolves picks step by step against the bodies the
   build holds at that point;
4. builds each step with the existing `buildFeature` on a synthetic feature
   node whose id is `<instance>/<step>`, so every existing per-kind refusal,
   cancellation check and lineage builder applies unchanged;
5. publishes one result under the instance with lineage names
   `custom.<step>.<inner name>`, and fails as a whole if any step fails.

Steps run in the kernel worker like any feature; the interpreter is pure
TypeScript with no kernel changes. Edit preflight, suppression pass-through,
the prefix cache and the history digest treat the instance as one feature
whose cache key includes the definition digest.

## Part 3: stability contract

- **Language version.** `openzcad history 1` and `api 1` name the contract.
  Within a major version a statement, field, filter or default never changes
  meaning; additions are optional fields and new filters only. A change that
  alters any existing script's result is a new major, shipped with a
  migration that rewrites old text, and the old major keeps parsing.
- **Script versions.** A published script has an id and a semantic version.
  An instance pins `{ id, version, digest }`; a definition stored under a
  version is immutable, so editing a published script means publishing a new
  version. Moving an instance to a new version is an explicit, previewed,
  undoable command ("Update script to 1.3.0"), never automatic.
- **Golden corpus.** `test/scripting/contract/v1/` holds history texts and
  scripts that must parse, print identically and build to the same volumes
  and face counts on every release. Removing or editing a golden case
  requires a new major.
- **Refusals are part of the contract.** A script that refuses today may
  start working in a later release; one that works may not start refusing
  within a major, except when the kernel proves it was wrong (a kernel
  correctness fix is recorded in the release notes with the affected cases).

## Delivery slices

1. **This note.**
2. **A — history text, read path:** a lazily loaded `@openzcad/scripting`
   package with the printer, parser, typed checker and diagnostics; the
   identity law over the parity corpus; a read-only History text panel.
   No schema change.
3. **B — text edits:** `compileHistoryEdit`, the `update_feature` and
   `reorder_feature` operations, Apply with exact preflight and one undo
   step, the stale fence, and the three agent API tools. No schema change.
4. **C — custom features:** schema bump, script library and instance kind,
   inputs, queries, `repeat`, exact expansion in the build loop, refusals,
   the `add_custom_feature` patch operation and the instance card in the
   app.
5. **D — stability contract:** the v1 golden corpus, digest pinning, the
   version-update command and the published language reference.

## Risks

- **Bundle size.** The parser, checker and panel live in a lazily loaded
  chunk; only the instance build case sits in the worker bundle.
- **Text size.** Large sketches print long. The panel virtualizes long
  documents, and the agent tool answers at most 4 MiB, as `get_document`
  does.
- **Lineage names as text.** A `ref()` is only as stable as K05 lineage. When
  a lineage name stops resolving the build fails closed with the existing
  stale-reference sentence; the text shows the reference, not a guess.
- **Performance.** A query reads witnesses the build already computes; an
  instance's cost is the sum of its steps, bounded by the 60-step limit.
