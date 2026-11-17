# History text and custom-feature scripts

[L15](../ROADMAP.md#l15). Design and rationale:
[docs/plans/l15-scripting-design.md](plans/l15-scripting-design.md).

OpenZCAD prints a project's feature history as text, reads an edited text
back into the same edits the app makes, and runs custom features written as
small scripts. This page is the reference for **history text version 1** and
**scripts `api 1`**, and the stability contract both are held to.

## Where it is

- **In the app:** the History panel's header has **History as text**. The
  text follows every edit made in the model while it is unedited; **Check**
  lists problems by line and column and the changes an edit makes; **Apply**
  checks the edit on the exact kernel and commits it as one undo step
  ("Edit history text"). If the model changes while you edit, Apply is
  refused until you reload the text.
- **For agents:** the `openzcad-mcp` server's `get_history_text`,
  `preflight_history_text` and `apply_history_text` tools (scopes `read`,
  `preflight` and `edit`), beside the patch tools.

An edit is compiled into the same patch proposal the assistant and the agent
API submit, so it passes the same validation and exact preflight; nothing in
the text writes the document directly.

## History text, version 1

```text
openzcad history 1
units mm

param #param_… width: length = `40 mm`
param #param_… count = `4` { exposed: false }

primitive #feat_… "Block" -> #body_… {
  primitiveKind: "box",
  dimensions: { width: `width`, height: 30, depth: 20 },
}

fillet #feat_… "Round" -> #body_… {
  targetBodyId: #body_…,
  edgeReferences: [edge(#feat_…, "<lineage name>")],
  radius: 2,
}
```

- The header names the version and the document's units. Units are changed
  in the app, not in the text.
- A **parameter** is `param #id name[: length|angle|number] = value`, with an
  optional record of `toggle`, `exposed`, `description` and `@metadata`.
- A **step** is `kind #featureId "name" [-> #bodyId] { fields }`. Fields are
  the stored feature data, so every feature kind prints. `@metadata` holds the
  node's metadata; a sketch step adds `@sketch` (its plane, constraints and
  dimensions) and `@objects` (its objects, each `kind #id "name" { … }`).
- **Values:** numbers, `"text"`, `true`/`false`, `null`, lists, records,
  `#ids`, expressions in backticks (`` `width / 2` ``, or `expr("…")` when the
  expression contains a backtick), multi-line text between `"""` (no escapes),
  and picks: `face(#feature, "lineage")` / `edge(…)`.
- An expression may sit only in a field the evaluator reads as one, and is
  checked with that field's quantity. A pick resolves only to a face or edge
  the document already stores; the text never invents one. A hash list that
  its picks imply is left out of the text.
- Comments (`//`) and layout are free and are not kept: the text is printed
  again canonically after every change.

What an edit can do: change any value a step stores; rename steps and
parameters; add, retype and delete parameters; delete and reorder steps; add
primitives and custom features at the end; change the values of sketch
objects. What it refuses, by name, at the statement: changing a step's kind
or body, a field the step does not store, `@metadata`, a sketch's plane or
constraints, adding or removing sketch objects, and creating other kinds of
step (create them in the app, then edit them here).

## Scripts, api 1

```text
script "acme/rounded-tray" "1.0.0" api 1 {
  input round: length = `5 mm`
  input wall: length = `2 mm`
  pick corners: edges 4 = edges().type("line").axis("z")
  step fillet { edges: #corners, radius: `round` }
  pick top: face = faces().normal("z").max("z")
  step shell { faces: #top, thickness: `wall` }
}
```

- **Header:** a lower-case, namespaced id, a `major.minor.patch` version and
  `api 1`.
- **`input name: length | angle | number | count [= default]`.** The
  instance sets an input to a number or an expression of the document's
  parameters; it is checked with the input's quantity. Inputs are in scope in
  the steps, shadowing parameters of the same name.
- **`pick name: face | edge | faces N | edges N = query`.** A pick is
  evaluated on the body as the steps before it left it, just before the first
  step that uses it, and must find **exactly** its count or the whole feature
  refuses (`Pick #corners found 4 edges; it needs exactly 3.`).
- **Queries** start from `faces()` or `edges()` and narrow with filters, in
  order. Every comparison is exact in the ADR-011 witness quantum; there is
  no tolerance.

  | Filter                   | Keeps                                                                   |
  | ------------------------ | ----------------------------------------------------------------------- |
  | `type("plane")` …        | Faces or edges of that kind (`plane`, `cylinder`, `line`, `circle`, …). |
  | `normal("x"\|"y"\|"z")`  | Planar faces whose normal lies along the axis (either side).            |
  | `axis("x"\|"y"\|"z")`    | Cylindrical faces, straight edges and circles along the axis.           |
  | `radius(expr)`           | Cylindrical faces of that radius.                                       |
  | `max(axis)`, `min(axis)` | The entities at the extreme of their centre along the axis (ties kept). |

- **Steps:** `fillet { edges, radius }`, `chamfer { edges, distance }`,
  `shell { faces, thickness }`. Each runs as the ordinary feature of that
  kind, with that feature's own exact checks and refusals.
- **Limits:** 60 steps, 60 picks, 30 inputs, 64 KiB of source, values nested
  at most 64 deep. There is no loop, no function, no import and no I/O.

### Running

A custom feature (`custom-feature` step, schema v107) embeds its script and
replaces its target body. It runs in the kernel worker with the rest of the
build: the interpreter is pure data handling inside OpenZCAD; it executes no
code from the script. The steps run under the instance's own id, so warnings
and lineage name the instance; intermediate bodies are discarded, and a
refusal anywhere publishes nothing from the instance (its target passes
through unchanged, as for any failed step).

### Publishing and versions

- An instance stores its script's `id`, `version`, `api`, `source` and
  `digest`, the SHA-256 of the source. A source that no longer matches its
  digest refuses, in the app and in the build.
- **A published version is immutable.** Every instance of one id and version
  in a project carries the same source; editing it requires a new version.
  In the history text, change the source and its version together (and leave
  `digest` out; it is computed when the version is published). Moving an
  instance to a new version is an ordinary, previewed, undoable edit; nothing
  updates instances automatically.

## Stability contract

- `openzcad history 1` and `api 1` are the contract versions. Within a major
  version, nothing a statement, field, filter, step or default means will
  change; additions are new optional fields, filters and steps.
- The frozen corpus in `test/scripting/contract/v1` holds scripts, the
  volume, face count and warnings each builds to, and a document with the
  exact text it prints. `test/scripting-contract.test.ts` runs it on every
  change; the files are pinned by digest. Changing a recorded value or file
  is a breaking change: it needs a new major version, a migration that
  rewrites old text and scripts, and the old major kept readable.
- A recorded refusal may become a result in a later release (a kernel fix);
  a recorded result may not become a refusal within the major unless the
  kernel proves it was wrong, and the release notes then list the cases.
