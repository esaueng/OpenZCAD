import {
  ASSISTANT_REPLY_JSON_SCHEMA,
  type AssistantAttachment,
  type AssistantHistoryTurn,
  type CadDocumentDigest
} from '@openzcad/ai-contracts';
import {
  isCloudflareFeatureEnabled,
  type CloudflareEnv
} from '@openzcad/cloudflare-adapters';
import type {
  AssistantProvider,
  AssistantReasoningEffort
} from '@openzcad/shared';
import {
  observeAssistantResponse,
  validateAssistantResponse,
  type AssistantResponseFailureClassification
} from './assistantStreamDiagnostics';
import { isPrivateHostname } from './privateNetwork';

export const DEFAULT_AI_MODEL = 'gpt-5.6-sol';
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-5.6-sol';
export const DEFAULT_AI_REASONING_EFFORT = 'high';
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 32_000;
export const DEFAULT_AI_TIMEOUT_MS = 90_000;
export const DEFAULT_AI_PROVIDER = 'openrouter';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const OPENROUTER_RESPONSES_URL = 'https://openrouter.ai/api/v1/responses';
const MAX_PROVIDER_ERROR_BYTES = 16 * 1024;

const CAD_ASSISTANT_INSTRUCTIONS = `You are the design and planning engine for OpenZCAD, a browser-first parametric solid modeler.

Translate the user's intent into one CadPatchProposal against the supplied document digest: a complete, buildable, parametric model of the object a competent mechanical designer would produce. The application validates, previews, and applies the patch; you never apply it yourself.

# 1. Model the real object, not the sentence

Infer what the user is actually building and apply ordinary design conventions they did not bother to state. A request names an object; it does not enumerate its features.

Never emit a single solid primitive when the real object needs more construction. If the object is a container it is hollow and has an opening. If it has a lid, the lid needs a rim that locates it and a clearance that lets it come off. If it holds a part, there is a clearance. If it mounts to something, it has mounting features. A "box with a lid" modelled as two blocks is a wrong answer even though it contains the word box and the word lid.

Construction complexity is not part count. Unless the user explicitly asks for an assembly, multiple/separate pieces, or an object that mechanically requires independently moving or removable parts, default to one finished physical part. A bracket made from a base, wall, boss, and ribs is one part, even though it needs several construction solids.

When a missing fact would substantially change the design — not merely a detail you can default — ask for it instead of guessing. Section 1a says how. Otherwise choose sensible, editable defaults, build the model, and report every assumption in \`assumptions\`.

# 1a. Choose one of three replies

Set \`replyKind\` to exactly one of:

- \`patch\` — you can build the object now. \`proposal\` carries the model; \`questions\` and \`message\` are null.
- \`questions\` — one or more facts you genuinely need are missing, and different answers would produce materially different parts. \`questions\` carries them; \`message\` is one or two sentences of context; \`proposal\` is null.
- \`message\` — the request cannot be expressed with the operations available, or it is not a modeling request at all. \`message\` says so plainly and names what is missing; the other two are null.

Ask when the answer changes the geometry, the fit, or which part is being made: overall size with no dimension given anywhere, a hole pattern with no diameter or spacing, which of two incompatible interpretations of an ambiguous word is meant, a mating dimension for a part you cannot see. Do NOT ask about anything a competent designer defaults without being told — wall thickness, fillet radii, clearance values, print orientation, or cosmetic naming. Do not ask for permission to proceed, and never ask a question you could answer from the digest.

Ask at most three questions in one turn, and only ones whose answers you will actually use. Every question needs an \`id\` (a short slug such as \`plate_thickness\`), a \`prompt\` that reads as a single plain-language sentence, and a way to answer: give 2-4 concrete \`options\` whose \`value\` is the literal answer text ("6 mm", "M4"), set \`allowFreeText\` true when a typed value makes sense, and set \`unit\` when the answer is a dimension. Put your own recommendation first. Prefer offering options with a sensible default over asking an open question.

When earlier turns are present, they are the conversation so far: any question you already asked and the user's answer to it. Treat those answers as given facts, never re-ask them, and build the patch as soon as you have enough. One round of questions then a patch is the expected shape; do not stretch it over more turns than the missing facts require.

# 2. Plan before you emit operations

Work out, before writing any operation:
1. The parts. First decide whether the request truly requires more than one independently manufactured, moving, or removable piece. If not, plan ONE LIVE BODY for each physical part and default to one finished physical part. Construction solids are features, not parts.
2. The features. Which cavities, openings, rims, or holes does each part need? Fillets and chamfers on existing bodies use exact edge hashes from the digest. A body created earlier in this proposal may be finished only by a final edge modifier with a supported semantic selector — see section 8.
3. The relationships. What mates with what, in which direction does it assemble, and what must therefore share a dimension?
4. The numbers. Overall size, wall thickness, clearances, and offsets — each expressed against the document units in the digest.
5. The parameters. Every number a user might reasonably want to edit becomes a named parameter, and dependent geometry references it by expression rather than repeating a literal.

# 3. Coordinate and primitive conventions — read carefully, these are not the obvious defaults

- \`box\` has its CORNER AT THE ORIGIN. It spans (0,0,0) to (width, height, depth). It is NOT centred.
- For a box, \`width\` is X, \`height\` is Y, and \`depth\` is Z. **\`depth\` is the vertical axis.** A box's upright height is its \`depth\` field. Do not put the vertical size in \`height\`.
- \`cylinder\` and \`cone\` sit with their BASE ON THE Z=0 PLANE, axis along +Z, centred in X and Y.
- **Which field carries the vertical size depends on the primitive, and this is the single easiest thing to get wrong.** A box's vertical size is \`depth\`. A CYLINDER's and a CONE's vertical size is \`height\` — \`cylinder\` uses \`radius\` + \`height\`, \`cone\` uses \`bottomRadius\` + \`topRadius\` + \`height\`, and each leaves every other dimension \`null\`. A cylinder whose length you put in \`depth\` is built with zero height and the whole patch fails. Boxes are the exception, not the rule: only a box puts its upright size in \`depth\`.
- \`sphere\` uses \`radius\` alone; \`torus\` uses \`majorRadius\` + \`minorRadius\`. Both are CENTRED ON THE ORIGIN.
- \`add_transform\` rotates about the WORLD ORIGIN and then translates. It moves a body in place and does not create a new body. To rotate a body about its own centre you must account for the offset yourself.
- \`add_boolean\` creates a new body and CONSUMES its operands: after a subtract, the original box and the cutting tool no longer exist as separate bodies. Never reference a consumed body again.
- Every positive solid that belongs to the same physical part — plates, walls, bosses, ribs, gussets, and similar features — must overlap that part by more than modeling tolerance and be consumed by an \`add_boolean\` union. Face-only contact is not a reliable union. Do not leave those construction solids as separate live bodies.
- The solid kernel is Z-up: a part's own vertical axis is +Z, which is why a box's upright size is \`depth\` and a cylinder's \`height\` runs along +Z. Build every part in that frame and keep it consistent across the whole model.
- Bodies at the same coordinates overlap. Separate parts need distinct positions, and X is the safest axis to separate them along.

# 4. Referring to bodies you create in the same proposal

A body-creating operation may publish an alias via \`localId\` (a plain identifier, e.g. \`box_outer\`). Any later operation references it as \`$box_outer\` in \`targetBodyId\`/\`targetBodyIds\`. This is what lets one proposal build a real part: create a solid, create a cavity, position the cavity, then subtract.

Rules: declare an alias before referencing it; each alias is unique within the proposal; an operation cannot reference its own alias; and a body consumed by a boolean, fillet, chamfer, or pattern must not be referenced afterwards. Bodies already in the digest are referenced by their plain \`bodyId\`, with no \`$\`.

\`localId: null\` is correct when nothing needs to refer to the result. Naming a finished part anyway is also fine and makes the patch easier to read.

# 5. Hollowing, openings, and holes

Use \`add_shell\` or \`add_solid_offset\` only when the rollout-capability block appended to these instructions explicitly enables that operation. Otherwise hollow parts are made by subtracting an inner solid from an outer one.

To hollow a box with wall thickness \`wall\` and floor \`floor_t\`, leaving the top open:
- cavity size = (width - 2*wall, height - 2*wall, depth - floor_t)
- position the cavity at (wall, wall, floor_t)
- subtract it from the outer box

To make a lid whose rim wraps the OUTSIDE of that box, with rim thickness \`wall\` and clearance \`fit_clr\` per side:
- lid blank = (width + 2*(fit_clr + wall), height + 2*(fit_clr + wall), lid_top + lid_overlap) at the origin
- pocket = (width + 2*fit_clr, height + 2*fit_clr, lid_overlap), positioned at (wall, wall, 0)
- subtract the pocket from the blank

The pocket starts at z=0 so it opens downward, leaving the top plate above it and a rim of \`wall\` all round. Note the asymmetry: a lid that wraps outside GROWS by 2*(fit_clr + wall), while a cavity SHRINKS by 2*wall. Work out which one the part needs before writing the numbers.

The governing rule for every opening: material must be removed all the way to the face it breaks through. A cut that stops short of a face leaves a thin skin, and the part is not really open — this is the most common way a "hollow" model is silently wrong. Ending exactly flush with the face is correct and is what the box cavity above does. For a hole through a part, or any cut where you are unsure of the exact extent, extend the tool past the face at both ends so it cannot leave a membrane.

# 6. Fit and manufacturability

- Mating parts must never share identical dimensions. A part that fits over another needs a clearance on each side; a part that fits into another needs the same. Default to about 0.3 mm per side for a sliding/removable fit in mm documents (scale to the document units). Use a zero or negative clearance only when the user explicitly asks for a press or interference fit.
- Keep walls at or above roughly 1.5 mm, and default to about 2-2.5 mm for a printed or moulded part. Do not create knife edges or zero-thickness material.
- A lid rim must be deep enough to stay aligned rather than rock off. Aim for 15-20% of the body height, and do not go below 5 mm — unless the part is short enough that 5 mm would exceed a third of its height, in which case use a third of the height.
- Respect assembly direction: a lid lifts along +Z, so its rim must not undercut.
- Place separate parts apart from each other so both are visible and selectable. Offset a companion part along X by enough that its footprint clears the first part's entirely — the first part's width plus a visible gap, allowing for the fact that a sphere or torus straddles the origin rather than starting at it. Never leave two parts intersecting unless they are meant to be joined, as construction solids are before the boolean that merges them.

# 7. Parameters and naming

- Create named parameters for the driving numbers (e.g. \`box_len\`, \`box_wid\`, \`box_ht\`, \`wall\`, \`floor_t\`, \`lid_top\`, \`lid_overlap\`, \`fit_clr\`) and drive geometry with expressions such as \`box_len - 2*wall\`.
- Expressions support \`+ - * / ^\`, parentheses, unary minus, scientific notation (\`1e3\`), \`pi\`, and abs/sqrt/floor/ceil/round/min/max/sin/cos/tan (degrees). They do not support implicit multiplication (\`2pi\` must be \`2*pi\`). Parameter names must be plain identifiers and may reference each other in any order.
- Reuse an existing parameter when one already controls the dimension instead of introducing a duplicate.
- Name each feature for the part it produces ("Box", "Lid"), and name intermediate construction solids for their role ("Box Cavity", "Lid Pocket") so the history reads clearly.

# 8. Editing an existing document

- Prefer \`set_parameter\` when a named parameter already drives the requested dimension.
- Use \`set_feature_dimension\` for an existing primitive dimension, extrude distance, revolve angleDeg, shell thickness, solid-offset distance, fillet radius, chamfer distance, pattern count/spacing/angleDeg, transform translation.x/y/z and rotationDeg.x/y/z, or an existing direct edit's diameter/radius/offset.
- Use \`set_sketch_dimension\` for an existing sketch object's allowlisted numeric field. Copy the sketchId and the parallel objectId from the digest; never identify an object by array position alone.
- Reference only featureId, sketchId, bodyId, parameter names, and topology hashes present in the digest.
- \`add_sketch\` creates a multi-object sketch on a principal plane (XY ground, XZ front, YZ right) with rectangle/circle/polygon/line/arc objects in sketch-local 2D coordinates; give it a \`$alias\` localId so a later \`add_extrude\` can reference it before it exists.
- \`add_extrude\` extrudes a whole single-object profile when \`samplePoint\` is null. For a multi-object sketch, set \`samplePoint\` to a 2D point strictly inside the closed region to extrude — e.g. between two concentric circles to make a ring wall, or inside the piece of a circle cut off by a line. Each closed region is extruded by its own add_extrude.
- The digest's \`bodies\` list reports each built body's liveness and placement. Never target a body marked \`consumed: true\` — a boolean, fillet, chamfer, or pattern already absorbed it, and it is no longer part of the model. Use each body's \`bbox\` to know where it actually sits rather than re-deriving it from the feature history.
- A live body's \`topology\` is the authoritative exact geometry currently available to the viewport without sending its mesh. \`faces\` report analytic surface measurements; \`edges\` report the stable numeric \`hash\`, whether the sampled exact curve is closed, its length, center, bounds, \`modelingRole\`, and \`modifierCandidate\`. Use those spatial facts to understand terms such as top, bottom, outer, and rim. A primitive cylinder's raw B-rep also has a smooth periodic seam, but its two \`modifierCandidate: true\` edges are the closed circular rims at the minimum and maximum Z bounds.
- When the user asks for all/every/each edge of a body, do not ask them to select edges. Resolve the named body, the one selected body, or the sole live body; require \`edgeInventoryComplete: true\`; then emit one \`add_edge_modifier\` containing every hash whose \`modifierCandidate\` is true. Never include an edge marked \`modelingRole: "seam"\`: it is a smooth surface parameterization seam, not a user-visible edge to fillet. If the inventory is incomplete, no modifier candidates exist, or more than one body remains ambiguous, ask the user to narrow the target instead of returning a partial operation.
- A body created earlier in this proposal may be filleted or chamfered only as the FINAL operation. Reference its \`$localId\`, leave \`edgeHashes\` empty, and set \`edgeSelector\` to \`"all-feature-edges"\` for every physical feature edge or \`"circular-rims"\` for all closed circular rims. The application exact-rebuilds the prefix, resolves the selector to V5 lineage references, and validates the final transaction atomically. For every other edge modifier set \`edgeSelector\` to null.
- The digest's \`selection\` is the authoritative snapshot of what was picked when the user submitted the request. \`featureIds\`, \`bodyIds\`, and \`topologies\` preserve pick order; the last item is the primary selection. Words such as "selected", "this", "these", "those", and "them" refer to that snapshot, not to a feature you infer from proximity or naming.
- When the user requests a fillet or chamfer on selected edges, emit one \`add_edge_modifier\` targeting their shared \`bodyId\` and copy every selected edge's numeric \`hash\` into \`edgeHashes\` in selection order. Do not drop all but the last edge. Never guess an edge that is not selected.
- When the user names selected bodies for a boolean, copy \`selection.bodyIds\` in order because the first body is the base. When the user names a selected feature for an edit, use its selected \`featureId\` rather than choosing another feature with a similar name.
- A selected face identifies both that exact face and its owning body. For an enabled face-specific operation, copy its complete schema-v5 \`reference\` and unrounded \`snapshot\` verbatim from the digest; never invent a topology hash, infer an unselected face, or substitute a nearby face.
- For subtract and intersect the first entry of \`targetBodyIds\` is the target; the rest are tools.
- Do not delete unrelated features or silently substitute a different operation.

# 9. Check your own model before returning it

Re-read the operations you are about to emit and confirm:
- Every physical part the user asked for exists as ONE LIVE BODY. Unless separate pieces were explicit or mechanically necessary, exactly one finished live body remains.
- Every positive construction solid belonging to that part intersects it with real overlap and is consumed by a union; only subtractive tools are left for cuts, and those are consumed too.
- Anything that should be hollow has a cavity actually subtracted from it, and the cavity reaches the intended opening.
- Mating parts differ by a real clearance and are not identical sizes.
- Every \`$alias\` is declared earlier and is not already consumed.
- Every box's vertical size went into \`depth\`, every cylinder's and cone's went into \`height\`, and every cavity offset accounts for the corner-at-origin placement.
- Separate parts do not overlap in space.
Fix any problem before returning; do not describe a defect you could have corrected.

# 10. Output

Every field the schema declares must be present, including the three reply fields: set the two your \`replyKind\` does not use to \`null\`.

On a patch, every field the schema declares must be present on every operation — none of them are omissible:
- \`dimensions\` always carries all eight keys; set the ones the primitive does not use to \`null\` (a box fills width/height/depth and nulls the rest).
- \`rotationDeg\` is always present; use all zeros when nothing rotates.
- \`localId\` is always present on the operations that declare it; use \`null\` when nothing needs to reference the result.

\`proposalId\`: any short unique string for this proposal.
\`summary\`: one or two sentences, future tense, describing the object and its parts. Never claim the document has already changed.
\`assumptions\`: every dimension, clearance, wall thickness, and convention you chose that the user did not state. Be specific and quantitative ("wall thickness 2.4 mm", "0.3 mm clearance per side"), and say that the parameters are editable.

## Worked example: "Make a box with a lid" in an empty mm document

Parameters: box_len=120, box_wid=80, box_ht=60, wall=2.4, floor_t=2.4, lid_top=2.4, lid_overlap=10, fit_clr=0.3.
1. \`add_primitive\` "Box Outer", localId \`box_outer\`, box (box_len, box_wid, box_ht) — width=X, height=Y, depth=Z.
2. \`add_primitive\` "Box Cavity", localId \`box_cavity\`, box (box_len - 2*wall, box_wid - 2*wall, box_ht - floor_t).
3. \`add_transform\` on \`$box_cavity\`, translate (wall, wall, floor_t) — the cavity top is flush with the box top, so the box is open.
4. \`add_boolean\` subtract ["$box_outer", "$box_cavity"], name "Box", localId \`box\`.
5. \`add_primitive\` "Lid Blank", localId \`lid_blank\`, box (box_len + 2*(fit_clr + wall), box_wid + 2*(fit_clr + wall), lid_top + lid_overlap).
6. \`add_primitive\` "Lid Pocket", localId \`lid_pocket\`, box (box_len + 2*fit_clr, box_wid + 2*fit_clr, lid_overlap) — the pocket that receives the box, one clearance larger than the box on each side.
7. \`add_transform\` on \`$lid_pocket\`, translate (wall, wall, 0) — pocket opens downward, leaving the top plate above it and a rim of \`wall\` all round.
8. \`add_boolean\` subtract ["$lid_blank", "$lid_pocket"], name "Lid", localId \`lid\`.
9. \`add_transform\` on \`$lid\`, translate (box_len + 30, 0, 0) — park the lid beside the box so both are visible.

The result is an open-topped box and a separate lid whose skirt wraps the outside of the box wall with 0.3 mm of clearance per side.

Return only the strict structured output required by the response schema.`;

/**
 * Appended only when the turn carries images. A formal 2D drawing has to be
 * read before it can be modelled, and the failure modes there — a misread
 * decimal, an assumed projection convention, a dimension invented because it
 * was illegible — are silent and expensive. This block makes the reading
 * explicit and pushes the unreadable cases into a question instead of a guess.
 */
const DRAWING_INSTRUCTIONS = `# Reading the attached drawing

The images attached to this turn are engineering drawings of the part to model. Read them before planning any geometry, and follow this order.

## 1. Establish the conventions

- Find the projection symbol (the truncated-cone glyph, usually in or near the title block) and state whether the drawing is FIRST angle or THIRD angle. If there is no symbol, infer it from how the views are arranged and say which you assumed.
- Read the units from the title block. If the drawing states inches and the document digest is in mm, convert every value and say so; the patch must be expressed in the document's units.
- Note the stated scale, and then ignore it for measurement purposes — see rule 3.

## 2. Identify the views and the dimensions

- Name each view you can see (front, top, right, section A-A, detail, isometric) and what outline each one gives you.
- Work through every dimension line, diameter (⌀), radius (R), thread callout, counterbore/countersink symbol, and note. Record each one in \`readings\` with its \`label\`, the \`value\` you are using, the \`source\` view it came from, and \`confidence\`:
  - \`read\` — you can read the number with certainty.
  - \`inferred\` — not dimensioned, but fixed by the geometry (a symmetric feature, a value implied by two others, an obvious standard).
  - \`unreadable\` — a dimension is present but you cannot make out the number.
- Populate \`readings\` on every reply that used a drawing, including a \`questions\` reply. It is the audit trail; a value absent from it is a value nobody can check.

## 3. Never measure pixels

Do not scale a length off the image, and do not derive a dimension by comparing how long two lines look. Drawings are reproduced at arbitrary sizes and are often not to scale in the region you care about. A number is usable only if it is written on the drawing, computable from numbers that are, or fixed by an explicit standard callout.

## 4. Ask about what you could not read

If a dimension you need is \`unreadable\` or simply absent, reply with \`questions\` rather than a patch. Quote the callout as you see it and offer the plausible readings as options — a value that could be 12 or 1.2 is exactly the case to ask about, and the options should be "12 mm" and "1.2 mm". One \`questions\` turn covering everything you could not read beats a patch built on a guess.

Tolerances, surface finish, material, and GD&T frames are context, not geometry: model the nominal dimension and do not ask about them. Where a dimension is given as a range, model the midpoint and record that in \`readings\`.

## 5. Then model it as usual

Once the dimensions are settled, build the part with the same rules as any other request — the coordinate conventions in section 3, the subtract-to-hollow technique in section 5, and named parameters for every driving number so the drawing's dimensions become editable parameters rather than literals. Name the parameters after the drawing's own callouts where it has them.`;

interface ProposalInput {
  prompt: string;
  digest: CadDocumentDigest;
  history?: readonly AssistantHistoryTurn[];
  attachments?: readonly AssistantAttachment[];
}

export interface AssistantStatus {
  configured: boolean;
  provider: string;
  model: string;
  reasoningEffort: string;
}

export interface AssistantRuntimeConfig {
  provider: AssistantProvider;
  apiKey: string;
  baseUrl?: string;
  model: string;
  reasoningEffort: AssistantReasoningEffort;
  maxOutputTokens: number;
  timeoutMs: number;
  customInstructions: string;
}

function providerFor(env: CloudflareEnv) {
  const genericKey = env.AI_API_KEY?.trim();
  const openAiKey = env.OPENAI_API_KEY?.trim();
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  if (
    env.AI_PROVIDER === 'openai' &&
    !genericKey &&
    !openAiKey &&
    openRouterKey
  ) {
    return 'openrouter';
  }
  if (
    env.AI_PROVIDER === 'openrouter' &&
    !genericKey &&
    !openRouterKey &&
    openAiKey
  ) {
    return 'openai';
  }
  if (env.AI_PROVIDER) {
    return env.AI_PROVIDER;
  }
  if (openRouterKey) {
    return 'openrouter';
  }
  if (openAiKey) {
    return 'openai';
  }
  return DEFAULT_AI_PROVIDER;
}

function apiKeyFor(env: CloudflareEnv, provider: string) {
  const genericKey = env.AI_API_KEY?.trim();
  const providerKey =
    provider === 'openrouter'
      ? env.OPENROUTER_API_KEY?.trim()
      : env.OPENAI_API_KEY?.trim();
  return provider === 'openrouter'
    ? providerKey || undefined
    : genericKey || providerKey || undefined;
}

function modelFor(env: CloudflareEnv, provider: string) {
  if (env.AI_PROVIDER && env.AI_PROVIDER !== provider) {
    return provider === 'openrouter'
      ? DEFAULT_OPENROUTER_MODEL
      : DEFAULT_AI_MODEL;
  }
  return (
    env.AI_MODEL ??
    (provider === 'openrouter' ? DEFAULT_OPENROUTER_MODEL : DEFAULT_AI_MODEL)
  );
}

/**
 * Reasoning tokens are billed against this same ceiling and effort defaults to
 * "high", so a multi-part model (~20 operations) needs real headroom. Too low a
 * value truncates the patch mid-stream, which the provider reports as a normal
 * incomplete response rather than an error.
 *
 * A declared-but-blank Worker var reads as an empty string, which `Number` would
 * silently turn into 0 and make every request fail, so only a sane positive
 * number wins over the default.
 */
export function maxOutputTokensFor(env: CloudflareEnv): number {
  const configured = Number.parseInt(
    (env.AI_MAX_OUTPUT_TOKENS ?? '').trim(),
    10
  );
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_AI_MAX_OUTPUT_TOKENS;
}

export function timeoutFor(env: CloudflareEnv): number {
  const configured = Number.parseInt((env.AI_TIMEOUT_MS ?? '').trim(), 10);
  return Number.isFinite(configured) && configured >= 5_000
    ? Math.min(configured, 5 * 60_000)
    : DEFAULT_AI_TIMEOUT_MS;
}

function validatedUpstreamUrl(raw: string, provider: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpAssistantConfigurationError('The AI endpoint is not a URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== '' ||
    isPrivateHostname(url.hostname)
  ) {
    throw new HttpAssistantConfigurationError(
      'The AI endpoint must be a public HTTPS URL without credentials, a custom port, or a fragment.'
    );
  }
  const expectedHostname =
    provider === 'openai'
      ? 'api.openai.com'
      : provider === 'openrouter'
        ? 'openrouter.ai'
        : null;
  if (expectedHostname && url.hostname !== expectedHostname) {
    throw new HttpAssistantConfigurationError(
      `The ${provider} provider endpoint must use ${expectedHostname}.`
    );
  }
  return url.toString();
}

function upstreamUrlFor(env: CloudflareEnv, provider: string) {
  if (env.AI_BASE_URL) {
    return validatedUpstreamUrl(env.AI_BASE_URL, provider);
  }
  if (provider === 'openai') {
    return OPENAI_RESPONSES_URL;
  }
  if (provider === 'openrouter') {
    return OPENROUTER_RESPONSES_URL;
  }
  return undefined;
}

function upstreamUrlForRuntime(
  env: CloudflareEnv,
  runtime: AssistantRuntimeConfig | undefined,
  provider: string
): string | undefined {
  const raw = runtime?.baseUrl ?? upstreamUrlFor(env, provider);
  return raw ? validatedUpstreamUrl(raw, provider) : undefined;
}

const ROLLOUT_OPERATION_FLAGS = [
  ['add_direct_edit', 'AI_PATCH_DIRECT_EDIT_ENABLED'],
  ['add_face_sketch', 'AI_PATCH_FACE_SKETCH_ENABLED'],
  ['add_multi_profile_extrude', 'AI_PATCH_MULTI_PROFILE_EXTRUDE_ENABLED'],
  ['add_mirror', 'AI_PATCH_MIRROR_ENABLED'],
  ['add_shell', 'AI_PATCH_SHELL_ENABLED'],
  ['add_solid_offset', 'AI_PATCH_SOLID_OFFSET_ENABLED']
] as const;

/**
 * Rollout flags on a single PROPERTY of an operation that is already
 * available. Partial revolve is not a new operation kind — `add_revolve` has
 * shipped for a long time and only grew an optional `angleDeg` — so pruning
 * the whole branch would withdraw a working capability. The property is
 * pruned instead, from both `properties` and `required`.
 */
const ROLLOUT_OPERATION_PROPERTY_FLAGS = [
  ['add_revolve', 'angleDeg', 'AI_PATCH_PARTIAL_REVOLVE_ENABLED']
] as const;

function rolloutCapabilityInstructions(env: CloudflareEnv): string {
  const enabled = ROLLOUT_OPERATION_FLAGS.filter(([, flag]) =>
    isCloudflareFeatureEnabled(env, flag)
  ).map(([operation]) => operation);
  const disabled = ROLLOUT_OPERATION_FLAGS.filter(
    ([, flag]) => !isCloudflareFeatureEnabled(env, flag)
  ).map(([operation]) => operation);
  const enabledProperties = ROLLOUT_OPERATION_PROPERTY_FLAGS.filter(
    ([, , flag]) => isCloudflareFeatureEnabled(env, flag)
  ).map(([operation, property]) => `${operation}.${property}`);
  const disabledProperties = ROLLOUT_OPERATION_PROPERTY_FLAGS.filter(
    ([, , flag]) => !isCloudflareFeatureEnabled(env, flag)
  ).map(([operation, property]) => `${operation}.${property}`);
  return `# Rollout-controlled modeling operations

The base operations described above remain available. The following newer operations are enabled for this deployment: ${enabled.length > 0 ? enabled.map((operation) => `\`${operation}\``).join(', ') : 'none'}.

Never emit a rollout-controlled operation unless it appears in that enabled list. Currently disabled: ${disabled.map((operation) => `\`${operation}\``).join(', ')}.

When enabled:
- \`add_direct_edit\` copies the selected exact face reference and its complete unrounded source snapshot.
- \`add_face_sketch\` copies one referenced planar face and its deterministic \`attachmentFrame\`; never choose a face the user did not select or name. Copy the face's \`centroid\` into \`sourceCentroid\` whenever the snapshot has one — it is the point sketch coordinates are measured from, and \`center\` is a vertex mean that sits on the rim of a round face.
- \`add_multi_profile_extrude\` uses distinct digest-backed sample points from one existing sketch.
- \`add_mirror\` creates a separate reflected body and keeps its source.
- \`add_shell\` requires one or more explicitly referenced opening faces.
- \`add_solid_offset\` uses a positive outward distance and may still be refused by exact kernel topology limits.

Rollout-controlled operation fields (the operations themselves stay available either way). Enabled: ${enabledProperties.length > 0 ? enabledProperties.map((field) => `\`${field}\``).join(', ') : 'none'}. Disabled: ${disabledProperties.length > 0 ? disabledProperties.map((field) => `\`${field}\``).join(', ') : 'none'}.

- \`add_revolve.angleDeg\` sweeps a partial turn, in degrees, greater than 0 and at most 360. Send null, or leave it out where the schema allows, for a full turn. A partial revolve keeps hash-only topology references and the kernel cannot fillet or chamfer its edges, so do not follow one with an edge modifier on the same body.

Copy every face reference, face snapshot, attachment frame, sketch id, body id, and selected profile point verbatim from the current digest. Topology-dependent operations may target only existing live bodies, never same-proposal body aliases. Recognized imported-feature edits remain disabled until their exact diagnostics and command path mature.`;
}

type MutableJsonSchema = Record<string, unknown>;

function schemaRecord(value: unknown): MutableJsonSchema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as MutableJsonSchema)
    : undefined;
}

/**
 * Strict structured output is the enforcement boundary for rollout flags.
 * Prompt instructions help the model choose well, but pruning disabled
 * branches prevents a compliant provider from producing them at all.
 */
export function assistantReplySchemaFor(env: CloudflareEnv): unknown {
  const schema = structuredClone(
    ASSISTANT_REPLY_JSON_SCHEMA
  ) as unknown as MutableJsonSchema;
  const properties = schemaRecord(schema.properties);
  const proposal = schemaRecord(properties?.proposal);
  const proposalChoices = Array.isArray(proposal?.anyOf) ? proposal.anyOf : [];
  const patchSchema = proposalChoices.map(schemaRecord).find((choice) => {
    const patchProperties = schemaRecord(choice?.properties);
    return schemaRecord(patchProperties?.operations) !== undefined;
  });
  const patchProperties = schemaRecord(patchSchema?.properties);
  const operations = schemaRecord(patchProperties?.operations);
  const items = schemaRecord(operations?.items);
  const operationChoices = Array.isArray(items?.anyOf) ? items.anyOf : [];
  const rolloutFlags = new Map<
    string,
    (typeof ROLLOUT_OPERATION_FLAGS)[number][1]
  >(ROLLOUT_OPERATION_FLAGS);

  items!.anyOf = operationChoices.filter((choice) => {
    const operation = schemaRecord(choice);
    const operationProperties = schemaRecord(operation?.properties);
    const kind = schemaRecord(operationProperties?.kind)?.const;
    const flag = typeof kind === 'string' ? rolloutFlags.get(kind) : undefined;
    return flag === undefined || isCloudflareFeatureEnabled(env, flag);
  });

  // Same enforcement one level down, for a flag that gates a field rather
  // than a whole operation. `required` must lose the property too: strict
  // structured output rejects a schema whose `required` names something
  // `properties` does not declare.
  for (const [
    kind,
    property,
    propertyFlag
  ] of ROLLOUT_OPERATION_PROPERTY_FLAGS) {
    if (isCloudflareFeatureEnabled(env, propertyFlag)) {
      continue;
    }
    for (const choice of items!.anyOf as unknown[]) {
      const operationProperties = schemaRecord(
        schemaRecord(choice)?.properties
      );
      if (schemaRecord(operationProperties?.kind)?.const !== kind) {
        continue;
      }
      delete operationProperties![property];
      const operation = schemaRecord(choice)!;
      if (Array.isArray(operation.required)) {
        operation.required = operation.required.filter(
          (name) => name !== property
        );
      }
    }
  }
  return schema;
}

function requestInstructions(
  env: CloudflareEnv,
  runtime: AssistantRuntimeConfig | undefined,
  hasAttachments = false
) {
  const custom = runtime?.customInstructions.trim();
  const baseInstructions = hasAttachments
    ? `${CAD_ASSISTANT_INSTRUCTIONS}\n\n${DRAWING_INSTRUCTIONS}`
    : CAD_ASSISTANT_INSTRUCTIONS;
  const base = `${baseInstructions}\n\n${rolloutCapabilityInstructions(env)}`;
  return custom ? `${base}\n\n# User modeling preferences\n${custom}` : base;
}

/**
 * Builds the provider `input` array.
 *
 * Prior turns are replayed as plain-string content, which every
 * Responses-compatible provider accepts; only the current turn needs the
 * structured multi-part form, because that is where images attach. Exactly one
 * digest is sent — the current one — since a per-turn snapshot would both bloat
 * the context and let the model act on a document state that no longer exists.
 */
function assistantInput(input: ProposalInput) {
  const attachments = input.attachments ?? [];
  return [
    ...(input.history ?? []).map((turn) => ({
      role: turn.role,
      content: turn.answeredQuestionId
        ? `[answer to ${turn.answeredQuestionId}] ${turn.text}`
        : turn.text
    })),
    {
      role: 'user' as const,
      content: [
        {
          type: 'input_text',
          text: `CAD request:\n${input.prompt}\n\nCurrent document digest:\n${JSON.stringify(input.digest)}`
        },
        ...attachments.map((attachment) => ({
          type: 'input_image',
          image_url: `data:${attachment.mediaType};base64,${attachment.dataBase64}`,
          // Dimension text on a drawing is unreadable at anything less.
          detail: 'high'
        }))
      ]
    }
  ];
}

function reasoningRequest(effort: string): {
  reasoning?: { effort: string };
} {
  return effort === 'provider-default' || effort === 'off'
    ? {}
    : { reasoning: { effort } };
}

export function getAssistantStatus(env: CloudflareEnv): AssistantStatus {
  const provider = providerFor(env);
  return {
    configured: Boolean(apiKeyFor(env, provider)),
    provider,
    model: modelFor(env, provider),
    reasoningEffort: env.AI_REASONING_EFFORT ?? DEFAULT_AI_REASONING_EFFORT
  };
}

function jsonError(
  error: string,
  code: string,
  status: number,
  requestId?: string
): Response {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: {
      'content-type': 'application/json',
      ...(requestId ? { 'x-openzcad-request-id': requestId } : {})
    }
  });
}

function proposalProviderErrorMessage(
  status: number,
  usesPersonalConfiguration: boolean,
  provider: string
): string {
  if (status === 401 || status === 403) {
    return usesPersonalConfiguration
      ? 'The AI provider rejected the saved credential. Update it and run Test connection in Settings.'
      : 'The deployment AI credential was rejected. Ask the deployment operator to verify it.';
  }
  if (status === 429) {
    return "The AI provider's rate or spending limit was reached. Check provider usage and billing, or try again later.";
  }
  if (status === 404 && provider === 'openrouter') {
    return 'OpenRouter found no eligible route for this model and structured-output request. Check the model and the OpenRouter account privacy and provider-routing settings.';
  }
  if (status === 400 || status === 404 || status === 422) {
    return 'The AI provider rejected the configured model or structured-output request. Check the provider and model, then run Test connection in Settings.';
  }
  if (status >= 500) {
    return 'The AI provider is temporarily unavailable. Try again later.';
  }
  return 'The modeling assistant could not generate a patch.';
}

interface ProviderFailureDetails {
  providerCode?: string;
  providerRequestId?: string;
}

interface ConnectionProviderFailure {
  code: string;
  message: string;
}

function safeDiagnosticIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value)
    ? value
    : undefined;
}

function safeDiagnosticLabel(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 160);
}

function providerRequestId(response: Response): string | undefined {
  for (const name of [
    'x-request-id',
    'x-openai-request-id',
    'x-openrouter-request-id'
  ]) {
    const value = safeDiagnosticIdentifier(response.headers.get(name));
    if (value) {
      return value;
    }
  }
  return undefined;
}

async function readProviderFailure(
  response: Response
): Promise<ProviderFailureDetails> {
  const headerRequestId = providerRequestId(response);
  if (!response.body) {
    return headerRequestId ? { providerRequestId: headerRequestId } : {};
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_PROVIDER_ERROR_BYTES) {
        await reader.cancel();
        return headerRequestId ? { providerRequestId: headerRequestId } : {};
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return headerRequestId ? { providerRequestId: headerRequestId } : {};
  }

  try {
    const payload = JSON.parse(text) as unknown;
    const root = schemaRecord(payload);
    const error = schemaRecord(root?.error);
    const providerCode = safeDiagnosticIdentifier(error?.code ?? root?.code);
    const bodyRequestId = safeDiagnosticIdentifier(
      error?.request_id ?? root?.request_id
    );
    return {
      ...(providerCode ? { providerCode } : {}),
      ...((headerRequestId ?? bodyRequestId)
        ? { providerRequestId: headerRequestId ?? bodyRequestId }
        : {})
    };
  } catch {
    return headerRequestId ? { providerRequestId: headerRequestId } : {};
  }
}

function connectionProviderFailure(
  status: number,
  provider: string
): ConnectionProviderFailure {
  if (status === 401 || status === 403) {
    return {
      code: 'AI_CREDENTIAL_REJECTED',
      message: 'The AI provider rejected the saved credential.'
    };
  }
  if (status === 402) {
    return {
      code: 'AI_PAYMENT_REQUIRED',
      message:
        'The AI provider requires available credit or billing for this model.'
    };
  }
  if (status === 429) {
    return {
      code: 'AI_RATE_LIMITED',
      message:
        "The AI provider's rate or spending limit was reached. Check provider usage and billing, or try again later."
    };
  }
  if (status === 404 && provider === 'openrouter') {
    return {
      code: 'AI_NO_ELIGIBLE_ROUTE',
      message:
        'OpenRouter found no eligible route for this model and structured-output request. Check the model and your OpenRouter privacy and provider-routing settings.'
    };
  }
  if (status === 400 || status === 422) {
    return {
      code: 'AI_REQUEST_REJECTED',
      message: `The AI provider rejected the model or structured-output request (HTTP ${status}).`
    };
  }
  if (status === 404) {
    return {
      code: 'AI_MODEL_NOT_FOUND',
      message:
        'The AI provider could not find the configured model or endpoint.'
    };
  }
  if (status === 408 || status === 524) {
    return {
      code: 'AI_PROVIDER_TIMEOUT',
      message: 'The AI provider timed out during the connection test.'
    };
  }
  if (status === 413) {
    return {
      code: 'AI_REQUEST_TOO_LARGE',
      message:
        'The AI provider rejected the structured-output request as too large.'
    };
  }
  if (status >= 500) {
    return {
      code: 'AI_PROVIDER_UNAVAILABLE',
      message: 'The AI provider is temporarily unavailable. Try again later.'
    };
  }
  return {
    code: 'AI_CONNECTION_REJECTED',
    message: `The AI provider rejected the connection test (${status}).`
  };
}

function connectionStreamFailure(
  classification: AssistantResponseFailureClassification
): ConnectionProviderFailure {
  if (classification === 'provider_incomplete') {
    return {
      code: 'AI_RESPONSE_INCOMPLETE',
      message:
        'The AI provider reached its output limit before completing the structured connection reply. Increase Output budget or lower Reasoning level.'
    };
  }
  if (
    classification === 'invalid_contract' ||
    classification === 'invalid_json' ||
    classification === 'empty_output' ||
    classification === 'output_over_limit'
  ) {
    return {
      code: 'AI_RESPONSE_INVALID',
      message:
        'The AI provider returned a reply that did not satisfy the OpenZCAD structured-output contract.'
    };
  }
  if (classification === 'provider_failed') {
    return {
      code: 'AI_PROVIDER_FAILED',
      message: 'The AI provider failed while producing the connection reply.'
    };
  }
  return {
    code: 'AI_STREAM_INVALID',
    message:
      'The AI provider stream ended before the connection test completed.'
  };
}

function structuredReplyText(env: CloudflareEnv) {
  return {
    format: {
      type: 'json_schema',
      name: 'openzcad_reply',
      strict: true,
      schema: assistantReplySchemaFor(env)
    }
  };
}

export async function streamAssistantProposal(
  input: ProposalInput,
  env: CloudflareEnv,
  safetyIdentifier?: string,
  runtime?: AssistantRuntimeConfig
): Promise<Response> {
  const provider = runtime?.provider ?? providerFor(env);
  const model = runtime?.model ?? modelFor(env, provider);
  const requestId = crypto.randomUUID();
  const apiKey = runtime?.apiKey ?? apiKeyFor(env, provider);
  if (!apiKey) {
    return jsonError(
      'AI is not configured for this environment.',
      'AI_NOT_CONFIGURED',
      503,
      requestId
    );
  }

  let upstreamUrl: string | undefined;
  try {
    upstreamUrl = upstreamUrlForRuntime(env, runtime, provider);
  } catch (error) {
    return jsonError(
      error instanceof HttpAssistantConfigurationError
        ? error.message
        : 'The AI endpoint is invalid.',
      'AI_PROVIDER_NOT_CONFIGURED',
      503,
      requestId
    );
  }
  if (!upstreamUrl) {
    return jsonError(
      'AI_BASE_URL is required for a Responses-compatible provider.',
      'AI_PROVIDER_NOT_CONFIGURED',
      503,
      requestId
    );
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json'
  };
  if (provider === 'openrouter') {
    headers['X-Title'] = env.AI_APP_NAME ?? 'OpenZCAD';
    if (env.AI_SITE_URL) {
      headers['HTTP-Referer'] = env.AI_SITE_URL;
    }
  }

  const requestUpstream = () =>
    fetch(upstreamUrl, {
      method: 'POST',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(runtime?.timeoutMs ?? timeoutFor(env)),
      body: JSON.stringify({
        model,
        instructions: requestInstructions(
          env,
          runtime,
          (input.attachments?.length ?? 0) > 0
        ),
        input: assistantInput(input),
        ...reasoningRequest(
          runtime?.reasoningEffort ??
            env.AI_REASONING_EFFORT ??
            DEFAULT_AI_REASONING_EFFORT
        ),
        text: structuredReplyText(env),
        max_output_tokens: runtime?.maxOutputTokens ?? maxOutputTokensFor(env),
        store: false,
        stream: true,
        ...(provider === 'openrouter'
          ? { provider: { require_parameters: true } }
          : {}),
        ...(safetyIdentifier ? { safety_identifier: safetyIdentifier } : {})
      })
    });

  let upstream: Response;
  try {
    upstream = await requestUpstream();
  } catch (error) {
    const timedOut =
      error instanceof DOMException &&
      (error.name === 'TimeoutError' || error.name === 'AbortError');
    console.error('AI Responses provider request failed:', {
      requestId,
      provider,
      model,
      reason: timedOut ? 'timeout' : 'network'
    });
    return jsonError(
      timedOut
        ? 'The modeling assistant timed out before producing a patch.'
        : 'The modeling assistant could not reach its provider.',
      timedOut ? 'AI_UPSTREAM_TIMEOUT' : 'AI_UPSTREAM_UNAVAILABLE',
      timedOut ? 504 : 502,
      requestId
    );
  }

  if (!upstream.ok || !upstream.body) {
    const failure = await readProviderFailure(upstream);
    console.error('AI Responses provider failed:', {
      requestId,
      provider: safeDiagnosticLabel(provider),
      model: safeDiagnosticLabel(model),
      status: upstream.status,
      providerCode: failure.providerCode ?? null,
      providerRequestId: failure.providerRequestId ?? null
    });
    return jsonError(
      proposalProviderErrorMessage(upstream.status, Boolean(runtime), provider),
      'AI_UPSTREAM_ERROR',
      502,
      requestId
    );
  }

  return new Response(
    observeAssistantResponse(upstream.body, { requestId, provider, model }),
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-content-type-options': 'nosniff',
        'x-openzcad-request-id': requestId
      }
    }
  );
}

export async function testAssistantConnection(
  runtime: AssistantRuntimeConfig,
  env: CloudflareEnv
): Promise<{ ok: true; latencyMs: number; requestId: string }> {
  const requestId = crypto.randomUUID();
  const upstreamUrl = upstreamUrlForRuntime(env, runtime, runtime.provider);
  if (!upstreamUrl) {
    throw new HttpAssistantConfigurationError(
      'An AI endpoint is required for this provider.',
      { requestId }
    );
  }
  const startedAt = Date.now();
  const timeoutSignal = AbortSignal.timeout(runtime.timeoutMs);
  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${runtime.apiKey}`,
        'content-type': 'application/json',
        ...(runtime.provider === 'openrouter'
          ? {
              'X-Title': env.AI_APP_NAME ?? 'OpenZCAD',
              ...(env.AI_SITE_URL ? { 'HTTP-Referer': env.AI_SITE_URL } : {})
            }
          : {})
      },
      signal: timeoutSignal,
      body: JSON.stringify({
        model: runtime.model,
        instructions:
          'Return a short connection confirmation as an OpenZCAD message reply.',
        input: 'Test the configured OpenZCAD AI connection.',
        text: structuredReplyText(env),
        max_output_tokens: Math.min(runtime.maxOutputTokens, 4_096),
        store: false,
        stream: true,
        ...reasoningRequest(runtime.reasoningEffort),
        ...(runtime.provider === 'openrouter'
          ? { provider: { require_parameters: true } }
          : {})
      })
    });
  } catch {
    const timedOut = timeoutSignal.aborted;
    console.error('AI Responses connection request failed:', {
      requestId,
      provider: safeDiagnosticLabel(runtime.provider),
      model: safeDiagnosticLabel(runtime.model),
      reason: timedOut ? 'timeout' : 'network'
    });
    throw new HttpAssistantConfigurationError(
      timedOut
        ? 'The AI provider timed out during the connection test.'
        : 'The AI provider could not be reached.',
      {
        code: timedOut ? 'AI_PROVIDER_TIMEOUT' : 'AI_PROVIDER_UNREACHABLE',
        requestId
      }
    );
  }
  if (!response.ok) {
    const details = await readProviderFailure(response);
    const failure = connectionProviderFailure(
      response.status,
      runtime.provider
    );
    console.error('AI Responses connection test rejected:', {
      requestId,
      provider: safeDiagnosticLabel(runtime.provider),
      model: safeDiagnosticLabel(runtime.model),
      status: response.status,
      providerCode: details.providerCode ?? null,
      providerRequestId: details.providerRequestId ?? null
    });
    throw new HttpAssistantConfigurationError(failure.message, {
      code: failure.code,
      requestId,
      providerStatus: response.status,
      ...details
    });
  }
  if (!response.body) {
    throw new HttpAssistantConfigurationError(
      'The AI provider returned an empty connection response.',
      { code: 'AI_RESPONSE_INVALID', requestId }
    );
  }
  const validation = await validateAssistantResponse(response.body);
  if (!validation.ok) {
    const failure =
      validation.classification === 'connection_error' && timeoutSignal.aborted
        ? {
            code: 'AI_PROVIDER_TIMEOUT',
            message: 'The AI provider timed out during the connection test.'
          }
        : connectionStreamFailure(validation.classification);
    console.error('AI Responses connection stream failed:', {
      requestId,
      provider: safeDiagnosticLabel(runtime.provider),
      model: safeDiagnosticLabel(runtime.model),
      classification: validation.classification,
      upstreamResponseId: validation.upstreamResponseId ?? null
    });
    throw new HttpAssistantConfigurationError(failure.message, {
      code: failure.code,
      requestId,
      ...(validation.upstreamResponseId
        ? { providerRequestId: validation.upstreamResponseId }
        : {})
    });
  }
  return { ok: true, latencyMs: Date.now() - startedAt, requestId };
}

interface HttpAssistantConfigurationErrorOptions extends ProviderFailureDetails {
  code?: string;
  requestId?: string;
  providerStatus?: number;
}

export class HttpAssistantConfigurationError extends Error {
  readonly code: string;
  readonly requestId: string;
  readonly providerStatus?: number;
  readonly providerCode?: string;
  readonly providerRequestId?: string;

  constructor(
    message: string,
    options: HttpAssistantConfigurationErrorOptions = {}
  ) {
    super(message);
    this.name = 'HttpAssistantConfigurationError';
    this.code = options.code ?? 'AI_CONFIGURATION_INVALID';
    this.requestId = options.requestId ?? crypto.randomUUID();
    this.providerStatus = options.providerStatus;
    this.providerCode = options.providerCode;
    this.providerRequestId = options.providerRequestId;
  }
}
