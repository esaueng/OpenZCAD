import type { ProjectDocument, SketchId } from '@openzcad/shared';
import type { GeometryWorkerApi } from '../hooks/useGeometryWorker';

/**
 * Write one saved sketch — never a body outline or a section — as a DXF
 * drawing, narrating both ends of it through `announce` (the status line).
 *
 * This sits next to `writeSectionDxf` in `sectionOutline.ts` and calls the
 * export the same way: the adapter either writes the complete supported
 * sketch or refuses by name, and that refusal reads as the export's own
 * diagnostic, not as something to put in front of a user twice.
 */
export async function writeSketchDxf(
  geometry: Pick<GeometryWorkerApi, 'exportModel'>,
  document: ProjectDocument,
  sketchId: SketchId,
  save: (fileName: string, format: 'dxf', text: string) => Promise<boolean>,
  stem: string,
  announce: (message: string) => void
): Promise<void> {
  const fileName = `${stem}-sketch.dxf`;
  announce('Exporting the sketch as DXF…');
  try {
    // No bodies: a sketch export draws the sketch's own 2D geometry in its
    // plane, not anything built from it.
    const result = await geometry.exportModel('dxf', document, [], {
      sketchId
    });
    if (!('text' in result)) {
      throw new Error('The DXF export returned no text.');
    }
    const saved = await save(fileName, 'dxf', result.text);
    announce(
      saved ? `Exported the sketch to ${fileName}.` : 'DXF export cancelled.'
    );
  } catch (error) {
    announce(
      error instanceof Error ? error.message : 'Sketch DXF export failed.'
    );
  }
}
