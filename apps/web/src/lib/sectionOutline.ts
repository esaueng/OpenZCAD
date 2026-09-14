import type { ExactSectionPlane } from '@openzcad/kernel-adapter/exact';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
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
      /** Bodies on screen the plane passed by without cutting. */
      missed: number;
      /**
       * Bodies on screen the plane DOES cut and the kernel could not
       * section exactly. These are what stops the drawing: the export
       * writes every cut body or none, so one of these makes the section
       * unexportable however many other bodies came out exact.
       */
      unsectioned: number;
    }
  | { kind: 'refused'; detail: string };

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
  const missed = report.refusals.filter(
    (refusal) => refusal.reason === 'plane-misses-body'
  ).length;
  return {
    kind: 'exact',
    regions: report.regions.map((region) => ({
      bodyId: region.bodyId,
      positions: region.positions,
      indices: region.indices,
      loops: region.loops
    })),
    area: report.regions.reduce((total, region) => total + region.area, 0),
    missed,
    unsectioned: report.refusals.length - missed
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
 * Ask for one exact section of exactly these bodies, and turn the answer
 * into viewport state.
 *
 * `bodyIds` is the viewport's own visible list. The document cannot supply
 * it: `Hide Body` and `Isolate` write device-local view state, so a section
 * taken from the document alone draws a cut surface floating where a hidden
 * body used to be and adds its area to the total.
 *
 * Staleness is the caller's: an exact section belongs to one plane
 * position, one model version and one set of visible bodies, and by the time
 * a large part has been sectioned the user may have moved on from any of
 * them. The caller holds a token across the await and drops an answer that
 * is no longer about what is on screen.
 */
export async function resolveSectionOutline(
  geometry: Pick<GeometryWorkerApi, 'sectionOutline'>,
  document: ProjectDocument,
  section: SectionViewSettings,
  bodyIds: BodyId[]
): Promise<SectionOutlineState> {
  try {
    return sectionOutlineFromReport(
      await geometry.sectionOutline(
        document,
        sectionPlaneSpec(section),
        bodyIds
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
 * Call it only for a section `sectionOutlineExportable` accepts: the
 * exporter refuses a body it cannot section exactly rather than dropping it
 * from the drawing, and that refusal reads as a kernel diagnostic, not as
 * something to put in front of a user.
 */
export async function writeSectionDxf(
  geometry: Pick<GeometryWorkerApi, 'exportModel'>,
  document: ProjectDocument,
  section: SectionViewSettings,
  bodyIds: BodyId[],
  save: (fileName: string, format: 'dxf', text: string) => Promise<boolean>,
  stem: string,
  announce: (message: string) => void
): Promise<void> {
  const fileName = `${stem}-section.dxf`;
  announce('Exporting the section as DXF…');
  try {
    // The same bodies the exact section on screen was cut from. A drawing of
    // a different set from the one the user is looking at is a drawing of
    // something they never saw.
    const result = await geometry.exportModel('dxf', document, bodyIds, {
      section: sectionPlaneSpec(section)
    });
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
