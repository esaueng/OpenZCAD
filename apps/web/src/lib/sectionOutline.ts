import type { ExactSectionPlane } from '@openzcad/kernel-adapter/exact';
import type {
  BodyId,
  BodyRepresentation,
  ProjectDocument
} from '@openzcad/shared';
import type { GeometryWorkerApi } from '../hooks/useGeometryWorker';
import type {
  ExactSectionRegionDisplay,
  SectionViewSettings
} from '@openzcad/viewport';

type SectionOutlineReport = Awaited<
  ReturnType<GeometryWorkerApi['sectionOutline']>
>;

/**
 * The section view has two geometries behind it. While the plane moves, the
 * viewport clips the display mesh and caps it — an approximation, and the
 * only one fast enough to drag. At rest, the kernel's own section replaces
 * it: exact curves, a measured area, and the only form of it that may be
 * exported.
 *
 * This module is reached lazily (the viewer bar imports it, the workspace
 * imports it inside the handler that needs it) so the launcher chunk carries
 * none of it.
 */
export type SectionOutlineState =
  | { kind: 'clipping' }
  | { kind: 'computing' }
  | {
      kind: 'exact';
      regions: ExactSectionRegionDisplay[];
      /** Total cut area, in document units squared. */
      area: number;
      /**
       * Bodies on screen the plane passed by without cutting — counted as
       * BODIES. The kernel reports per solid, and one body can hold several
       * (a multi-solid STEP import does), so a plane that cuts one solid of
       * a body and misses another must not read as a body that is not cut.
       */
      missed: number;
      /**
       * Bodies on screen the plane DOES cut and the kernel could not
       * section exactly — again as BODIES, one entry however many of its
       * solids refused. These are what stops the drawing: the export writes
       * every cut body or none, so one of these makes the section
       * unexportable however many other bodies came out exact. A body with
       * both kinds of refusal counts here, never as `missed`.
       */
      unsectioned: number;
    }
  | { kind: 'refused'; detail: string };

/**
 * What an exact section is a section OF: one document, and the bodies of it
 * that are on screen.
 *
 * The two travel as ONE value because they are one decision and have come
 * apart once already. The viewport draws a preview document's bodies while
 * `doc` stays the live one; a list taken from the viewport and a document
 * taken from the workspace then describe different models, and the adapter
 * has no geometry for half the names it is given. Anything that asks a
 * question about what is on screen takes this, never a document and a list
 * as two arguments.
 *
 * `document` is nullable because the workspace has none before the first
 * project opens; there is nothing to section then and nothing is asked.
 */
export interface SectionSource {
  readonly document: ProjectDocument | null;
  /**
   * The bodies of `document` the viewport is showing. Hiding and isolating
   * are device-local view state the document never sees, so this cannot be
   * derived from `document` — it has to be carried.
   */
  readonly bodyIds: readonly BodyId[];
}

/**
 * Geometry the viewport draws that no document built: an approximate
 * stand-in, put up while something is being tried out and drawn in front of
 * the bodies it `replaces` — which are hidden for as long as it is up.
 *
 * The parameter preview is one today. Whatever is added next is one too: to
 * be drawn at all it has to reach the viewport through `ViewportGeometry`,
 * and reaching it through here is what keeps the section honest about it
 * without the section ever learning its name.
 */
export interface ViewportStandIn {
  /** Bodies of the document this is drawn instead of. */
  readonly replaces: readonly BodyId[];
}

/**
 * THE answer to "what is the viewport drawing?" — one value, built once,
 * read by the viewer's own props and by everything that asks a question
 * about what is on screen.
 *
 * It exists because that question was answered twice, independently, and
 * the two answers came apart three times: first when a published preview
 * document replaced the live one, then when a parameter edit nobody had
 * applied hid the live bodies and drew a candidate in their place, then when
 * the Move gizmo posed a body's mesh straight into the scene — each time
 * with the section still describing the document underneath. All three were
 * the same defect. A re-derivation of "what is on screen" is the defect;
 * there is one derivation, and this is it.
 *
 * The first two fields are DECLARED by the workspace: it knows it swapped
 * the document, it knows it put a stand-in up. The third is OBSERVED, by the
 * viewport, from the objects it is about to draw — because the third
 * instance declared nothing, and a fourth mechanism is under no obligation
 * to either.
 */
export interface ViewportGeometry<S extends ViewportStandIn = ViewportStandIn> {
  /**
   * The document whose exact build the viewport draws. Null before the
   * first project opens.
   */
  readonly document: ProjectDocument | null;
  /** The bodies of `document` on screen: consumed and hidden ones dropped. */
  readonly bodies: BodyRepresentation[];
  /** Every stand-in currently drawn over that build; null or empty when none. */
  readonly standIns: S[] | null;
  /**
   * Bodies the viewport reported it is NOT drawing where the document built
   * them: moved or turned by the Move gizmo, resized by a face drag, hidden
   * under something else — whatever did it.
   *
   * This one is not declared by the mechanism that caused it. The viewer
   * reads it off the body objects it is about to draw (`DrawnBodyReport` in
   * `@openzcad/viewport`) and reports it back, which is why a mechanism that
   * poses a mesh without telling anyone still lands here. Everything above
   * is what the workspace SAYS it is drawing; this is what the frame DID.
   */
  readonly drawnElsewhere: readonly string[];
}

/**
 * Every field of {@link ViewportGeometry} that {@link sectionSourceOf} reads.
 *
 * Adding a field to `ViewportGeometry` without adding it here stops this
 * file compiling, so a new way of putting geometry on screen cannot arrive
 * through this value while the section quietly keeps describing the old one —
 * which is exactly how the first two instances of this defect shipped. The
 * compiler cannot tell whether a new field CHANGES what is drawn, so it
 * insists on being told: read it in `sectionSourceOf`, or name it here with
 * the reason it makes no difference to what a section is a section of.
 */
type SectionReadViewportField =
  'document' | 'bodies' | 'standIns' | 'drawnElsewhere';

/** True only while `sectionSourceOf` reads every field of the value. */
export type SectionReadsEveryViewportField =
  Exclude<keyof ViewportGeometry, SectionReadViewportField> extends never
    ? true
    : false;

/**
 * Fails to typecheck — `Type 'true' is not assignable to type 'false'` — the
 * moment a `ViewportGeometry` field goes unclassified above.
 */
export const sectionReadsEveryViewportField: SectionReadsEveryViewportField = true;

/**
 * What an exact section of this viewport would be a section OF.
 *
 * One rule, deliberately not a list of cases: a section describes the
 * document the viewport is drawing, and while any stand-in is up, or any
 * body of it is drawn somewhere else, the viewport is not drawing that
 * document's geometry. So there is nothing to section exactly, and nothing
 * to export — `document` comes back null and both the section and
 * `writeSectionDxf` fail closed on it.
 *
 * Refusing on `standIns` rather than on the parameter preview by name is
 * half the point; refusing on `drawnElsewhere` — what the viewport reports
 * it actually drew — is the other half, and the half that does not depend on
 * a future mechanism remembering to declare itself.
 */
export function sectionSourceOf(view: ViewportGeometry): SectionSource {
  // Destructured, not read field by field, so this reads as what it is: the
  // whole of what the viewport is drawing, every field of it accounted for
  // (see `SectionReadsEveryViewportField`).
  const { document, bodies, standIns, drawnElsewhere } = view;
  // One rule for both channels, because they are one question. A stand-in is
  // the workspace declaring that something else is on screen; `drawnElsewhere`
  // is the viewport reporting that something else is on screen. Either way the
  // document's own geometry is not what the user is looking at, so there is
  // nothing to section exactly and nothing to export.
  const drawingTheDocument = !standIns?.length && drawnElsewhere.length === 0;
  return {
    document: drawingTheDocument ? document : null,
    bodyIds: bodies.map((body) => body.bodyId)
  };
}

/**
 * The section state this drawing may show.
 *
 * An exact section is a section of a document's own geometry. While a
 * stand-in is drawn over that geometry, or a body of it is drawn somewhere
 * else, the viewport is not showing it — so the cut curves would float
 * beside a shape of a different size or in the empty space a moved body has
 * left, the rail would report the old area as exact, and the DXF button
 * would stay lit over a drawing of a model nobody is looking at. All three
 * come down together here, from the same one reading of the same one value
 * that decides what may be sectioned at all.
 */
export function sectionOutlineFor(
  view: ViewportGeometry,
  outline: SectionOutlineState
): SectionOutlineState {
  return sectionSourceOf(view).document ? outline : { kind: 'clipping' };
}

/** One line for the rail: which section is on screen, and what it measures. */
export interface SectionOutlineStatus {
  kind: SectionOutlineState['kind'];
  detail: string;
}

/**
 * The cutting plane behind a section view, in document space. The viewport
 * clips with the negated normal (it throws away the half above the offset);
 * the kernel is asked about the plane itself, which has no near or far side.
 */
export function sectionPlaneSpec(
  section: SectionViewSettings
): ExactSectionPlane {
  const axis: ExactSectionPlane['normal'] =
    section.plane === 'XY'
      ? [0, 0, 1]
      : section.plane === 'XZ'
        ? [0, 1, 0]
        : [1, 0, 0];
  return {
    origin: [
      axis[0] * section.offset,
      axis[1] * section.offset,
      axis[2] * section.offset
    ],
    normal: axis
  };
}

/** What the viewport should show for one kernel section report. */
export function sectionOutlineFromReport(
  report: SectionOutlineReport
): SectionOutlineState {
  if (report.regions.length === 0) {
    return {
      kind: 'refused',
      detail:
        report.refusals[0]?.message ??
        'The section plane does not cut any body.'
    };
  }
  // A plane that simply misses a body is an ordinary section; a body it cuts
  // and the kernel could not section is not. Only the second kind decides
  // whether there is a drawing to export.
  //
  // Both are counted over BODIES, not over the kernel's per-solid outcomes.
  // A body can hold several solids — a multi-solid STEP import is one body
  // in the model tree — so a plane through one solid of such a body with the
  // others clear of it produces a region AND a `plane-misses-body` refusal
  // for the same body. Counting refusals would then tell the user a body is
  // "not cut here" while pointing at its own cross-section.
  const unsectionedBodies = new Set(
    report.refusals
      .filter((refusal) => refusal.reason !== 'plane-misses-body')
      .map((refusal) => refusal.bodyId)
  );
  const cutBodies = new Set(report.regions.map((region) => region.bodyId));
  const missedBodies = new Set(
    report.refusals
      .filter(
        (refusal) =>
          refusal.reason === 'plane-misses-body' &&
          !cutBodies.has(refusal.bodyId) &&
          !unsectionedBodies.has(refusal.bodyId)
      )
      .map((refusal) => refusal.bodyId)
  );
  return {
    kind: 'exact',
    regions: report.regions.map((region) => ({
      bodyId: region.bodyId,
      positions: region.positions,
      indices: region.indices,
      loops: region.loops
    })),
    area: report.regions.reduce((total, region) => total + region.area, 0),
    missed: missedBodies.size,
    unsectioned: unsectionedBodies.size
  };
}

/**
 * Whether the DXF export can write this section.
 *
 * `exportSectionDxf` fails closed: any refusal other than the plane missing
 * a body aborts the whole drawing rather than quietly leaving that body's
 * material out of it. So the button that calls it has to be shut in exactly
 * that case — an export button that is live and always fails is worse than
 * no button, and the message it fails with is about a tessellated witness
 * the user has never heard of.
 */
export function sectionOutlineExportable(
  outline: SectionOutlineState
): boolean {
  return outline.kind === 'exact' && outline.unsectioned === 0;
}

export function describeSectionOutline(
  outline: SectionOutlineState,
  units: string
): SectionOutlineStatus {
  if (outline.kind === 'exact') {
    const notes: string[] = [];
    if (outline.unsectioned > 0) {
      // Say why the export is shut in the same breath as the count, so the
      // disabled button is never unexplained.
      notes.push(
        `${outline.unsectioned} ${outline.unsectioned === 1 ? 'body has' : 'bodies have'} no exact section, so there is no drawing to export`
      );
    }
    if (outline.missed > 0) {
      notes.push(
        `${outline.missed} ${outline.missed === 1 ? 'body is' : 'bodies are'} not cut here`
      );
    }
    return {
      kind: 'exact',
      detail: [
        `${outline.area.toFixed(2)} ${units}² of material`,
        ...notes
      ].join(', ')
    };
  }
  if (outline.kind === 'refused') {
    return { kind: 'refused', detail: outline.detail };
  }
  if (outline.kind === 'computing') {
    return { kind: 'computing', detail: 'Sectioning the exact geometry…' };
  }
  return {
    kind: 'clipping',
    detail: 'Approximate cut; release the slider for section curves'
  };
}

/**
 * Ask for one exact section of exactly what is on screen, and turn the
 * answer into viewport state.
 *
 * It takes the viewport's geometry, never a `SectionSource` a caller built:
 * a section of anything but what is on screen is the defect this whole file
 * keeps being fixed for, and the way to stop writing it is to leave no call
 * site able to say what is being sectioned.
 *
 * Staleness is the caller's: an exact section belongs to one plane
 * position, one model version and one set of visible bodies, and by the time
 * a large part has been sectioned the user may have moved on from any of
 * them. The caller holds a token across the await and drops an answer that
 * is no longer about what is on screen.
 */
export async function resolveSectionOutline(
  geometry: Pick<GeometryWorkerApi, 'sectionOutline'>,
  view: ViewportGeometry,
  section: SectionViewSettings
): Promise<SectionOutlineState> {
  const source = sectionSourceOf(view);
  if (!source.document) {
    return { kind: 'clipping' };
  }
  try {
    return sectionOutlineFromReport(
      await geometry.sectionOutline(
        source.document,
        sectionPlaneSpec(section),
        [...source.bodyIds]
      )
    );
  } catch (error) {
    return {
      kind: 'refused',
      detail:
        error instanceof Error ? error.message : 'The exact section failed.'
    };
  }
}

/**
 * Write the exact section — never the display caps — as a DXF drawing,
 * narrating both ends of it through `announce` (the status line).
 *
 * It applies `sectionOutlineExportable` itself rather than trusting a
 * caller to: the exporter refuses a body it cannot section exactly rather
 * than dropping it from the drawing, and that refusal reads as a kernel
 * diagnostic, not as something to put in front of a user. The button is
 * shut in that state; this is the same gate for a call that did not come
 * from the button.
 *
 * Like the section itself it takes the viewport's geometry and derives its
 * source from that, so the drawing is of the model on screen by
 * construction rather than by a caller getting it right.
 */
export async function writeSectionDxf(
  geometry: Pick<GeometryWorkerApi, 'exportModel'>,
  view: ViewportGeometry,
  section: SectionViewSettings,
  outline: SectionOutlineState,
  save: (fileName: string, format: 'dxf', text: string) => Promise<boolean>,
  stem: string,
  announce: (message: string) => void
): Promise<void> {
  const source = sectionSourceOf(view);
  if (!source.document || !sectionOutlineExportable(outline)) {
    return;
  }
  const fileName = `${stem}-section.dxf`;
  announce('Exporting the section as DXF…');
  try {
    // The same document and the same bodies the exact section on screen was
    // cut from. A drawing of a different set from the one the user is
    // looking at is a drawing of something they never saw.
    const result = await geometry.exportModel(
      'dxf',
      source.document,
      [...source.bodyIds],
      { section: sectionPlaneSpec(section) }
    );
    if (!('text' in result)) {
      throw new Error('The DXF export returned no text.');
    }
    const saved = await save(fileName, 'dxf', result.text);
    announce(
      saved
        ? `Exported the ${section.plane} section to ${fileName}.`
        : 'DXF export cancelled.'
    );
  } catch (error) {
    announce(
      error instanceof Error ? error.message : 'Section DXF export failed.'
    );
  }
}
