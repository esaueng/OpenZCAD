/**
 * Every colour and opacity that means a *state*, in one place.
 *
 * These were spread across four modules and both layers — hover in the
 * selection manager, selected in the React component, edges in the pick
 * module, handles in the gizmos — so no one could see the language as a whole,
 * and two states could drift into the same blue without anyone noticing.
 *
 * The values here are the ones that shipped. This is a naming pass, not a
 * redesign: the colour language is established (committed solids gray, live
 * preview and selection cyan, sketch regions orange, sketch curves blue,
 * construction geometry purple) and is preserved deliberately.
 *
 * A state must be legible without colour as well, so each state names the
 * width or opacity that carries it too — that is the part a colour-vision
 * deficiency still reads.
 */
export const SELECTION_SEMANTICS = {
  /** Nothing is pointing at it. */
  idle: {
    edge: 0x151c26,
    /** Idle edge contrast when no shaded face sits behind the topology. */
    wireframeEdge: 0xa9c2da,
    edgeWidth: 1.4,
    edgeOpacity: 0.92
  },
  /** Under the pointer, not yet committed to. */
  hover: {
    face: 0x8fc8ff,
    faceOpacity: 0.3,
    /** The part of the face behind other geometry. */
    hiddenFaceOpacity: 0.1,
    faceEmissive: 0x101d2c,
    edge: 0xbfdcff,
    edgeWidth: 4
  },
  /** Picked, and what a command will act on. */
  selected: {
    face: 0x4da3ff,
    /**
     * Lowered from 0.5. A large selected face was hiding its own edges and the
     * holes through it; the rim below is already the stronger signal at width
     * 6 against a selected edge's 4.5, so the fill does not have to be.
     */
    faceOpacity: 0.38,
    hiddenFaceOpacity: 0.16,
    /** Whole-body tint. See `bodyEmissive` below before reaching for it. */
    bodyEmissive: 0x173a5e,
    edge: 0x7cc0ff,
    edgeWidth: 4.5,
    /** The rim of a selected face: brighter and wider than its own edges. */
    boundary: 0xc7ebff,
    boundaryWidth: 6
  },
  /**
   * Geometry that will exist if the command is committed.
   *
   * Distinct from `selected` although it shares its colour: a preview has to
   * stand out against the body it is being added to, so it keeps the stronger
   * fill that selection gave up. The two shared one constant until lowering
   * the selection fill measurably dimmed the preview with it.
   */
  preview: {
    added: 0x4da3ff,
    addedOpacity: 0.5
  },
  /** The thing being dragged. */
  handle: {
    idle: 0xff8a2b,
    hot: 0xffc178,
    /** The value under the pointer will not build. */
    invalid: 0xf59e0b
  },
  /** Shown for reference, never committable. */
  reference: {
    ghost: 0x78998a,
    dimension: 0xf4f7fb
  },
  /** Detected sketch regions: subtle at rest, stronger on hover and selection. */
  region: {
    idleOpacity: 0.22,
    commandOpacity: 0.28,
    hoverOpacity: 0.38,
    selectedOpacity: 0.52,
    boundaryIdle: 0x79b8ff,
    boundaryHover: 0xaed5ff,
    boundarySelected: 0xffc45c
  },
  /** Opacity an overlay fades to when it registers without naming a target. */
  defaultFadeTarget: 0.34
} as const;
