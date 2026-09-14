import type { ExactSectionPlane } from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';
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
      /** Bodies the plane passed by, or the kernel could not section. */
      refused: number;
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
  return {
    kind: 'exact',
    regions: report.regions.map((region) => ({
      bodyId: region.bodyId,
      positions: region.positions,
      indices: region.indices,
      loops: region.loops
    })),
    area: report.regions.reduce((total, region) => total + region.area, 0),
    refused: report.refusals.length
  };
}

export function describeSectionOutline(
  outline: SectionOutlineState,
  units: string
): SectionOutlineStatus {
  if (outline.kind === 'exact') {
    const passed =
      outline.refused > 0
        ? `, ${outline.refused} ${outline.refused === 1 ? 'body has' : 'bodies have'} no exact section`
        : '';
    return {
      kind: 'exact',
      detail: `${outline.area.toFixed(2)} ${units}² of material${passed}`
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
 * Ask for one exact section and turn the answer into viewport state.
 *
 * The live plane and model version are read back after the kernel answers,
 * not before: an exact section belongs to one plane position and one model
 * version, and by the time a large part has been sectioned the user may have
 * moved on from both. `null` means the answer is no longer about what is on
 * screen and must be dropped.
 */
export async function resolveSectionOutline(
  geometry: Pick<GeometryWorkerApi, 'sectionOutline'>,
  document: ProjectDocument,
  section: SectionViewSettings,
  liveSection: () => SectionViewSettings | undefined,
  liveVersion: () => number | null
): Promise<SectionOutlineState | null> {
  const version = document.version;
  const current = () => {
    const live = liveSection();
    return (
      live?.plane === section.plane &&
      live.offset === section.offset &&
      liveVersion() === version
    );
  };
  try {
    const report = await geometry.sectionOutline(
      document,
      sectionPlaneSpec(section)
    );
    return current() ? sectionOutlineFromReport(report) : null;
  } catch (error) {
    return current()
      ? {
          kind: 'refused',
          detail:
            error instanceof Error ? error.message : 'The exact section failed.'
        }
      : null;
  }
}

/**
 * Write the exact section — never the display caps — as a DXF drawing,
 * narrating both ends of it through `announce` (the status line).
 */
export async function writeSectionDxf(
  geometry: Pick<GeometryWorkerApi, 'exportModel'>,
  document: ProjectDocument,
  section: SectionViewSettings,
  save: (fileName: string, format: 'dxf', text: string) => Promise<boolean>,
  stem: string,
  announce: (message: string) => void
): Promise<void> {
  const fileName = `${stem}-section.dxf`;
  announce('Exporting the section as DXF…');
  try {
    const result = await geometry.exportModel('dxf', document, [], {
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
