/**
 * The pin list: every direct-edit fixture the product currently refuses.
 *
 * This is the checklist the direct-edit reliability lanes are measured
 * against, so every entry states three things and nothing vaguer:
 *
 *   1. WHICH fixture,
 *   2. WHAT the user is told, as a LITERAL substring of the observed refusal,
 *   3. WHICH roadmap item owns closing it.
 *
 * Pins are asserted in BOTH directions, exactly like the parity corpus:
 *
 *   - an unpinned refusal fails the corpus, so a new failure class cannot
 *     appear quietly;
 *   - a pinned fixture that now COMMITS also fails, so a pin cannot outlive
 *     the defect it describes. Retire it and rerecord.
 *
 * A pin is not a suppression. There is no "known broken" label here: a pin
 * that does not quote the message is worse than no pin, because it converts a
 * measurement into a shrug. Nothing is ever pinned to make a run green — a
 * refused authored scenario is DATA, and the pin is where it is written down.
 *
 * ---------------------------------------------------------------------------
 * This list was EMPTY as of the first recording, and that was a measurement
 * ---------------------------------------------------------------------------
 *
 * All seven authored scenarios COMMIT against the pinned Remus build,
 * including the one the corpus was written to catch: a cylinder cap offset by
 * -5 is exact in both signs. The refusal channel is live rather than dead —
 * the same replay path reports `empty result: Cut of identical solids` for a
 * -24 offset through a 24 mm plate — so an empty list here means no refusal
 * class reproduces, not that nothing is being watched.
 *
 * Committing is not the same as being right. Three of those seven committed
 * the WRONG solid and were pinned in SHAPE_PINS below; B1 retired all three
 * (see that list's note). The first entry in this list is expected to arrive
 * with the first capture dropped into `fixtures/`.
 */

export interface RefusalPin {
  fixture: string;
  /** Literal substring of the observed refusal. */
  message: string;
  /** Roadmap item that owns closing it. */
  owner: string;
}

/**
 * The `plate-opposed-caps-offset-faces-*` pins are a designed refusal,
 * not a defect: a plate's top and bottom face opposite ways, and one signed
 * offset cannot move both. They are pinned so a face set's capture is proven
 * to replay as the whole set (M07). Replayed as its first face alone, the
 * same capture would commit and fail its pin.
 */
const OPPOSED_CAPS_REFUSAL =
  'The selected faces face opposite ways, so one offset would thicken one and thin the other.';

export const REFUSAL_PINS: RefusalPin[] = [
  {
    fixture: 'plate-opposed-caps-offset-faces-refused',
    message: OPPOSED_CAPS_REFUSAL,
    owner: 'M07 (designed refusal)'
  },
  {
    fixture: 'plate-opposed-caps-offset-faces-reproduction',
    message: OPPOSED_CAPS_REFUSAL,
    owner: 'M07 (designed refusal)'
  },
  {
    fixture: 'plate-opposed-caps-offset-faces-expression-reproduction',
    message: OPPOSED_CAPS_REFUSAL,
    owner: 'M07 (designed refusal)'
  }
];

/**
 * The shape list: every fixture the product COMMITS while producing the wrong
 * solid.
 *
 * A refusal is loud. This class is not: the edit lands, the history row
 * appears, and the part is quietly not the one the gesture asked for. The
 * oracle catches it by rebuilding the same part from its feature history with
 * the driving dimension moved by the offset — two independent routes to one
 * shape — and pinning the delta between them.
 *
 * Both directions, exactly like the refusal list:
 *
 *   - an unpinned disagreement fails the corpus;
 *   - a pinned fixture whose observed delta now MATCHES the oracle also fails.
 *     That is the repair, and the pin is what has to go.
 *
 * The pinned run is asserted against `observedVolumeDelta`, so a kernel that
 * changes its wrong answer to a different wrong answer fails too rather than
 * sliding under the pin.
 */
export interface ShapePin {
  fixture: string;
  /** Measured volume delta the kernel currently produces. */
  observedVolumeDelta: number;
  /** Delta the oracle expects. */
  expectedVolumeDelta: number;
  owner: string;
}

/**
 * ---------------------------------------------------------------------------
 * This list is EMPTY because its three entries were REPAIRED, not deleted
 * ---------------------------------------------------------------------------
 *
 * The first recording (2026-09-01) carried three shape pins, all one defect
 * measured three ways: an offset on a face bordered by blends added or removed
 * a PRISM over that face's own outline (37 x 7 = 259 mm2) instead of moving the
 * side and re-blending, leaving the blend rim standing as a ledge around a
 * boss or a pocket. The deltas were 259 x offset to the last digit on two of
 * the three (1294.9973 / 1295 / -777 against oracles of 1990.3054 / 1977.5 /
 * -1194.1315).
 *
 * B1 retired all three the same day. The fix was not a kernel one: the raw op
 * already IS a prism, so the gap was semantic, and the routing now sends a
 * face that resolves back to a box or cylinder primitive to that primitive's
 * dimension (`planFaceOffset`, shared by the app and this replay). All three
 * scenarios now match their volume oracle exactly, because the oracle rebuilds
 * through the same dimension the drag edits.
 *
 * The prism behaviour has not gone away — it is simply no longer reachable
 * from a face with a primitive chain. A min side, a boolean result, an
 * imported body, or any face whose lineage does not resolve still takes the
 * local push/pull, and that is the class the kernel M6 tangent-propagation ask
 * owns. A shape pin returning here is expected to be one of those.
 */
export const SHAPE_PINS: ShapePin[] = [];

/** Each row pins the exact user sentence and the kernel taxonomy for its cells. */
export interface LadderRefusalPin {
  target: string;
  distances: readonly number[];
  message: string;
  family: string;
  category: string;
  code: string;
  limit?: number;
  owner: 'K10' | 'K05' | 'U02';
}

/** Departures from the authored geometric limit, including legal topology changes. */
export const LADDER_LIMIT_PINS = [
  {
    target: 'A/bottom',
    distances: [-8.9],
    owner: 'K10',
    reason:
      'The chamfer carry refuses the last inward step before wall collapse.'
  },
  {
    target: 'A/post-cap',
    distances: [-8.6],
    owner: 'K10',
    reason:
      'The cap rounds meet the shoulder blend at the nominal limit; the next step builds with changed topology.'
  },
  {
    target: 'A/shoulder',
    distances: [8.6],
    owner: 'K10',
    reason:
      'The shoulder blend meets the cap round at the nominal limit; the next step builds with changed topology.'
  },
  {
    target: 'A/root',
    distances: [4.25, 8.4],
    owner: 'K10',
    reason:
      'The adjoining fillets cannot re-blend at the larger requested radii.'
  },
  {
    target: 'frustum/cone-cap',
    distances: [-0.1, -1, -5.5, -11, -21.9, 0.1, 1, 7.5, 15, 29.9],
    owner: 'K10',
    reason:
      'The conical rim fillet cannot be carried even before the cap reaches either bound.'
  },
  {
    target: 'frustum/shoulder',
    distances: [-0.1, -1, -2.25, -4.5, -8.9, 0.1, 1, 5, 10, 19.9],
    owner: 'K10',
    reason:
      'The conical root fillet cannot be carried even before the shoulder reaches either bound.'
  },
  {
    target: 'frustum/root',
    distances: [-0.1, -0.5, -1, -1.9, 0.1, 1, 1.75, 3.5, 6.9],
    owner: 'K10',
    reason: 'The plane/cone pair cannot be re-filleted by direct resize.'
  },
  {
    target: 'B/edge-round',
    distances: [-1.5, 4.5, 4.6, 9],
    owner: 'K10',
    reason:
      'Zero removes the connected blend region. Near the uniform radius limit, the kernel reblends only the chosen corner and preserves the neighboring radii.'
  },
  {
    target: 'C/root',
    distances: [-2, 7.9],
    owner: 'K10',
    reason:
      'Zero removes the root band. At +7.9 the radius-fit guard refuses 0.1 mm before the plate edge.'
  },
  {
    target: 'C/wall',
    distances: [-7.9],
    owner: 'K10',
    reason:
      'The result would lose the root fillet before the cylinder itself runs out of radius.'
  },
  {
    target: 'D/wall',
    distances: [-0.1, -1, -1.625, -3.25, -6.4, 0.1, 1, 6, 12, 24, 48],
    owner: 'K10',
    reason:
      'Local cylinder resize cannot carry the two chamfers. The source cylinder radius is the alternative.'
  }
] as const;

/** A pin describes the first refusal and every subsequent success in the direction. */
export const LADDER_MONOTONIC_PINS: readonly {
  target: string;
  firstRefusal: number;
  laterSuccesses: readonly number[];
  owner: 'K10' | 'K05';
  finding: string;
}[] = [
  {
    target: 'A/post-cap',
    firstRefusal: -8.5,
    laterSuccesses: [-8.6],
    owner: 'K10',
    finding:
      'The rim touches the junction at contact. After crossing it the rebuild splits a torus and fits two additional corner patches.'
  },
  {
    target: 'A/shoulder',
    firstRefusal: 8.5,
    laterSuccesses: [8.6],
    owner: 'K10',
    finding:
      'The junction touches the rim at contact. After crossing it the rebuild splits a torus and fits two additional corner patches.'
  }
];

/** The re-blend stopped resizing the whole connected cluster at these steps. */
export const BOX_CORNER_ONLY_STEPS = [4.4, 4.5, 4.6, 9];

/** The two ways of crossing the same rim give the same fitted cap join.
 * The measured excess over the independent source build is in mm³. */
export const CAP_JOIN_PINS = [
  { target: 'A/post-cap', distance: -8.6 },
  { target: 'A/shoulder', distance: 8.6 }
].map((cell) => ({
  ...cell,
  owner: 'K10',
  message:
    'Feature "Offset face": The upper rim was rebuilt with approximate corner surfaces.',
  excessVolume: 8.11027
}));

/** Separate from the local outcome. The root fillet refuses on source replay at 0.1 mm plate thickness. */
export const LADDER_SOURCE_REFUSAL_PINS = [
  {
    targets: ['C/shoulder', 'C/cap-set'],
    distance: -11.9,
    message:
      'Fillet could not be created on 1 selected edge with radius 2. Try a smaller radius: radius 0.4 builds here.',
    kernelRefusal: {
      family: 'blend',
      category: 'invalid_input',
      code: 'invalid-input'
    },
    owner: 'K10'
  }
] as const;

export const LADDER_REFUSAL_PINS: readonly LadderRefusalPin[] = [
  {
    target: 'A/bottom',
    distances: [-8.9, -9, -9.1, -18],
    message:
      "This face's chamfered edge can't move with it here. Remove the chamfer in History, offset the face, then chamfer the edge again.",
    family: 'direct-edit',
    category: 'unsupported',
    code: 'offset_face_chamfer_rim_not_carried',
    owner: 'K10'
  },
  {
    target: 'A/post-cap',
    distances: [-8.5, -17],
    message: 'The exact kernel failed internally on this operation.',
    family: 'direct-edit',
    category: 'internal',
    code: 'offset_face_refused',
    owner: 'K10'
  },
  {
    target: 'A/shoulder',
    distances: [-9, -9.1],
    message:
      'A neighbouring face would shrink to nothing past -9. Try a smaller offset.',
    family: 'direct-edit',
    category: 'invalid_topology',
    code: 'offset_face_collapses_neighbor',
    owner: 'K10',
    limit: -9
  },
  {
    target: 'A/shoulder',
    distances: [-18],
    message:
      'The face would run into another part of the body before it got that far.',
    family: 'direct-edit',
    category: 'internal',
    code: 'offset_face_refused',
    owner: 'K10'
  },
  {
    target: 'A/shoulder',
    distances: [8.5, 17],
    message: 'The exact kernel failed internally on this operation.',
    family: 'direct-edit',
    category: 'internal',
    code: 'offset_face_refused',
    owner: 'K10'
  },
  {
    target: 'A/root',
    distances: [-2],
    message:
      'The exact kernel does not support this combination of shapes yet.',
    family: 'blend',
    category: 'unsupported',
    code: 'resize-blend-failed',
    owner: 'K10'
  },
  {
    target: 'A/root',
    distances: [-2.1, -4],
    message: 'Blend radius must be zero or greater.',
    family: 'direct-edit',
    category: 'invalid_input',
    code: 'blend_radius_negative',
    owner: 'K10'
  },
  {
    target: 'A/root',
    distances: [4.25, 8.4, 8.5, 8.6, 17],
    message:
      'The adjoining fillets could not be rebuilt at this radius. Try a smaller radius or edit the fillets in History.',
    family: 'blend',
    category: 'unsupported',
    code: 'blend-cluster-reblend-failed',
    owner: 'K10'
  },
  {
    target: 'frustum/bottom',
    distances: [-9, -9.1],
    message:
      'A neighbouring face would shrink to nothing past -9. Try a smaller offset.',
    family: 'direct-edit',
    category: 'invalid_topology',
    code: 'offset_face_collapses_neighbor',
    owner: 'K10'
  },
  {
    target: 'frustum/bottom',
    distances: [-18],
    message:
      'The face would run into another part of the body before it got that far.',
    family: 'direct-edit',
    category: 'internal',
    code: 'offset_face_refused',
    owner: 'K10'
  },
  {
    target: 'frustum/cone-cap',
    distances: [
      -0.1, -1, -5.5, -11, -21.9, -22, -22.1, -44, 0.1, 1, 7.5, 15, 29.9, 30,
      30.1, 60
    ],
    message:
      'This face meets a fillet on a cone that cannot be rebuilt during an offset. Edit the cone or fillet in History instead.',
    family: 'direct-edit',
    category: 'unsupported',
    code: 'offset_face_conical_blend',
    owner: 'K10'
  },
  {
    target: 'frustum/shoulder',
    distances: [
      -0.1, -1, -2.25, -4.5, -8.9, -9, -9.1, -18, 0.1, 1, 5, 10, 19.9, 20, 20.1,
      40
    ],
    message:
      'This face meets a fillet on a cone that cannot be rebuilt during an offset. Edit the cone or fillet in History instead.',
    family: 'direct-edit',
    category: 'unsupported',
    code: 'offset_face_conical_blend',
    owner: 'K10'
  },
  {
    target: 'frustum/root',
    distances: [-0.1, -0.5, -1, -1.9, -2, 0.1, 1, 1.75, 3.5, 6.9, 7, 7.1, 14],
    message:
      "This fillet joins faces that removing or resizing a fillet can't rebuild yet; that works for fillets between flat and cylindrical faces. Edit the fillet in History instead.",
    family: 'blend',
    category: 'unsupported',
    code: 'unsupported-support-pair',
    owner: 'K10'
  },
  {
    target: 'frustum/root',
    distances: [-2.1, -4],
    message: 'Blend radius must be zero or greater.',
    family: 'direct-edit',
    category: 'invalid_input',
    code: 'blend_radius_negative',
    owner: 'K10'
  },
  {
    target: 'B/cap',
    distances: [-9, -9.1],
    message:
      'A neighbouring face would shrink to nothing past -9. Try a smaller offset.',
    family: 'direct-edit',
    category: 'invalid_topology',
    code: 'offset_face_collapses_neighbor',
    owner: 'K10'
  },
  {
    target: 'B/cap',
    distances: [-18],
    message:
      'The face would run into another part of the body before it got that far.',
    family: 'direct-edit',
    category: 'internal',
    code: 'offset_face_refused',
    owner: 'K10'
  },
  {
    target: 'B/edge-round',
    distances: [-1.6, -3],
    message: 'Blend radius must be zero or greater.',
    family: 'direct-edit',
    category: 'invalid_input',
    code: 'blend_radius_negative',
    owner: 'K10'
  },
  {
    target: 'C/shoulder',
    distances: [-12, -12.1, -24],
    message:
      'The face would run into another part of the body before it got that far.',
    family: 'direct-edit',
    category: 'internal',
    code: 'offset_face_refused',
    owner: 'K10'
  },
  {
    target: 'C/shoulder',
    distances: [20, 20.1, 40],
    message:
      'The moving fillet would reach another face before completing this offset. Try a smaller offset.',
    family: 'direct-edit',
    category: 'invalid_topology',
    code: 'offset_face_blend_reaches_fixed_rim',
    owner: 'K10'
  },
  {
    target: 'C/boss-cap',
    distances: [-20, -20.1, -40],
    message:
      'The face would run into another part of the body before it got that far.',
    family: 'direct-edit',
    category: 'internal',
    code: 'offset_face_refused',
    owner: 'K10'
  },
  {
    target: 'C/cap-set',
    distances: [-12, -12.1, -24],
    message:
      'The face would run into another part of the body before it got that far.',
    family: 'direct-edit',
    category: 'internal',
    code: 'offset_face_refused',
    owner: 'K10'
  },
  {
    target: 'C/root',
    distances: [-2.1, -4],
    message: 'Blend radius must be zero or greater.',
    family: 'direct-edit',
    category: 'invalid_input',
    code: 'blend_radius_negative',
    owner: 'K10'
  },
  {
    target: 'C/root',
    distances: [7.9, 8, 8.1, 16],
    message:
      'That radius is too large for the faces this blend joins. Try a smaller radius.',
    family: 'blend',
    category: 'invalid_input',
    code: 'radius-too-large',
    owner: 'K10'
  },
  {
    target: 'C/wall',
    distances: [-7.9],
    message:
      'The wall could not be resized to radius 0.1: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'C/wall',
    distances: [-8, -8.1, -16],
    message: 'Radius must be greater than zero.',
    family: 'direct-edit',
    category: 'invalid_input',
    code: 'radius_not_positive',
    owner: 'K10'
  },
  {
    target: 'C/wall',
    distances: [8],
    message:
      'The wall could not be resized to radius 16: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'C/wall',
    distances: [8.1],
    message:
      'The wall could not be resized to radius 16.1: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'C/wall',
    distances: [16],
    message:
      'The wall could not be resized to radius 24: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/cap',
    distances: [-21, -21.1, -42],
    message:
      'That distance would leave no cylindrical wall between the end faces.',
    family: 'direct-edit',
    category: 'invalid_topology',
    code: 'offset_face_collapses_chamfered_cylinder_wall',
    limit: -21,
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [-0.1],
    message:
      'The wall could not be resized to radius 7.9: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [-1],
    message:
      'The wall could not be resized to radius 7: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [-1.625],
    message:
      'The wall could not be resized to radius 6.375: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [-3.25],
    message:
      'The wall could not be resized to radius 4.75: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [-6.4],
    message:
      'The wall could not be resized to radius 1.6: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [-6.5],
    message:
      'The wall could not be resized to radius 1.5: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [-6.6],
    message:
      'The wall could not be resized to radius 1.4: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [-13],
    message: 'Radius must be greater than zero.',
    family: 'direct-edit',
    category: 'invalid_input',
    code: 'radius_not_positive',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [0.1],
    message:
      'The wall could not be resized to radius 8.1: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [1],
    message:
      'The wall could not be resized to radius 9: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [6],
    message:
      'The wall could not be resized to radius 14: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [12],
    message:
      'The wall could not be resized to radius 20: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [24],
    message:
      'The wall could not be resized to radius 32: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'D/wall',
    distances: [48],
    message:
      'The wall could not be resized to radius 56: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    owner: 'K10'
  },
  {
    target: 'B/edge-round',
    distances: [33],
    message:
      'The adjoining fillets could not be rebuilt at this radius. Try a smaller radius or edit the fillets in History.',
    family: 'blend',
    category: 'unsupported',
    code: 'blend-cluster-reblend-failed',
    owner: 'K10'
  }
];

/**
 * Every refusal the fixed-seed chain slice (`chains.test.ts`) reaches, keyed
 * by kernel taxonomy and the literal user sentence. A chain refusal that
 * matches no entry leaves the chain's ledger state, and `at` must equal the
 * steps that reached the entry, so a pin cannot outlive any of its refusals.
 */
export interface ChainRefusalPin {
  id: string;
  family: string;
  category: string;
  code: string;
  /** Literal sentences the app shows for this refusal. */
  messages: readonly string[];
  /**
   * Every step that reaches this refusal, as `<cell>#<step index>`, so each
   * occurrence is pinned on its own and none can start building unnoticed.
   */
  at: readonly string[];
  owner: 'K10' | 'K05' | 'U02';
  reason: string;
}

const RESIZE_LEFT_BLEND_BEHIND = (radius: number) =>
  `The wall could not be resized to radius ${radius}: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.`;

export const CHAIN_REFUSAL_PINS: readonly ChainRefusalPin[] = [
  {
    id: 'offset-past-body',
    family: 'direct-edit',
    category: 'internal',
    code: 'offset_face_refused',
    messages: [
      'The face would run into another part of the body before it got that far.'
    ],
    at: [
      'A/seed-1/20#1',
      'A/seed-1/20#8',
      'A/seed-3/20#13',
      'B/seed-1/20#11',
      'B/seed-1/20#12',
      'B/seed-3/20#5',
      'C/seed-2/20#0',
      'C/seed-2/20#1'
    ],
    owner: 'K10',
    reason:
      'Designed refusal: the limit probe moves a face inward past the far side of the body.'
  },
  {
    id: 'chamfer-face-offset',
    family: 'direct-edit',
    category: 'unsupported',
    code: 'offset_face_refused',
    messages: [
      "This face meets a curved surface that resizing and moving faces can't follow yet. Change the size on the original shape in History instead."
    ],
    at: [
      'A/seed-1/20#3',
      'A/seed-1/20#4',
      'A/seed-1/20#10',
      'A/seed-1/20#17',
      'A/seed-2/20#3',
      'A/seed-2/20#7',
      'A/seed-2/20#13',
      'A/seed-3/20#0',
      'A/seed-3/20#1',
      'A/seed-3/20#3',
      'A/seed-3/20#7'
    ],
    owner: 'K10',
    reason:
      "Part A's slanted base-chamfer planes meet the post's conical chamfer and the blends; the local offset cannot carry those neighbours."
  },
  {
    id: 'unresolved-rim-after-direct-edits',
    family: 'direct-edit',
    category: 'unsupported',
    code: 'ambiguous_rim_chamfer',
    messages: [
      'Choose whether this rim should move as a chamfer or extend as a draft.'
    ],
    at: ['A/seed-2/20#11'],
    owner: 'K10',
    reason:
      'After the cylinder resize and five wall edits, the rebuilt band has no surviving chamfer provenance. The unchosen offset must leave geometry and history intact.'
  },
  {
    id: 'chamfered-wall-collapse',
    family: 'direct-edit',
    category: 'invalid_topology',
    code: 'offset_face_collapses_chamfered_cylinder_wall',
    messages: [
      'That distance would leave no cylindrical wall between the end faces.'
    ],
    at: [
      'D/seed-1/20#0',
      'D/seed-2/20#8',
      'D/seed-2/20#15',
      'D/seed-3/20#13',
      'D/seed-3/20#17'
    ],
    owner: 'K10',
    reason:
      "Designed refusal: the limit probe moves part D's cap past the opposite chamfer."
  },
  {
    id: 'negative-blend-radius',
    family: 'direct-edit',
    category: 'invalid_input',
    code: 'blend_radius_negative',
    messages: ['Blend radius must be zero or greater.'],
    at: ['A/seed-1/20#7'],
    owner: 'K10',
    reason: 'Designed refusal: the limit probe asks for a radius below zero.'
  },
  {
    id: 'blend-too-large',
    family: 'blend',
    category: 'invalid_input',
    code: 'radius-too-large',
    messages: [
      'That radius is too large for the faces this blend joins. Try a smaller radius.'
    ],
    at: ['C/seed-3/20#18'],
    owner: 'K10',
    reason:
      'Designed refusal: the limit probe asks for a radius wider than the faces it joins.'
  },
  {
    id: 'blend-cluster-reblend',
    family: 'blend',
    category: 'unsupported',
    code: 'blend-cluster-reblend-failed',
    messages: [
      'The adjoining fillets could not be rebuilt at this radius. Try a smaller radius or edit the fillets in History.'
    ],
    at: ['A/seed-3/20#4', 'A/seed-3/20#12'],
    owner: 'K10',
    reason:
      "Resizing one of part A's edge blends needs the adjoining fillets re-blended, which the kernel refuses both for a new 0.5 mm resize and for an earlier resize edited by -0.5 mm."
  },
  {
    id: 'wall-resize-chamfer',
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    messages: [7, 7.5, 8.5, 9, 9.5].map(RESIZE_LEFT_BLEND_BEHIND),
    at: [
      'D/seed-1/20#12',
      'D/seed-1/20#16',
      'D/seed-1/20#17',
      'D/seed-2/20#1',
      'D/seed-2/20#3',
      'D/seed-2/20#13',
      'D/seed-2/20#16',
      'D/seed-2/20#18',
      'D/seed-2/20#19',
      'D/seed-3/20#1',
      'D/seed-3/20#19'
    ],
    owner: 'K10',
    reason:
      'The D/wall ladder limit: a local cylinder resize cannot carry the two chamfers.'
  },
  {
    id: 'earlier-edit-repick',
    family: 'reference',
    category: 'invalid_input',
    code: 'reference_missing',
    messages: [
      'A selected face no longer exists. Re-select the face(s) and re-create this feature.'
    ],
    at: ['B/seed-1/20#14'],
    owner: 'K05',
    reason:
      'Observation O4: changing an earlier value removes the face a later edit picked, and the later edit refuses. The chain requires that typed re-pick refusal, never an edit of a different face.'
  },
  {
    id: 'offset-carries-post',
    family: 'direct-edit',
    category: 'unsupported',
    code: 'offset_face_carried_detached_support',
    messages: [
      'Offsetting this face would also move a separate curved feature joined to it by a fillet (such as a boss), so the offset was not applied. The exact kernel cannot yet rebuild the fillet between them for this offset.'
    ],
    at: ['A/seed-1/20#13', 'A/seed-2/20#2', 'A/seed-2/20#5', 'A/seed-3/20#18'],
    owner: 'K10',
    reason:
      "Part A's corner junction rounds make the plate's front and left faces one tangent chain with the post. The pinned kernel offsets either face by translating the post with it (the post's axis left the origin), which these chains used to commit; the adapter now refuses it."
  }
];

/** Limits independently exercised on the recorded, unchanged Part A. */
export const RECORDED_BOTTOM_CHAIN_PIN: ChainRefusalPin = {
  id: 'chamfer-rim',
  family: 'direct-edit',
  category: 'unsupported',
  code: 'offset_face_chamfer_rim_not_carried',
  messages: [
    "This face's chamfered edge can't move with it here. Remove the chamfer in History, offset the face, then chamfer the edge again."
  ],
  at: ['A/o2-bottom-14/1#0', 'A/o2-bottom-18/1#0'],
  owner: 'K10',
  reason:
    'The recorded bottom-offset chain on the unchanged authored body reaches the same chamfer-carry limit as the A/bottom ladder.'
};
