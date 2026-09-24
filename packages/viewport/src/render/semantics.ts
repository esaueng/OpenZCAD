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
    edge: 0x121519,
    /** Idle edge contrast when no shaded face sits behind the topology. */
    wireframeEdge: 0xb0bcd4,
    edgeWidth: 1.4,
    edgeOpacity: 0.92
  },
  /** Under the pointer, not yet committed to. */
  hover: {
    face: 0x8fb0ff,
    faceOpacity: 0.3,
    /** The part of the face behind other geometry. */
    hiddenFaceOpacity: 0.1,
    faceEmissive: 0x10172c,
    edge: 0xbfcfff,
    edgeWidth: 4
  },
  /** Picked, and what a command will act on. */
  selected: {
    face: 0x6798ff,
    /**
     * Lowered from 0.5. A large selected face was hiding its own edges and the
     * holes through it; the rim below is already the stronger signal at width
     * 6 against a selected edge's 4.5, so the fill does not have to be.
     */
    faceOpacity: 0.38,
    hiddenFaceOpacity: 0.16,
    /** Whole-body tint. See `bodyEmissive` below before reaching for it. */
    bodyEmissive: 0x17295e,
    /**
     * Every edge of a selected body, in the selection blue at a width between
     * idle and a selected edge. The emissive tint alone was too quiet: two
     * dark bodies picked for a union looked the same as two unpicked ones
     * from most angles, so the outline carries the state instead.
     */
    bodyEdgeWidth: 2.6,
    edge: 0x81a9ff,
    edgeWidth: 4.5,
    /** The rim of a selected face: brighter and wider than its own edges. */
    boundary: 0xc7d6ff,
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
    added: 0x6798ff,
    addedOpacity: 0.5
  },
  /** The thing being dragged. */
  handle: {
    /** A periwinkle blue, lit by the scene rather than outlined. */
    idle: 0x5987ff,
    /** Under the pointer or in hand it deepens rather than washing out. */
    hot: 0x3d68de,
    /** The value under the pointer will not build. */
    invalid: 0xf59e0b
  },
  /**
   * A face offset's change, while it is being dragged. Only what the gesture
   * changes is coloured: material it adds is green, material it removes is
   * coral, and the arrow that measures it is drawing white, rising from a
   * dashed ring at the face's old level.
   */
  change: {
    arrow: 0xffffff,
    oldLevel: 0xffffff,
    add: 0x48cd8f,
    addStripe: 0x5bc794,
    addSeam: 0x2f8a60,
    cut: 0xff644d,
    cutStripe: 0xdd7362,
    cutSeam: 0x994e42,
    bandOpacity: 0.9
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
    boundaryIdle: 0x7aa0ff,
    boundaryHover: 0xaec4ff,
    boundarySelected: 0xffc45c
  },
  /** Opacity an overlay fades to when it registers without naming a target. */
  defaultFadeTarget: 0.34
} as const;
