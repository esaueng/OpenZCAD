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
 * This list is EMPTY as of the first recording, and that is a measurement
 * ---------------------------------------------------------------------------
 *
 * All seven authored scenarios COMMIT against the pinned Remus build,
 * including the one the corpus was written to catch: a cylinder cap offset by
 * -5 is exact in both signs. The refusal channel is live rather than dead —
 * the same replay path reports `empty result: Cut of identical solids` for a
 * -24 offset through a 24 mm plate — so an empty list here means no refusal
 * class reproduces, not that nothing is being watched.
 *
 * Committing is not the same as being right. Three of those seven commit the
 * WRONG solid, and they are pinned in SHAPE_PINS below. The first entry in
 * this list is expected to arrive with the first capture dropped into
 * `fixtures/`.
 */

export interface RefusalPin {
  fixture: string;
  /** Literal substring of the observed refusal. */
  message: string;
  /** Roadmap item that owns closing it. */
  owner: string;
}

export const REFUSAL_PINS: RefusalPin[] = [];

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
 * All three entries are one defect, measured three ways: an offset on a face
 * bordered by blends adds or removes a PRISM over that face's own outline
 * (37 x 7 = 259 mm2) instead of moving the cap and re-blending. The kernel
 * reports the operation as a boolean — a -24 offset through a 24 mm plate
 * comes back "empty result: Cut of identical solids" — and the deltas below
 * are 259 x offset to the last digit on two of the three.
 *
 * The blend rim is left standing, so the committed part is a plate with a
 * rectangular pocket or boss, not a thicker plate. Nothing refuses.
 */
export const SHAPE_PINS: ShapePin[] = [
  {
    fixture: 'box-all-edges-filleted-top-offset',
    observedVolumeDelta: 1294.9973,
    expectedVolumeDelta: 1990.3054,
    owner: 'direct-edit-reliability-plan.md B1 (prismatic fallback)'
  },
  {
    fixture: 'box-all-edges-chamfered-top-offset',
    observedVolumeDelta: 1295,
    expectedVolumeDelta: 1977.5,
    owner: 'direct-edit-reliability-plan.md B1 (prismatic fallback)'
  },
  {
    fixture: 'box-filleted-top-offset-inward-past-blend',
    observedVolumeDelta: -777,
    expectedVolumeDelta: -1194.1315,
    owner: 'direct-edit-reliability-plan.md B1 (prismatic fallback)'
  }
];
