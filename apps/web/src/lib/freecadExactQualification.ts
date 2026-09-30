import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type UnitSystem } from '@openzcad/shared';

/**
 * Generated sources must be replayable AND exportable before they enter a
 * project. A valid OCCT solid is not proof of compatibility with the pinned
 * Remus reader. This preserves the original pcurves and refuses incompatibility.
 */
export async function qualifyFreecadStep(
  stepText: string,
  solidCount: number,
  units: UnitSystem
): Promise<void> {
  const adapter = await createExactKernelAdapter();
  try {
    const inspected = await adapter.inspectStep(stepText);
    if (!inspected.valid || inspected.solidIndices.length !== solidCount) {
      throw new Error(
        `ZCAD cannot import this FreeCAD geometry: ${inspected.reason ?? 'exact solid validation failed'}`
      );
    }
    const source = createProjectDocument(
      'FreeCAD import qualification',
      toUserId('user_freecad_import')
    );
    const imported = importStepBody(
      { ...source, units },
      {
        name: 'FreeCAD saved solids',
        sourceName: 'FreeCAD.step',
        artifactId: 'artifact_local_qualification',
        stepText
      }
    ).document;
    const rebuilt = await adapter.syncDocument(imported);
    if (
      rebuilt.warnings.length ||
      Object.keys(rebuilt.bodyRepresentations).length !== 1
    ) {
      throw new Error(
        `ZCAD cannot rebuild this FreeCAD geometry: ${rebuilt.warnings[0] ?? 'no exact body was produced'}`
      );
    }
    // The current project units matter: scaling a periodic pcurve can succeed
    // in the viewport and still fail the export endpoint certificate.
    const exported = await adapter.exportStep(imported, imported.bodyOrder);
    const roundtrip = await adapter.inspectStep(exported);
    if (!roundtrip.valid || roundtrip.solidIndices.length !== solidCount) {
      throw new Error(
        `ZCAD cannot round-trip this FreeCAD geometry: ${roundtrip.reason ?? 'exact STEP export validation failed'}`
      );
    }
  } finally {
    adapter.dispose();
  }
}
