import type { BodyId, ProjectDocument, UnitSystem } from '@openzcad/shared';
import type { GeometryWorkerApi } from '../hooks/useGeometryWorker';

/**
 * L09: File › CNC cut layout — the export's bodies laid flat on their
 * largest flat faces, their upward faces as exact DXF outlines, one layer
 * per face height, arranged apart in rows and labelled. Lazy, so the
 * workspace's entry chunk carries none of it. Parts that cannot lie flat
 * are named in the status; with none left the adapter refuses by name and
 * that refusal is the status.
 */
export async function writeCncLayoutDxf(input: {
  geometry: Pick<GeometryWorkerApi, 'exportModel'>;
  target: {
    document: ProjectDocument;
    bodyIds: BodyId[];
    allShownBodies: boolean;
  };
  units: UnitSystem;
  stem: string;
  save: (fileName: string, format: 'dxf', text: string) => Promise<boolean>;
  announce: (message: string) => void;
}): Promise<void> {
  const fileName = `${input.stem}-cnc.dxf`;
  input.announce('Laying the parts flat for a CNC cut layout…');
  try {
    const result = await input.geometry.exportModel(
      'dxf',
      input.target.document,
      input.target.bodyIds,
      {
        units: input.units,
        cncLayout: {},
        ...(input.target.allShownBodies ? { allShownBodies: true } : {})
      }
    );
    if (!('text' in result)) {
      throw new Error('The CNC layout export returned no text.');
    }
    const saved = await input.save(fileName, 'dxf', result.text);
    if (!saved) {
      input.announce('CNC layout export cancelled.');
      return;
    }
    const leftOut = result.warnings.length
      ? ` Left out: ${result.warnings.join('; ')}.`
      : '';
    input.announce(
      `Exported the CNC cut layout to ${fileName}, one layer per face height.${leftOut}`
    );
  } catch (error) {
    input.announce(
      error instanceof Error ? error.message : 'CNC layout export failed.'
    );
  }
}
