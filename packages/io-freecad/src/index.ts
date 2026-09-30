import { OcctKernel, type InitOptions } from 'occt-wasm';
import { sanitizeStepHeaderPrivacy } from '@openzcad/io-step';
import { readFreecadShapes } from './document';
import { combineStepRoots } from './step';
import { FREECAD_IMPORT_LIMITS, type FreecadImportLimits } from './limits';

export { readFreecadShapes } from './document';
export { FREECAD_IMPORT_LIMITS, type FreecadImportLimits } from './limits';

/** OCCT is a disposable format converter; Remus remains ZCAD's modeling kernel. */
export async function convertFreecadToStep(
  bytes: Uint8Array,
  options: {
    wasm?: InitOptions['wasm'];
    limits?: FreecadImportLimits;
    onProgress?(message: string): void;
  } = {}
): Promise<{ stepText: string; savedObjectCount: number; solidCount: number }> {
  const limits = options.limits ?? FREECAD_IMPORT_LIMITS;
  const shapes = readFreecadShapes(bytes, limits);
  options.onProgress?.('Loading the FreeCAD geometry converter…');
  const kernel = await OcctKernel.init(
    options.wasm ? { wasm: options.wasm } : undefined
  );
  try {
    const roots: string[] = [];
    let solidCount = 0;
    let stepBytes = 0;
    for (const [index, saved] of shapes.entries()) {
      options.onProgress?.(
        `Converting saved body ${index + 1} of ${shapes.length}…`
      );
      const text = new TextDecoder('utf-8', { fatal: true }).decode(saved.brep);
      // Binary BREP and mesh payloads are deliberately refused in this first slice.
      if (
        !/^\s*(?:DBRep_DrawableShape\s+)?CASCADE Topology V[123],/.test(text)
      ) {
        throw new Error(
          'Unsupported FreeCAD BREP encoding. Export the model as STEP in FreeCAD.'
        );
      }
      let shape = kernel.fromBREP(text);
      for (const matrix of saved.parentPlacements)
        shape = kernel.transform(shape, matrix);
      const solids = kernel.getSubShapes(shape, 'solid');
      if (
        !solids.length ||
        solids.length + solidCount > limits.maxBodies ||
        !kernel.isValid(shape) ||
        solids.some(
          (solid) => !kernel.isValid(solid) || !(kernel.getVolume(solid) > 0)
        ) ||
        solids.reduce(
          (sum, solid) => sum + kernel.getSubShapes(solid, 'face').length,
          0
        ) !== kernel.getSubShapes(shape, 'face').length
      ) {
        throw new Error(
          'FreeCAD saved geometry is invalid or contains unsupported surface bodies. Export valid solids as STEP in FreeCAD.'
        );
      }
      solidCount += solids.length;
      const root = kernel.exportStep(shape);
      stepBytes += new TextEncoder().encode(root).byteLength;
      if (stepBytes > limits.maxStepBytes)
        throw new Error(
          'Converted FreeCAD geometry exceeds the STEP import limit.'
        );
      roots.push(root);
    }
    const stepText = sanitizeStepHeaderPrivacy(
      combineStepRoots(roots),
      'FreeCAD import.step'
    );
    if (new TextEncoder().encode(stepText).byteLength > limits.maxStepBytes) {
      throw new Error(
        'Converted FreeCAD geometry exceeds the STEP import limit.'
      );
    }
    return { stepText, savedObjectCount: shapes.length, solidCount };
  } finally {
    kernel[Symbol.dispose]();
  }
}
