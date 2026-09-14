# Measured editing across imported parts

The assistant and the **Measured edits** panel share a catalog of deterministic
parameter-binding recipes. Natural-language requests select a catalog candidate
with `use_edit_candidate`; the browser regenerates the recipe from the current
document and runs the same exact preflight used by the direct action. The model
may name the offered parameters but cannot author the candidate's topology,
measurements, or construction.

## Using the workflow

1. Select one part. Optionally select one or two planar faces for a distance.
2. Choose **Analyze selected geometry** to inspect a larger part or look for a
   raised-feature group. This runs locally in the geometry worker.
3. Choose a **Measured edits** action, or describe the dimension to parameterize
   and the name to give it in chat.
4. Review the exact preview and Apply. New dimension bindings start at the
   measured value; change the named parameter afterward.

Hole diameters, supported blend radii, and proven planar distances reuse their
existing direct-edit commands. An existing straight-section opening recipe can
also appear when its unmodified imported source is eligible. No file name or
part category is used to recognize any candidate.

**Measured only** values are not offered as editable parameters. This includes
blind-hole depth, counterbore depth, countersink angle, and the unsupported
chamfered-entry counterbore case. Existing saved bindings are not rewritten.

## Independent raised features

Foreground analysis can recognize an unambiguous group of constant-depth raised
profiles on one planar support. It does not require an opening or arm-height
recipe and does not read characters. The user reviews which profiles were found.

The command preserves the immutable STEP bytes, makes the source import produce
the exact base, and adds an import of the same source producing the exact raised
group. A boolean parameter, `show_details` by default, controls that group's
visibility and export inclusion. The AI can name it `show_text` or another valid
unused name. The group remains rigid.

This construction requires an unmodified imported source and one solid. It does
not support engraving, curved supports, mixed depths, ambiguous groups, or
separation after transforms or other downstream edits. These remain geometry
limitations, not prompt problems.

## Boundaries and replay

- Candidate IDs include project, revision, body, and a recipe-content selector.
  IDs are selectors, not authorization or proof of geometry. Compilation
  regenerates the candidate; exact references and kernel preflight remain the
  authority. Stale and invented candidates fail.
- Parameter names cannot overwrite existing controls. One proposal cannot mix
  measured bindings with arbitrary edits or select the same candidate twice.
- AI-authored low-level operation rollout flags remain unchanged. Selecting an
  app-measured candidate is a separate contract, equivalent to the direct UI
  action. The Worker explains this distinction in its capability instructions.
- The catalog has at most 30 candidates, and expanded proposals retain the
  60-operation limit. Incomplete lists are labeled; absence is not a claim that
  a part is universally uneditable.
- Background planar-distance discovery still has its 64-face limit. Explicit
  foreground analysis permits up to 2,048 faces, filters pairs by the selected
  face hashes, and attempts at most six distinct plane pairs. The kernel pair
  inventory still examines the solid; selection bounds the expensive edit trials.
- The current qualification probe tests a small increase. Every actual requested
  value is rebuilt and validated; the probe does not establish a safe range.
- Foreground analysis has separate worker and body-measurement cache keys.
  Results carry their analysis scope. Candidate preflight repeats that scope
  against the current document before expanding the recipe. Normal geometry
  broadcasts are not replaced by these caller-owned results.
- Initial dimensional bindings preserve geometry. Raised-feature separation
  intentionally changes body inventory while retaining the combined shape.
  Preflight checks compound command results recursively.

## Verification and remaining kernel work

Regression coverage includes an imported plate with 70 holes above the automatic
discovery limit, a selected face-distance binding, named controls, changed-value
rebuilds, stale/invalid selections, a plain embossed plate, visibility and export
inventory, and browser flows for natural-language binding and provider-free
foreground analysis. These are qualified fixtures, not an arbitrary-STEP claim.

General curved-face healing, arbitrary region translation/rotation, off-axis
straight-region reconstruction, and consumption of journaled kernel history need
their own kernel/adapter qualification. These remain under ROADMAP M05/M07/H03.
This delivery provides the shared workflow and broader access to existing exact
operations without presenting those remaining families as implemented.
