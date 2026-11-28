/**
 * One plain sentence for a refusal, with the kernel's own words kept behind
 * it.
 *
 * The reference states a refusal as a single sentence naming the cause and
 * nothing else. Our adapter writes its own refusals that way, but a failure
 * raised inside the kernel arrives as the kernel's diagnostic — lowercase,
 * tagged, counted (`exact-only policy: the exact boolean pipeline could not
 * produce this result…`, `boolean result has degenerate topology (F=…`) — and
 * that used to be the headline. The translation is a fixed table, so every
 * sentence a person reads here was written by a person; the kernel text is
 * never discarded, it moves into the detail the card shows on request.
 */

import { ownEntry } from '@openzcad/shared';
import { blendSizesWithUnit, withoutFeatureLead } from './inPlace/sizeRefusal';
export interface PlainRefusal {
  message: string;
  headline?: string;
  detail?: string;
  /**
   * The kernel's own classification of the refusal, when the rebuild recorded
   * one. Copy may be reworded; this is the field a caller branches on.
   */
  category?: string;
  /**
   * The kernel's or adapter's refusal code (`reference_missing`, …), when the
   * rebuild typed one: the specific verdict `category` groups.
   */
  code?: string;
}

/** A face move the kernel refused because the swept face meets another. */
export const FACE_SWEEP_BLOCKED =
  'The face would run into another part of the body before it got that far.';

/**
 * The same refusal where the display mesh shows the swept path empty. The
 * kernel's sweep check compares bounding boxes, and the box of a curved or
 * freeform face (a thread most of all) reaches far past the face itself, so
 * it refuses moves with nothing in the way (a captured case cleared the
 * thread that "blocked" it by about 22 mm). Saying the face would hit
 * something sent people looking for a collision that is not there.
 */
export const FACE_SWEEP_UNPROVEN =
  "The geometry kernel couldn't prove this move is clear of nearby curved faces (such as a thread). Try a smaller step, or make the change before adding the thread.";

/**
 * What the display mesh says about a refused face move's path: empty, or
 * blocked, with a distance estimate when the mesh measured one.
 */
export type FaceSweepReading =
  { kind: 'clear' } | { kind: 'blocked'; estimate?: string };

/**
 * Rewords a {@link FACE_SWEEP_BLOCKED} refusal by what the display mesh
 * shows of the path; every other refusal, and an unread path, pass
 * through. A clear path takes {@link FACE_SWEEP_UNPROVEN} and drops any
 * limit, which would name an obstacle the mesh does not show; the kernel's
 * words stay in the detail. A blocked path keeps the sentence, and its
 * estimate leads the detail.
 */
export function withFaceSweepReading<
  T extends { message: string; detail?: string; limit?: number }
>(refusal: T, read?: () => FaceSweepReading | undefined): T {
  if (refusal.message !== FACE_SWEEP_BLOCKED || !read) return refusal;
  const reading = read();
  if (reading?.kind === 'clear') {
    const { limit: _limit, ...rest } = refusal;
    return { ...rest, message: FACE_SWEEP_UNPROVEN } as T;
  }
  if (reading?.estimate) {
    return {
      ...refusal,
      detail: [reading.estimate, refusal.detail].filter(Boolean).join('\n')
    };
  }
  return refusal;
}

/**
 * A STEP parser refusal needs an action as well as the broken entity number.
 * Keep this at the import boundary: a generic kernel failure must not tell a
 * person to re-export a file that was never part of the operation.
 */
export function stepImportRefusal(text: string): PlainRefusal {
  if (!/^parse error:/i.test(text.trimStart())) {
    return { message: text };
  }
  return {
    message:
      'This STEP file could not be read. Export a fresh STEP file from the source CAD project and try again.',
    detail: text.trim()
  };
}

/**
 * One sentence per kernel failure category.
 *
 * The category comes from `FeatureWarning.kernelRefusal`, which the adapter
 * fills from the kernel's typed results. Before it existed, every refusal
 * whose sentence the kernel wrote collapsed into one GENERIC line: a domain
 * the engine does not support, a budget that was exceeded and geometry
 * refused on quality were three different stories told identically. They are
 * three sentences now.
 *
 * Keyed by string rather than by a union imported from the adapter, on
 * purpose: the category crosses the boundary as a string precisely so a new
 * kernel category cannot break a build here, and an unrecognised one falls
 * back to GENERIC exactly as an uncategorised refusal does.
 */
const CATEGORY_SENTENCES: Readonly<Record<string, string>> = {
  unsupported:
    'The exact kernel does not support this combination of shapes yet.',
  resource_limit:
    "This operation went past the exact kernel's budget for this kind of work.",
  quality_refused:
    'The exact kernel could not build this exactly, and an approximate ' +
    'result was declined.',
  nonconvergence:
    'The exact kernel could not settle where these surfaces meet.',
  tolerance_violation:
    'This could not be built within the exact kernel’s tolerance.',
  invalid_input: 'The exact kernel rejected the input for this operation.',
  invalid_topology: 'The resulting body came back invalid.',
  cancelled: 'The operation was cancelled before it finished.',
  internal: 'The exact kernel failed internally on this operation.'
};

/**
 * The kernel's typed record of a refusal, as `FeatureWarning.kernelRefusal`
 * carries it. Only the fields the copy branches on.
 */
export interface RefusalClassification {
  category: string;
  code?: string;
  reason?: string;
  neighborSurfaceType?: string;
}

const FREEFORM_NEIGHBOR =
  "This face meets a fillet or freeform surface, which resizing and moving faces can't follow yet.";
const CURVED_NEIGHBOR =
  "This face meets a curved surface that resizing and moving faces can't follow yet. Change the size on the original shape in History instead.";
const PARTIAL_WALL =
  "This hole's wall doesn't end in full circles, which resizing can't follow yet. Change the size on the original shape in History instead.";
/**
 * A refused diameter, split by the kernel's cause. `wall_meets_face` — and a
 * kernel that predates the cause (esaueng/remus#1747) — is a size limit, so a
 * smaller diameter can help. `group_reblend_failed` says the fillets around
 * the wall did not re-fillet on the resized body, which may hold at every
 * diameter, so that advice would be false there.
 */
const DIAMETER_DOES_NOT_FIT =
  'That diameter does not fit the existing supports and fillets. Try a smaller diameter.';
/**
 * The adapter's `mirror_source_unavailable`: the body a Mirror reflects has
 * no shape where the Mirror sits in the history. Written to stand alone on a
 * feature card and to read on after a picked body's name ("Back block: …")
 * in a Mirror of several bodies. It says what may have happened, not which,
 * because the record does not say.
 */
export const MIRROR_SOURCE_UNAVAILABLE =
  "The body to mirror isn't built at this point in the history. It may be suppressed, or its feature may have failed.";
/**
 * The adapter's `target_body_unavailable`: the same absence for every other
 * feature that works on a body it does not make (Transform, Shell, Draft, a
 * fillet, a boolean's operand, …). "A body" rather than "the body", because
 * a boolean names several and the record does not say which; the adapter's
 * sentence, which names it, stays in the detail.
 */
export const TARGET_BODY_UNAVAILABLE =
  "A body this feature uses isn't built at this point in the history. It may be suppressed, or its feature may have failed.";
/**
 * An edit opened on a feature whose own rebuild refused for want of its
 * target body (`target_body_unavailable`), for a feature whose picks all lie
 * on that one body (a fillet's edges, a hole's face): there is nothing in the
 * viewport to pick, so the edit says why and how to recover instead of
 * asking for picks. `what` is the feature's kind in lower case ("chamfer").
 * Null for any other code: the edit opens as usual.
 */
export function editTargetMissingSentence(
  typed: Pick<RefusalClassification, 'code'>,
  what: string
): string | null {
  if (typed.code !== 'target_body_unavailable') return null;
  return `This ${what}'s body isn't built at this point in the history, so there is nothing to pick. Its feature may be suppressed or may have failed: fix or restore that feature in History, or delete this ${what}.`;
}
const FILLETS_NOT_REBUILT =
  "The fillets around this wall can't be rebuilt at that diameter. Change or remove those fillets in History, then resize the wall.";

/**
 * A refused fillet removal or resize (`resizeBlend`), by the kernel's code.
 * Codes without an entry keep the prose table (`radius-too-large`) or the
 * category sentence.
 */
const BLEND_RESIZE_SENTENCES: Readonly<Record<string, string>> = {
  'blend-cluster-reblend-failed':
    'The adjoining fillets could not be rebuilt at this radius. Try a smaller radius or edit the fillets in History.',
  'unsupported-support-pair':
    "This fillet joins faces that removing or resizing a fillet can't rebuild yet; that works for fillets between flat and cylindrical faces. Edit the fillet in History instead.",
  'band-touches-freeform':
    "This fillet touches a freeform surface, which removing or resizing a fillet can't follow yet. Edit the fillet in History instead.",
  'blend-band-not-analytic':
    "This fillet is not a constant-radius round, which removing or resizing a fillet can't rebuild yet. Edit the fillet in History instead."
};

/**
 * Split by plane (M11). A plane with no edge of the body across it has three
 * stories: it misses the body (or meets one corner), it lies flat on one of
 * the body's faces, or it runs along one edge. The kernel words the last two
 * alike, and words a plane through a curved body like the first. The adapter
 * records a cause on `kernelRefusal.reason` only where the target's exact
 * B-rep proves it (`exact-split-contact.ts`); without one the sentence names
 * no cause.
 *
 * A Split begun by picking the body's own face always opens on the face
 * story, at offset 0, so that sentence says to slide the plane into the body
 * rather than to move it off an edge. It names no sign: a picked face's
 * offset runs along its outward normal, a principal plane's along the axis.
 */
export const SPLIT_PLANE_MISSES =
  'The cutting plane does not pass through the body. Move the plane so it cuts through the body.';
export const SPLIT_PLANE_ON_FACE =
  'The cutting plane lies on a face of the body and only touches it. Slide the plane into the body.';
export const SPLIT_PLANE_ON_EDGE =
  'The cutting plane lies exactly along an existing edge. Move the plane slightly off the edge.';
/**
 * The kernel's "entirely on one side", where nothing proved a miss. On a
 * curved body the kernel says this of a tangent plane too, such as one
 * touching a sphere at its pole (K10), and the adapter proves no cause there:
 * the sentence must not claim a miss.
 */
const SPLIT_PLANE_NOT_CUT =
  'Split could not cut the body along this plane. Check that the plane passes through the body.';
/**
 * The kernel's "does not cross the interior", where nothing proved how the
 * plane meets the body. The refusal itself says the plane only touches the
 * body, but not where: along an edge, flat on a face, or at a single point.
 * The last is a tangent plane on a curved body, such as x = 13 on an R10 r3
 * torus about z, which meets it at one point on the outer rim; the kernel
 * reports the seam edge it finds there, and the adapter proves no cause
 * (K10). So the sentence names all three and no direction to move in.
 */
export const SPLIT_PLANE_TOUCHES =
  'The cutting plane only touches the body, along an edge or a face or at a single point, so there is nothing to cut. Move the plane so it passes through the body.';
/**
 * M11 (owner decision D2): why two picked edges give Split no plane, by the
 * pick's own code. The pick is refused before any rebuild, so no kernel
 * words are involved; the edges stay held so one can be picked again.
 */
export const SPLIT_EDGE_PLANE_SENTENCES: Readonly<
  Record<'collinear' | 'skew' | 'curved-edge', string>
> = {
  collinear:
    'The edges lie on one line, so they do not fix a plane. Pick a second edge off that line.',
  skew: "The edges don't lie in one plane. Pick two edges that meet or run side by side.",
  'curved-edge':
    'A plane through edges needs straight edges, and this edge is curved. Pick a straight edge.'
};
/**
 * The kernel's "crosses face N, whose surface is not planar": the section
 * across that one curved face could not be built at this plane.
 */
export const SPLIT_CURVED_SECTION =
  "Split couldn't build the cut across a curved face at this plane. Move the plane a little, or split the body somewhere else.";
/**
 * A body with a sealed internal cavity: a void closed on every side, such as
 * a pocket cut strictly inside the stock (issues #2383–#2386). The adapter
 * records `sealed_cavity` on `kernelRefusal.reason` only where that is
 * established: the kernel names the body's cavity shells, or a refused
 * boolean builds once the cavity is ignored.
 *
 * Split, Draft, Shell and the edge blends refuse every such body before they
 * look at the plane, angle or faces, so the sentences they used to get
 * ("try a smaller angle or fewer faces", "does not support this combination
 * of shapes") sent people to change inputs that play no part. Each sentence
 * names the cavity. Split and Draft also name the order that builds, which
 * the regression suite runs on the issues' fixtures
 * (`test/sealed-cavity-operations.test.ts`). The boolean sentence offers no
 * move: where the cavity is the operation's own cut there is none to offer.
 */
export const SPLIT_SEALED_CAVITY =
  "This body has a sealed internal cavity, and Split can't cut a body with an enclosed void yet. Split the body first, then cut the cavity.";
export const DRAFT_SEALED_CAVITY =
  "This body has a sealed internal cavity, and Draft can't work on a body with an enclosed void yet. Apply the draft first, then cut the cavity.";
export const SEALED_CAVITY_UNSUPPORTED =
  "This body has a sealed internal cavity, which this operation can't work on yet.";
export const BOOLEAN_SEALED_CAVITY =
  "A body in this operation has a sealed internal cavity, and the exact kernel can't carry it through yet. The same operation builds without the cavity.";
const SEALED_CAVITY_SENTENCES: Readonly<Record<string, string>> = {
  split_refused: SPLIT_SEALED_CAVITY,
  draft_refused: DRAFT_SEALED_CAVITY,
  exact_only_unattainable: BOOLEAN_SEALED_CAVITY
};
const SPLIT_SENTENCES: Readonly<Record<string, string>> = {
  plane_misses_body: SPLIT_PLANE_MISSES,
  plane_on_face: SPLIT_PLANE_ON_FACE,
  plane_on_edge: SPLIT_PLANE_ON_EDGE
};

/**
 * The sentence for a refused face move the kernel typed, read from its code
 * and cause rather than its prose. Null when the record does not name a cause
 * this table has a sentence for; the prose table below then still applies,
 * because untyped paths (move-faces, previews) reach the same sentences.
 */
function typedSentence(typed: RefusalClassification): string | null {
  if (typed.reason === 'sealed_cavity') {
    return (
      ownEntry(SEALED_CAVITY_SENTENCES, typed.code) ?? SEALED_CAVITY_UNSUPPORTED
    );
  }
  if (typed.code === 'split_refused') {
    return ownEntry(SPLIT_SENTENCES, typed.reason) ?? null;
  }
  const blendResize = typed.code ? BLEND_RESIZE_SENTENCES[typed.code] : null;
  if (blendResize) {
    return blendResize;
  }
  if (typed.code === 'mirror_source_unavailable') {
    return MIRROR_SOURCE_UNAVAILABLE;
  }
  if (typed.code === 'target_body_unavailable') {
    return TARGET_BODY_UNAVAILABLE;
  }
  if (typed.code === 'cylinder-diameter-unbuildable') {
    return typed.reason === 'group_reblend_failed'
      ? FILLETS_NOT_REBUILT
      : DIAMETER_DOES_NOT_FIT;
  }
  if (
    typed.category === 'quality_refused' &&
    typed.code === 'exact_only_unattainable'
  ) {
    return typed.reason === 'approximate_reblend_not_permitted'
      ? 'Resizing this face would require an approximate fillet. This edit only allows exact geometry.'
      : CATEGORY_SENTENCES.quality_refused!;
  }
  if (typed.code !== 'unsupported_move_face') {
    return null;
  }
  switch (typed.reason) {
    case 'unsupported_neighbor':
      switch (typed.neighborSurfaceType) {
        case 'nurbs':
        case 'bspline':
          return FREEFORM_NEIGHBOR;
        case 'sphere':
        case 'torus':
        case 'cone':
          return CURVED_NEIGHBOR;
        default:
          return null;
      }
    case 'partial_reversed_wall':
      return PARTIAL_WALL;
    default:
      return null;
  }
}

/**
 * One table row. A sentence that names a number the kernel stated is written
 * as a function of the match; the words are still ours, only the number is
 * the kernel's.
 */
interface Translation {
  pattern: RegExp;
  sentence: string | ((match: RegExpExecArray) => string);
}

function sentenceOf(translation: Translation, text: string): string {
  if (typeof translation.sentence === 'string') return translation.sentence;
  const match = translation.pattern.exec(text);
  return match ? translation.sentence(match) : GENERIC;
}

const TRANSLATIONS: readonly Translation[] = [
  {
    pattern: /unsupported STEP entity:/i,
    sentence:
      'This STEP file uses a geometry type the importer does not support yet.'
  },
  {
    pattern: /through-hole diameter .* does not fit/i,
    sentence: 'The hole does not fit this body.'
  },
  {
    pattern: /removing the selected face failed/i,
    sentence: 'The selected face could not be removed.'
  },
  {
    pattern: /could not be sewn into a shell/i,
    sentence: 'This mesh could not be made into a solid.'
  },
  {
    // Issue #1630. The kernel rims an opening with flat faces, one per
    // opened plane. A fillet tangent to an opened face leaves the inner
    // wall's edge below that plane, and two adjacent opened faces leave one
    // loop spanning both planes; neither depends on the wall thickness, so
    // the operation fallback ("try a thinner wall") sends the user the
    // wrong way. The sentence names both causes: the message alone does
    // not say which one it was.
    pattern:
      /free loop of the shelled body lies in none of the opened faces' planes/i,
    sentence:
      'Shell cannot close this opening yet: the wall it exposes has no flat rim. That happens when two open faces share an edge, or a fillet or other rounded face blends into an open face. A thinner wall will not help. Open faces that do not touch, or suppress the fillet.'
  },
  {
    pattern:
      /\[object WebAssembly\.Exception\]|RuntimeError|unreachable|panicked|memory access out of bounds|out of memory/i,
    sentence: 'The exact kernel crashed on this operation.'
  },
  {
    pattern: /exact-only policy|approximate fallback/i,
    sentence: 'The exact kernel could not build this result.'
  },
  {
    pattern: /conical cap reaches or crosses its support apex/i,
    sentence:
      'The conical end would collapse at that distance. Try a smaller offset.'
  },
  {
    pattern: /radial resize intersects nonincident meridian boundaries/i,
    sentence: 'That diameter would make parts of the body overlap.'
  },
  {
    pattern:
      /radial resize (?:reverses a meridian segment|collapses a (?:meridian segment|torus ring))/i,
    sentence:
      'That diameter would collapse a wall or blend. Try a smaller change.'
  },
  {
    // A resized or moved face is re-limited against its boundary neighbours,
    // and the kernel can only do that against planes, cylinders and axial
    // cones. A boss that grows out of a sphere meets the sphere; once the
    // seam is filleted it meets the blend band, which is a NURBS surface.
    // Editing the source feature rebuilds the boolean instead, which does
    // handle the sphere, so the sphere case names that route. A blend
    // neighbour gets no route: replaying the history currently breaks the
    // fillet's edge selection (docs/plans/kernel-robustness-plan-2026-11-05.md).
    pattern:
      /move-face does not support face [^:]*\((?:nurbs|bspline)\): face is adjacent/i,
    sentence: FREEFORM_NEIGHBOR
  },
  {
    pattern:
      /move-face does not support face [^:]*\((?:sphere|torus|cone)\): face is adjacent/i,
    sentence: CURVED_NEIGHBOR
  },
  {
    // A hole wall that does not run between two whole circles — a blind bore
    // ending on a sphere — is a partial cylinder, and the kernel resizes a
    // partial wall only on the outside of a boss with planar sides. Editing
    // the tool's source size rebuilds the cut and works.
    pattern: /partial-cylinder resize currently requires/i,
    sentence: PARTIAL_WALL
  },
  {
    // A local face move sweeps the face and lets only its edge neighbours
    // stretch; anything else in the path refuses the move.
    pattern:
      /swept face reaches nonadjacent face|sweep may contact a nonadjacent|crosses a nonadjacent source boundary/i,
    sentence: FACE_SWEEP_BLOCKED
  },
  {
    // The kernel's own words for a body with a sealed internal cavity
    // ("draft: unsupported configuration: solid has 1 cavity shell(s); draft
    // only operates on the outer shell"), for the paths that reach here
    // untyped. Ahead of the operation fallbacks, which advise a smaller
    // angle or a thinner wall: neither can help a body refused for its void.
    pattern: /solid has \d+ cavity shell\(s\); split only operates/i,
    sentence: SPLIT_SEALED_CAVITY
  },
  {
    pattern: /solid has \d+ cavity shell\(s\); draft only operates/i,
    sentence: DRAFT_SEALED_CAVITY
  },
  {
    pattern: /solid has \d+ cavity shell\(s\)/i,
    sentence: SEALED_CAVITY_UNSUPPORTED
  },
  {
    // Draft, chamfer and split all re-trim the faces around the one they
    // change, and the kernel can only re-trim a flat neighbour: a fillet or
    // cone beside the face refuses (QA 2026-11-14 finding #3, "the draft
    // moves a corner of curved face 139; re-trimming a curved neighbour
    // against the taper is not implemented").
    pattern:
      /re-trimming a curved (?:boundary|neighbour)|carries a curved edge; re-trimming/i,
    sentence:
      "A face next to this one is curved, and re-trimming a curved face to fit isn't supported yet. Try faces that only meet flat faces."
  },
  {
    // Split by plane (QA 2026-11-14 finding #4): four kernel refusals, each
    // naming a face, edge or wire by internal id.
    pattern: /cutting plane crosses curved edge/i,
    sentence:
      "The cutting plane crosses a curved edge, which splitting can't trim yet. Move the plane so it misses fillets and curved edges."
  },
  {
    pattern: /cutting plane crosses inner wire/i,
    sentence:
      "The cutting plane runs through a hole in a face, which splitting can't handle yet. Move the plane clear of holes and openings."
  },
  {
    // Since Remus 2026.1.173 (remus#2023) Split sections sphere and torus
    // faces, so curved faces can be cut; the kernel says this only when it
    // could not build the section across one particular face. The sentence
    // must not say curved faces cannot be cut.
    pattern: /cutting plane crosses face .*not planar/i,
    sentence: SPLIT_CURVED_SECTION
  },
  {
    // A plane through the body that contains one of its edges: "the cutting
    // plane contains edge 36 of the solid; splitting along an existing edge
    // has no unambiguous answer".
    pattern: /cutting plane contains edge/i,
    sentence: SPLIT_PLANE_ON_EDGE
  },
  {
    // A plane that only touches the body (Remus 3c489d7): "the cutting
    // plane does not cross the solid's interior; it only touches the body
    // and contains edge 3 of the solid, so there is nothing to split". The
    // same words for a plane along a lone edge and one flat on a face, so
    // untyped, the sentence names neither; a typed refusal says which
    // (`SPLIT_SENTENCES`).
    pattern: /cutting plane does not cross the solid's interior/i,
    sentence: SPLIT_PLANE_TOUCHES
  },
  {
    // "invalid input: cutting plane does not split the solid (entirely on
    // one side)". A miss, a corner touch, or a curved body the kernel judged
    // by its edges alone: untyped, the sentence names none of them.
    pattern: /cutting plane does not split the solid/i,
    sentence: SPLIT_PLANE_NOT_CUT
  },
  {
    // A face move beside a fillet: the kernel can carry the blend along only
    // where every face around it is flat and meets its neighbours sharply.
    pattern: /prismatic sharp support neighbou?rhood/i,
    sentence:
      'This face meets a fillet, and a face next to a fillet can only move when the faces around it are flat with sharp edges. Change the size on the original shape in History instead.'
  },
  {
    // `${code}: ${message}` from a refused blend resize.
    pattern: /\bradius-too-large\b/i,
    sentence:
      'That radius is too large for the faces this blend joins. Try a smaller radius.'
  },
  // M04 exact sweeps (`sweepExact`): each refusal names its cause; nothing
  // is sampled in their place.
  {
    pattern:
      /sweep path turns a corner of ([\d.]+)° at joint \d+, next to an arc/i,
    sentence: (match) =>
      `The sweep path has a ${Math.round(Number(match[1]) * 10) / 10}° corner next to an arc. A mitre is cut only between straight lines: set Corners to Round, or join the arc tangentially.`
  },
  // M04 (v136) profile position.
  {
    pattern: /has no path intersection to start from/i,
    sentence:
      'The sweep path does not cross the profile’s plane. Set the profile position to Closest point or Closest end.'
  },
  {
    pattern: /sweep profile stands on the path's corner/i,
    sentence:
      'The profile stands on a mitred corner of the path, which would cut it. Move the profile off the corner, or round the corners.'
  },
  {
    pattern:
      /a profile position applies to (?:a sweep that turns|an open sweep path)/i,
    sentence:
      'A profile position applies to an open path on a sweep that turns with it, with no twist, scale, guide rail or parallel orientation.'
  },
  // M04 (v135) round corners.
  {
    pattern: /no round corner of radius ([\d.e+-]+) fits at joint/i,
    sentence: (match) =>
      `A round corner of radius ${Number(match[1])} does not fit the curves beside it. Use a smaller corner radius.`
  },
  {
    pattern: /too short for its round corners of radius ([\d.e+-]+)/i,
    sentence: (match) =>
      `A piece of the sweep path is too short for round corners of radius ${Number(match[1])}. Use a smaller corner radius, or lengthen it.`
  },
  {
    pattern: /out of the plane of the arc beside it/i,
    sentence:
      'A round corner next to an arc must lie in the arc’s plane, and this corner turns out of it.'
  },
  {
    pattern:
      /round corner of radius [\d.e+-]+ at joint \d+ is (?:too small to resolve|larger than the arc)/i,
    sentence:
      'That corner radius does not fit here: it is too small to resolve, or larger than the arc beside the corner.'
  },
  {
    pattern: /a round corner applies to a sweep that turns with its path/i,
    sentence:
      'Round corners apply to a sweep that turns with its path, with no twist, scale, guide rail or parallel orientation.'
  },
  {
    pattern: /sweep path turns back on itself/i,
    sentence:
      'The sweep path turns back on itself: neither a mitre nor a round corner can follow a corner that sharp.'
  },
  {
    pattern: /too short for its mitred corners/i,
    sentence:
      'A straight run of the sweep path is too short for its mitred corners: lengthen it or use a smaller profile.'
  },
  {
    pattern: /exact sweep paths are lines and circular arcs/i,
    sentence:
      'A sweep that turns with its path follows only lines and arcs exactly. To sweep along a spline, set Orientation to Parallel, which keeps the profile parallel to itself.'
  },
  // M04 (v134) parallel orientation: the path must run steadily away from
  // the profile's plane, or the swept body could meet itself.
  {
    pattern:
      /cannot be shown to run steadily through the profile's plane|turns back through the profile's plane: a sweep that keeps/i,
    sentence:
      'A sweep that keeps the profile parallel needs a path that keeps moving away from the profile: this one turns back or runs along the profile’s plane. Change the path, or set Orientation to Normal to path.'
  },
  {
    pattern: /closed sweep path cannot keep the profile's orientation/i,
    sentence:
      'A sweep that keeps the profile parallel cannot follow a closed path: the profile would come back through itself.'
  },
  {
    pattern: /spline that does not end on its control points/i,
    sentence:
      'This spline in the sweep path cannot be swept exactly; redraw it, or split it into pieces.'
  },
  {
    pattern:
      /exact sweep path (?:edges do not form one connected chain|branches)/i,
    sentence:
      'The sweep path must be one connected chain of curves, end to end.'
  },
  {
    pattern: /sweep profile reaches the axis of path arc/i,
    sentence:
      'The profile is too big for a bend in the sweep path: it would reach past the bend’s centre. Use a larger bend radius or a smaller profile.'
  },
  {
    pattern: /does not cross the sweep profile's plane transversally/i,
    sentence:
      'The sweep would fold through itself: the path runs along the profile, or the profile is too big for a bend and reaches past the bend’s centre. Draw the profile across the path, or use a larger bend radius or a smaller profile.'
  },
  {
    pattern: /the swept body could meet itself/i,
    sentence:
      'The sweep would run into itself: two parts of the path pass closer than the profile is wide.'
  },
  {
    pattern: /closed sweep path does not bring the profile back/i,
    sentence:
      'The closed sweep path does not bring the profile back to where it started.'
  },
  // M04 (v133) loft connections and guides.
  {
    pattern: /loft connection point .* is not a vertex of section (\d+)/i,
    sentence: (match) =>
      `The loft guide or connection does not meet section ${Number(match[1]) + 1} at a corner. A connection must be a vertex of every section.`
  },
  {
    pattern: /loft connections cannot be combined with an apex point/i,
    sentence: 'A loft with an apex point takes no connections or guide.'
  },
  // M04 (v132) exact sweep twist and scale (`sweepExactWithOptions`): built
  // along a straight path with the profile square to it, refused by name
  // otherwise and never sampled.
  {
    pattern:
      /can (?:twist|scale|twist and scale) the profile only along a straight path; path segment \d+ is an arc/i,
    sentence:
      'Twist and end scale need a straight sweep path, and this one has an arc. Sweep along a straight line, or set the twist to 0 and the end scale to 1.'
  },
  {
    pattern:
      /can (?:twist|scale|twist and scale) the profile only along a straight path; the path turns a corner/i,
    sentence:
      'Twist and end scale need a straight sweep path, and this one turns a corner. Sweep along a straight line, or set the twist to 0 and the end scale to 1.'
  },
  {
    pattern:
      /can (?:twist|scale|twist and scale) the profile only along an open straight path/i,
    sentence:
      'Twist and end scale need an open, straight sweep path, and this one closes on itself.'
  },
  {
    pattern:
      /can (?:twist|scale|twist and scale) the profile only when the profile is square to the path; this one is tilted ([\d.]+)°/i,
    sentence: (match) =>
      `Twist and end scale need the profile square to the path, and it is tilted ${Math.round(Number(match[1]) * 10) / 10}°. Draw the profile square to the path.`
  },
  {
    pattern:
      /(?:scaled|twisted) extrusion cannot sweep (?:a closed edge off the axis|a top edge unlike its profile edge)/i,
    sentence:
      'Twist and end scale can carry a full circle only when it is centred on the path. Centre it on the path, or draw it as two arcs.'
  },
  {
    pattern: /end scale must be between ([\d.e+-]+) and ([\d.e+-]+)/i,
    sentence: (match) =>
      `The end scale must be between ${Number(match[1])} and ${Number(match[2])}.`
  },
  {
    pattern:
      /can (?:twist|scale|twist and scale) the profile only when each closed curve in it is a circle/i,
    sentence:
      'Twist and end scale can carry a closed curve in the profile only when it is a circle. Split the curve into pieces, or use a circle.'
  },
  {
    pattern: /(?:scaled|twisted) extrusion cannot sweep a trimmed spline edge/i,
    sentence:
      'Twist and end scale cannot carry a trimmed spline in the profile yet.'
  },
  {
    pattern:
      /(?:scaled|twisted) extrusion cannot sweep an ellipse or open conic edge/i,
    sentence:
      'Twist and end scale cannot carry an ellipse or conic in the profile yet.'
  },
  {
    pattern:
      /(?:scaled|twisted) extrusion does not support nested inner wires/i,
    sentence:
      'Twist and end scale cannot carry a profile with an island inside a hole yet.'
  },
  {
    pattern: /self-intersect/i,
    sentence: 'The resulting body would intersect itself.'
  },
  {
    pattern:
      /non-manifold|degenerate topology|boolean result has|empty result|produced no (?:output |offset )?(?:faces|vertices|solids)|would leave only|would empty|no faces could be assembled/i,
    sentence: "The resulting body wouldn't be valid."
  },
  {
    // A face move re-limits its neighbours; pushed past the length of a
    // neighbour's flat, that flat would vanish (`collapse`) or turn inside
    // out (`reverse`), which changes the body's topology. The kernel names
    // the extent it ran against, and that is how far the face can go; it is
    // stated signed like the move, as the adapter's typed refusal states it
    // (the workspace adds the unit: `offsetLimitInUnits`).
    pattern:
      /move-face would change topology.*?would (?:collapse|reverse): a move of (-?)[\d.]+(?:e-?\d+)? against a fixed-to-moving extent of (\d+(?:\.\d+)?(?:e-?\d+)?)/i,
    sentence: (match) => {
      const extent = Math.round(Number(match[2]) * 100) / 100;
      return `A neighbouring face would shrink to nothing past ${
        match[1] && extent !== 0 ? -extent : extent
      }. Try a smaller offset.`;
    }
  },
  {
    pattern:
      /does not fit on the recovered sharp feature|chamfer setback does not fit|blend band touches a freeform|fillet contact map|fillet reconstruction|fillet stitch/i,
    sentence: 'The blend does not fit here. Try a smaller size.'
  },
  {
    pattern: /radius must be positive/i,
    sentence: 'The radius must be greater than zero.'
  },
  {
    pattern: /degenerate/i,
    sentence: 'The geometry collapses to nothing at this value.'
  },
  {
    pattern:
      /intersection failed|face splitting failed|failed to build|failed to (?:add|create|encode)|face has (?:no|empty)|face wire has no edges/i,
    sentence: 'The exact kernel could not build the result surfaces.'
  },
  {
    pattern: /names (?:face|vertex) handle|not among this solid/i,
    sentence: 'The kernel returned inconsistent topology for this body.'
  },
  {
    pattern: /exact geometry failed|unknown kernel error|the kernel rejected/i,
    sentence: 'The exact kernel could not build this feature.'
  }
];

/** The fallback sentence when nothing more specific is known. */
export const GENERIC_REFUSAL = 'The exact kernel could not build this result.';
const GENERIC = GENERIC_REFUSAL;

/**
 * A sentence the kernel wrote rather than the adapter: it opens lowercase or
 * carries an identifier, a tag, or a count in the kernel's own notation.
 */
function looksLikeKernelText(sentence: string): boolean {
  return (
    /^[a-z]/.test(sentence) ||
    REMUS_PREFIX.test(sentence) ||
    hasKernelNotation(sentence)
  );
}

/**
 * Identifiers and codes only the kernel writes, wherever they sit in a
 * sentence: a Rust `Some(Id(409))`, a snake_case code such as
 * `exact_only_unattainable`, a kebab-case code leading a clause
 * (`radius-too-large:`), or an entity named by its internal number
 * (`corner 139`, `vertex 2685`). Kept case-sensitive for the entity names, so
 * a face label the product shows ("Face 18") is not mistaken for one. QA
 * 2026-11-14 finding #18 found each of these in a refusal's headline.
 *
 * `solid N` is not on the list: the STEP importer numbers a file's solids
 * that way on purpose ("STEP file contains no closed solids: solid 1 (5
 * faces): it is an open shell…"), so the user can find the bad one in the
 * file, and treating it as kernel text replaced that sentence with "The
 * exact kernel could not build this result."
 */
function hasKernelNotation(sentence: string): boolean {
  // A name the user gave a body or feature is quoted, and is theirs to spell
  // with underscores or numbers.
  const unquoted = sentence.replace(/"[^"]*"|“[^”]*”/g, '""');
  return (
    /::|\bwasm\b|\[object |\(F=|\bhandle \d|_[a-z]+:/i.test(unquoted) ||
    /\bSome\(|\b(?:face|edge) None\b|\bId\(\d|\b[a-z]+(?:_[a-z]+)+\b|\b[a-z]+(?:-[a-z]+)+: |\b(?:face|edge|vertex|wire|corner|loop|shell) \d+\b/.test(
      unquoted
    )
  );
}

/**
 * `Remus <operation> refused: <kernel text>` — the adapter's wrapper around a
 * modeling operation the kernel threw on (draft, shell, solid offset,
 * thicken, mirror). The capitalised prefix used to make the whole line read
 * as a product sentence, so the kernel's words became the headline.
 */
const REMUS_PREFIX = /^Remus ([a-z][a-z -]*?) (?:refused|rejected):\s*/;

/**
 * What to say for a wrapped operation when its kernel text has no table
 * entry: the operation, and the one thing worth trying. Solid offset names
 * its documented subset (docs/capability-matrix.md: "sharp positive-outward
 * solid offset"); QA 2026-11-14 finding #12 met it as "assembly failed: wire
 * loop walk: no unvisited edge from vertex 2685".
 */
const OPERATION_FALLBACKS: Readonly<Record<string, string>> = {
  draft:
    'The draft could not be built on these faces. Try a smaller angle or fewer faces.',
  shell:
    'The shell could not be built with this wall thickness. Try a thinner wall or different open faces.',
  'solid offset':
    'Solid offset could not rebuild this body. It currently works on bodies with flat faces and sharp edges; fillets, shells and curved faces are not supported yet.',
  thicken:
    'This face could not be thickened by that amount. Try a smaller thickness.',
  mirror: 'The mirror could not be built from this body.'
};

/**
 * Splits `<sentence>\n<detail>` and translates the sentence when the kernel
 * wrote it.
 */
export function plainRefusal(
  text: string,
  classification?: string | RefusalClassification
): PlainRefusal {
  const typed = typeof classification === 'object' ? classification : undefined;
  const category =
    typeof classification === 'string' ? classification : typed?.category;
  const separator = text.indexOf('\n');
  const sentence = (separator < 0 ? text : text.slice(0, separator)).trim();
  const tail = separator < 0 ? '' : text.slice(separator + 1).trim();
  const classified = {
    ...(category ? { category } : {}),
    ...(typed?.code ? { code: typed.code } : {})
  };
  // A typed code is read first: it is the branchable field, and the text
  // rules below match the whole sentence, which can include a name the user
  // gave a feature (a Mirror called "Body no longer exists" lost its
  // typed sentence to the lost-selection rule).
  const byCode = typed ? typedSentence(typed) : null;
  if (byCode) {
    const detail = [sentence, tail].filter(Boolean).join('\n');
    return {
      message: byCode,
      detail,
      ...classified,
      ...(typed?.code === 'cylinder-diameter-unbuildable'
        ? { headline: byCode }
        : {})
    };
  }
  // A lost selection is read by the card to know that no value can help; a
  // parse error names the entity of the file that is broken. Both stay. So
  // do the STEP importer's own sentences, which name each solid it dropped
  // and why: "it is non-manifold" there is the importer's diagnosis, not the
  // kernel's, and a partial import that succeeded read as "The resulting
  // body wouldn't be valid." The importer does not escape quotes in a body
  // name, so the name is matched up to the last `" imported, but`. A face
  // set offset's later step names its face by its place in the set
  // ("Offsetting face 2 after the others…"), which reads as a kernel entity
  // number but is the adapter's own sentence.
  if (
    /no longer exists|^parse error:|^STEP file contains no |^Body ".*" imported, but |^Offsetting face \d+ after the others /.test(
      sentence
    )
  ) {
    return tail
      ? { message: sentence, detail: tail, ...classified }
      : { message: sentence, ...classified };
  }
  const translation = TRANSLATIONS.find(({ pattern }) =>
    pattern.test(sentence)
  );
  const wrapped = REMUS_PREFIX.exec(sentence);
  const byOperation = wrapped
    ? ownEntry(OPERATION_FALLBACKS, wrapped[1]!)
    : undefined;
  const byCategory =
    byOperation ??
    (category ? ownEntry(CATEGORY_SENTENCES, category) : undefined);
  // A table entry names a SYMPTOM and is more specific than any category, so
  // it wins — except where its sentence IS the generic fallback, which says
  // no more than "it did not work". The category says more than that and
  // takes its place. Everything else the kernel wrote used to collapse into
  // that one line; a category now replaces the fallback there too.
  const translated = translation ? sentenceOf(translation, sentence) : null;
  const tabled =
    translated !== null && translated !== GENERIC ? translated : undefined;
  const plain =
    tabled ??
    (translation || looksLikeKernelText(sentence)
      ? (byCategory ?? GENERIC)
      : null);
  if (plain === null) {
    return tail
      ? { message: sentence, detail: tail, ...classified }
      : { message: sentence, ...classified };
  }
  const detail = [sentence, tail].filter(Boolean).join('\n');
  return { message: plain, detail, ...classified };
}

/**
 * {@link plainRefusal}'s sentence as the command bar shows it: without a
 * leading feature name, and with the document's length unit after every
 * size a fillet or chamfer refusal quotes ("with distance 0.5 mm. Try a
 * smaller distance: distance 0.095 mm builds here."). History's failing-step
 * card and the Resume dialog read a refusal through this too, so a size
 * never reaches them without its unit. `unit` is the display name
 * (`displayLengthName`), or null to leave sizes bare.
 *
 * Units go only into the adapter's own text: a `Feature "<name>": ` lead is
 * trusted only when it is removed as `featureName`, exactly. Without the
 * name, a lead's text is shown with its sizes bare, since a name can hold
 * `": ` and words that read like the refusal.
 */
export function plainRefusalSentence(
  text: string,
  classification: string | RefusalClassification | undefined,
  unit: string | null,
  featureName?: string | null
): string {
  const lead = withoutFeatureLead(text, featureName);
  const { message } = plainRefusal(lead.text, classification);
  return unit && lead.adapterText ? blendSizesWithUnit(message, unit) : message;
}
