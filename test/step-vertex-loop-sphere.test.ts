import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

// Issue #1245: a whole r10 sphere written as one ADVANCED_FACE whose only
// bound is a pole VERTEX_LOOP. The fixture is OCCT's own AP214 export of
// BRepPrimAPI_MakeSphere(10) (cadquery-ocp, 32 entities), the same layout the
// issue's FreeCAD export used; only the FILE_NAME timestamp is pinned.
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const SPHERE_STEP = fixture('step/vertex-loop-sphere.step');
const SPHERE_VOLUME = (4 / 3) * Math.PI * 10 ** 3; // ≈ 4188.7902 mm³

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / expected;
}

it('keeps the fixture in the reported pole VERTEX_LOOP layout', () => {
  expect(SPHERE_STEP).toContain("#19 = VERTEX_LOOP('',#20);");
  expect(SPHERE_STEP).toContain("#18 = FACE_BOUND('',#19,.T.);");
  expect(SPHERE_STEP).toContain("#22 = SPHERICAL_SURFACE('',#23,10.);");
  expect(SPHERE_STEP.match(/ADVANCED_FACE\(/g)).toHaveLength(1);
  expect(SPHERE_STEP).not.toMatch(/EDGE_LOOP|EDGE_CURVE/);
  expect(SPHERE_STEP.match(/^#\d+ =/gm)).toHaveLength(32);
});

it('imports a pole VERTEX_LOOP sphere as one closed solid beside the existing model and keeps later imports usable', async () => {
  const adapter = await createExactKernelAdapter();
  try {
    const preflight = await adapter.inspectStep(SPHERE_STEP);
    expect(preflight).toMatchObject({
      solid: true,
      valid: true,
      solidIndices: [0]
    });
    // Exact analytic sphere: the kernel volume matches 4/3·π·r³ closely.
    expect(relativeError(preflight.volume, SPHERE_VOLUME)).toBeLessThan(1e-9);

    const manager = new CommandManager(
      createProjectDocument('Pole sphere', toUserId('user_sphere'))
    );
    const importStep = (name: string, sourceName: string, stepText: string) =>
      manager.execute(
        commandFactories.importStep({
          name,
          artifactId: `artifact_${name.toLowerCase()}`,
          sourceName,
          stepText
        })
      );

    // The current model: an independently authored box.
    importStep(
      'Box',
      'a-export-box.step',
      fixture('../parity/corpus/a-export-box.step')
    );
    const before = await adapter.syncDocument(manager.document);
    expect(before.warnings).toEqual([]);
    const [boxId] = manager.document.bodyOrder;
    const boxVolume = before.bodyRepresentations[boxId!]!.volume;
    expect(boxVolume).toBeGreaterThan(0);

    importStep('Sphere', 'vertex-loop-sphere.step', SPHERE_STEP);
    const withSphere = await adapter.syncDocument(manager.document);
    expect(withSphere.warnings).toEqual([]);
    expect(manager.document.bodyOrder).toHaveLength(2);
    const sphereId = manager.document.bodyOrder[1]!;
    const sphere = withSphere.bodyRepresentations[sphereId]!;
    expect(sphere.source).toBe('imported-step');
    expect(relativeError(sphere.volume, SPHERE_VOLUME)).toBeLessThan(1e-9);
    expect(withSphere.bodyRepresentations[boxId!]!.volume).toBe(boxVolume);

    // The sphere re-exports without the vertex loop and re-reads as one
    // valid closed solid of the same volume.
    const exported = await adapter.exportStep(manager.document, [sphereId]);
    expect(exported).not.toContain('VERTEX_LOOP');
    const reread = await adapter.inspectStep(exported);
    expect(reread).toMatchObject({ solid: true, valid: true });
    expect(relativeError(reread.volume, SPHERE_VOLUME)).toBeLessThan(1e-9);

    // A following, independently authored cylinder import still works.
    importStep(
      'Cylinder',
      'a-export-cylinder.step',
      fixture('../parity/corpus/a-export-cylinder.step')
    );
    const after = await adapter.syncDocument(manager.document);
    expect(after.warnings).toEqual([]);
    expect(manager.document.bodyOrder).toHaveLength(3);
    for (const bodyId of manager.document.bodyOrder) {
      expect(after.bodyRepresentations[bodyId]!.volume).toBeGreaterThan(0);
    }
    expect(after.bodyRepresentations[boxId!]!.volume).toBe(boxVolume);
    expect(
      relativeError(after.bodyRepresentations[sphereId]!.volume, SPHERE_VOLUME)
    ).toBeLessThan(1e-9);
  } finally {
    adapter.dispose();
  }
}, 60_000);

it('still refuses a vertex loop that is off its spherical surface, naming the entity, and keeps the model', async () => {
  const offSurface = SPHERE_STEP.replace(
    "#21 = CARTESIAN_POINT('',(6.123233995737E-16,-1.499759782662E-31,-10.));",
    "#21 = CARTESIAN_POINT('',(0.,0.,-12.));"
  );
  expect(offSurface).not.toBe(SPHERE_STEP);
  const adapter = await createExactKernelAdapter();
  try {
    const preflight = await adapter.inspectStep(offSurface);
    expect(preflight).toMatchObject({ solid: false, valid: false });
    expect(preflight.reason).toMatch(
      /VERTEX_LOOP #19\b.*off SPHERICAL_SURFACE #22/
    );

    const manager = new CommandManager(
      createProjectDocument('Refused sphere', toUserId('user_sphere'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Sphere',
        artifactId: 'artifact_sphere',
        sourceName: 'vertex-loop-sphere.step',
        stepText: SPHERE_STEP
      })
    );
    const sphereId = manager.document.bodyOrder[0]!;
    manager.execute(
      commandFactories.importStep({
        name: 'Broken',
        artifactId: 'artifact_broken',
        sourceName: 'off-surface.step',
        stepText: offSurface
      })
    );
    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toMatch(/VERTEX_LOOP #19\b/);
    expect(
      relativeError(
        derived.bodyRepresentations[sphereId]!.volume,
        SPHERE_VOLUME
      )
    ).toBeLessThan(1e-9);
  } finally {
    adapter.dispose();
  }
}, 60_000);
