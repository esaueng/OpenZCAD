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

interface LadderDiagnostic {
  family: string;
  category: string;
  code: string;
  message: string;
}

interface LadderRefusalPin {
  cell: string;
  owner: string;
  diagnostic: LadderDiagnostic;
}

function ladderRefusals(
  cells: readonly string[],
  diagnostic: LadderDiagnostic,
  owner = 'K10'
): LadderRefusalPin[] {
  return cells.map((cell) => ({ cell, diagnostic, owner }));
}

/** Literal sentences from the validated feature gate, keyed by signed rung. */
export const LADDER_REFUSAL_PINS: readonly LadderRefusalPin[] = [
  ...ladderRefusals(
    [
      'A/top/-0.1',
      'A/top/-1',
      'A/top/-L/4',
      'A/top/-L/2',
      'A/top/-L-0.1',
      'A/top/-L',
      'A/top/-L+0.1',
      'A/top/-2L',
      'A/top/+0.1',
      'A/top/+1',
      'A/top/+L/4',
      'A/top/+L/2',
      'A/top/+L-0.1',
      'A/top/+L',
      'A/top/+L+0.1',
      'A/top/+2L',
      'C/shoulder/+2L'
    ],
    {
      family: 'direct-edit',
      category: 'internal',
      code: 'offset_face_refused',
      message: 'The exact kernel failed internally on this operation.'
    },
    'U02'
  ),
  ...ladderRefusals(
    ['A/bottom/-L', 'A/bottom/-L+0.1', 'B/top/-L', 'B/top/-L+0.1'],
    {
      family: 'direct-edit',
      category: 'invalid_topology',
      code: 'offset_face_collapses_neighbor',
      message:
        'A neighbouring face would shrink to nothing past 9. Try a smaller offset.'
    }
  ),
  ...ladderRefusals(
    [
      'A/bottom/-2L',
      'B/top/-2L',
      'C/shoulder/-L',
      'C/shoulder/-L+0.1',
      'C/shoulder/-2L',
      'C/boss-cap/-L',
      'C/boss-cap/-L+0.1',
      'C/boss-cap/-2L'
    ],
    {
      family: 'direct-edit',
      category: 'internal',
      code: 'offset_face_refused',
      message:
        'The face would run into another part of the body before it got that far.'
    }
  ),
  ...ladderRefusals(
    ['A/right/-L+0.1', 'A/back/-L+0.1', 'A/right-and-back/-L+0.1'],
    {
      family: 'direct-edit',
      category: 'invalid_topology',
      code: 'offset_face_refused',
      message: 'The blend does not fit here. Try a smaller size.'
    }
  ),
  ...ladderRefusals(['A/right/-2L', 'A/back/-2L', 'A/right-and-back/-2L'], {
    family: 'direct-edit',
    category: 'invalid_topology',
    code: 'offset_face_refused',
    message: 'The resulting body came back invalid.'
  }),
  ...ladderRefusals(
    [
      'A/junction-blend/-0.1',
      'A/junction-blend/-L/4',
      'A/junction-blend/-L/2',
      'A/junction-blend/-1',
      'A/junction-blend/-L-0.1',
      'A/junction-blend/-L',
      'A/junction-blend/+0.1',
      'A/junction-blend/+L/4',
      'A/junction-blend/+1',
      'A/junction-blend/+L/2',
      'A/junction-blend/+L-0.1',
      'A/junction-blend/+L',
      'A/junction-blend/+L+0.1',
      'A/junction-blend/+2L',
      'A/rim-blend/-0.1',
      'A/rim-blend/-L/4',
      'A/rim-blend/-L/2',
      'A/rim-blend/-1',
      'A/rim-blend/-L-0.1',
      'A/rim-blend/-L',
      'A/rim-blend/+0.1',
      'A/rim-blend/+1',
      'A/rim-blend/+L/4',
      'A/rim-blend/+L/2',
      'A/rim-blend/+L-0.1',
      'A/rim-blend/+L',
      'A/rim-blend/+L+0.1',
      'A/rim-blend/+2L'
    ],
    {
      family: 'blend',
      category: 'unsupported',
      code: 'unsupported-support-pair',
      message:
        "This fillet joins faces that removing or resizing a fillet can't rebuild yet; that works for fillets between flat and cylindrical faces. Edit the fillet in History instead."
    }
  ),
  ...ladderRefusals(
    [
      'A/junction-blend/-L+0.1',
      'A/junction-blend/-2L',
      'A/rim-blend/-L+0.1',
      'A/rim-blend/-2L',
      'B/edge-blend/-L+0.1',
      'B/edge-blend/-2L'
    ],
    {
      family: 'direct-edit',
      category: 'invalid_input',
      code: 'blend_radius_negative',
      message: 'Blend radius must be zero or greater.'
    }
  ),
  ...ladderRefusals(
    [
      'B/edge-blend/+L-0.1',
      'B/edge-blend/+L',
      'B/edge-blend/+L+0.1',
      'B/edge-blend/+2L'
    ],
    {
      family: 'blend',
      category: 'quality_refused',
      code: 'blend-cluster-reblend-failed',
      message:
        "The adjoining blends couldn't be rebuilt at that radius. Try a smaller radius or edit the blends in History."
    }
  ),
  ...ladderRefusals(
    ['B/corner-fillet/-L', 'B/corner-fillet/-L+0.1', 'B/corner-fillet/-2L'],
    {
      family: 'blend',
      category: 'invalid_input',
      code: 'edge_modifier_size_not_positive',
      message: 'Edge modifier size must be greater than zero.'
    }
  ),
  ...ladderRefusals(['B/corner-fillet/+L-0.1'], {
    family: 'blend',
    category: 'internal',
    code: 'unsupported-vertex-blend',
    message:
      'Fillet could not be created on 12 selected edges with radius 5.9. Try a smaller radius: radius 5.85 builds here.'
  }),
  ...ladderRefusals(['B/corner-fillet/+L'], {
    family: 'blend',
    category: 'internal',
    code: 'unsupported-vertex-blend',
    message:
      'Fillet could not be created on 12 selected edges with radius 6. Try a smaller radius: radius 5.85 builds here.'
  }),
  ...ladderRefusals(['B/corner-fillet/+L+0.1'], {
    family: 'blend',
    category: 'internal',
    code: 'unsupported-vertex-blend',
    message:
      'Fillet could not be created on 12 selected edges with radius 6.1. Try a smaller radius: radius 5.85 builds here.'
  }),
  ...ladderRefusals(['B/corner-fillet/+2L'], {
    family: 'blend',
    category: 'internal',
    code: 'unsupported-vertex-blend',
    message:
      'Fillet could not be created on 12 selected edges with radius 10.5. Try a smaller radius: radius 5.85 builds here.'
  }),
  ...ladderRefusals(['C/shoulder/+L', 'C/shoulder/+L+0.1'], {
    family: 'direct-edit',
    category: 'internal',
    code: 'offset_face_refused',
    message: 'The blend does not fit here. Try a smaller size.'
  }),
  ...ladderRefusals(['C/cylinder-radius/-L-0.1'], {
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    message:
      'The wall could not be resized to radius 0.1: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.'
  }),
  ...ladderRefusals(
    [
      'C/cylinder-radius/-L',
      'C/cylinder-radius/-L+0.1',
      'C/cylinder-radius/-2L'
    ],
    {
      family: 'direct-edit',
      category: 'invalid_input',
      code: 'radius_not_positive',
      message: 'Radius must be greater than zero.'
    }
  ),
  ...ladderRefusals(['C/cylinder-radius/+L'], {
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    message:
      'The wall could not be resized to radius 14.5: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.'
  }),
  ...ladderRefusals(['C/cylinder-radius/+L+0.1'], {
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    message:
      'The wall could not be resized to radius 14.6: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.'
  }),
  ...ladderRefusals(['C/cylinder-radius/+2L'], {
    family: 'validation',
    category: 'unsupported',
    code: 'resize_left_blend_behind',
    message:
      'The wall could not be resized to radius 21: the blend or chamfer along its edge would be left behind at the old size. Remove the blend, resize the wall, then add the blend again.'
  }),
  ...ladderRefusals(['C/cylinder-height/-L'], {
    family: 'blend',
    category: 'internal',
    code: 'cliff-encountered',
    message:
      'Fillet could not be created on 1 selected edge with radius 1.5. Try a smaller radius: radius 1.485 builds here.'
  }),
  ...ladderRefusals(['C/cylinder-height/-L+0.1'], {
    family: 'blend',
    category: 'internal',
    code: 'cliff-encountered',
    message:
      'Fillet could not be created on 1 selected edge with radius 1.5. Try a smaller radius: radius 1.385 builds here.'
  }),
  ...ladderRefusals(['C/cylinder-height/-2L'], {
    family: 'modeling',
    category: 'invalid_input',
    code: 'cylinder_height_not_positive',
    message: 'The cylinder height must be greater than zero.'
  }),
  ...ladderRefusals(
    [
      'D/top/-L',
      'D/top/-L+0.1',
      'D/top/-2L',
      'D/bottom/-L',
      'D/bottom/-L+0.1',
      'D/bottom/-2L'
    ],
    {
      family: 'direct-edit',
      category: 'invalid_topology',
      code: 'offset_collapses_cylindrical_wall',
      message:
        'That distance would leave no cylindrical wall between the end faces.'
    }
  )
];

/** Successful boundary cells. Each still runs every exact-success oracle. */
export const LADDER_BOUNDARY_SUCCESSES = [
  {
    cell: 'A/right/-L',
    owner: 'K10',
    reason: 'Contact at the calculated junction clearance still builds.'
  },
  {
    cell: 'A/back/-L',
    owner: 'K10',
    reason: 'Contact at the calculated junction clearance still builds.'
  },
  {
    cell: 'A/right-and-back/-L',
    owner: 'K10',
    reason:
      'The closer back face reaches its calculated clearance and the set still builds.'
  },
  {
    cell: 'B/edge-blend/-L',
    owner: 'K10',
    reason: 'The zero-radius edit removes the band and restores a sharp edge.'
  }
] as const;

/**
 * Pairs of cells from one starting state and direction. A newly observed
 * pair needs a named topology event or a finding with its roadmap owner.
 */
export const LADDER_MONOTONIC_FINDINGS: readonly {
  refused: string;
  built: string;
  owner: string;
  reason: string;
}[] = [];
