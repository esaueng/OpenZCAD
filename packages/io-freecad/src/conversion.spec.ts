import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { OcctKernel } from 'occt-wasm';
import { convertFreecadToStep } from './index';

function archive(brep: string, extra = ''): Uint8Array {
  return zipSync({
    'Document.xml': strToU8(
      `<Document SchemaVersion="4"><Objects><Object name="Body" type="PartDesign::Body"/></Objects><ObjectData><Object name="Body"><Properties><Property name="Shape" type="Part::PropertyPartShape"><Part file="Body.brp"/></Property>${extra}</Properties></Object></ObjectData></Document>`
    ),
    'Body.brp': strToU8(brep)
  });
}
describe('FreeCAD exact BREP conversion', () => {
  let kernel: OcctKernel;
  beforeAll(async () => {
    kernel = await OcctKernel.init();
  });
  afterAll(() => kernel[Symbol.dispose]());
  it('preserves a bored solid and its saved placement through STEP', async () => {
    const box = kernel.makeBox(20, 30, 40);
    const bore = kernel.makeCylinder(3, 40);
    const solid = kernel.translate(
      kernel.cut(box, kernel.translate(bore, 10, 15, 0)),
      5,
      7,
      9
    );
    const result = await convertFreecadToStep(
      archive(
        kernel.toBREP(solid),
        '<Property name="Placement"><PropertyPlacement Px="5" Py="7" Pz="9" Q0="0" Q1="0" Q2="0" Q3="1"/></Property>'
      )
    );
    const roundtrip = kernel.importStep(result.stepText);
    expect(result.solidCount).toBe(1);
    expect(kernel.isValid(roundtrip)).toBe(true);
    expect(
      Math.abs(kernel.getVolume(roundtrip) / kernel.getVolume(solid) - 1)
    ).toBeLessThan(1e-10);
    expect(
      Math.abs(
        kernel.getSurfaceArea(roundtrip) / kernel.getSurfaceArea(solid) - 1
      )
    ).toBeLessThan(1e-10);
    const bounds = kernel.getBoundingBox(roundtrip);
    expect(bounds.xmin).toBeCloseTo(5, 6);
    expect(bounds.ymin).toBeCloseTo(7, 6);
    expect(bounds.zmin).toBeCloseTo(9, 6);
    expect(result.stepText).not.toMatch(
      /Open CASCADE Shape Processor|\/tmp\/export|\/Users\//
    );
  });
  it('rejects a wire and a solid mixed with a surface instead of silently dropping geometry', async () => {
    const solid = kernel.makeBox(10, 10, 10);
    const face = kernel.getSubShapes(solid, 'face')[0]!;
    await expect(
      convertFreecadToStep(archive(kernel.toBREP(face)))
    ).rejects.toThrow(/surface bodies/);
    await expect(
      convertFreecadToStep(
        archive(
          kernel.toBREP(
            kernel.makeCompound([solid, kernel.translate(face, 30, 0, 0)])
          )
        )
      )
    ).rejects.toThrow(/surface bodies/);
  });
  it('rejects unsupported encodings and excessive converted output', async () => {
    await expect(
      convertFreecadToStep(archive('binary or corrupt'))
    ).rejects.toThrow(/encoding/);
    const { FREECAD_IMPORT_LIMITS } = await import('./limits');
    await expect(
      convertFreecadToStep(archive(kernel.toBREP(kernel.makeBox(1, 2, 3))), {
        limits: { ...FREECAD_IMPORT_LIMITS, maxStepBytes: 1 }
      })
    ).rejects.toThrow(/STEP import limit/);
  });
});
