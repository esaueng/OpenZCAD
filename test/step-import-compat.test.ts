import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { importedStepValidationWarning } from '../packages/kernel-adapter/src/imported-step-validation';

const DEGREE_TO_RADIAN = 0.0174532925199433;
const CONE_VOLUME_MM3 = (Math.PI * 10 * 10 * 10) / 3;

function declareDegrees(step: string): string {
  const angleUnit = /#(\d+)\s*=\s*\([^;]*PLANE_ANGLE_UNIT\s*\(\s*\)[^;]*SI_UNIT\s*\(\s*\$\s*,\s*\.RADIAN\.\s*\)[^;]*\);/i.exec(
    step
  );
  expect(angleUnit).toBeTruthy();
  const unitId = angleUnit![1]!;
  const degreeUnit = `#${unitId} = ( CONVERSION_BASED_UNIT('DEGREE',#900001) NAMED_UNIT(*) PLANE_ANGLE_UNIT() );`;

  const converted = step
    .replace(angleUnit![0], degreeUnit)
    .replace(
      /(CONICAL_SURFACE\s*\([^;]*,\s*)([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:E[+-]?\d+)?)(\s*\);)/gi,
      (_entity, prefix: string, angle: string, suffix: string) =>
        `${prefix}${(Number(angle) / DEGREE_TO_RADIAN).toPrecision(17)}${suffix}`
    );

  return converted.replace(
    /\nENDSEC;\s*\nEND-ISO-10303-21;/,
    `\n#900001 = PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(${DEGREE_TO_RADIAN}),#900002);\n#900002 = ( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) );\nENDSEC;\nEND-ISO-10303-21;`
  );
}

/**
 * A cone's half-angle is the one place a STEP plane-angle unit changes the
 * geometry, so a kernel that ignores `PLANE_ANGLE_UNIT` reads 45 RADIANS where
 * the file says 45 degrees and produces a wildly wrong cone.
 *
 * OpenZCAD used to defend against that in JavaScript: `step-import.ts` rewrote
 * CONICAL_SURFACE angles into radians before handing the text to the kernel.
 * Z3 deleted the rewriter because the kernel now reads the file's own declared
 * unit. This test is what makes that deletion checkable rather than assumed —
 * the SAME cone written two ways must read as the same solid, and the only
 * code between the file and the answer is the kernel.
 */
describe('STEP plane-angle compatibility', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('reads a DEGREE half-angle as the kernel-declared unit says', async () => {
    const source = addPrimitiveFeature(
      createProjectDocument('Degree cone source', toUserId('user_step_degrees')),
      {
        name: 'Degree cone',
        primitiveKind: 'cone',
        dimensions: { bottomRadius: 10, topRadius: 0, height: 10 }
      }
    );
    const radianStep = await adapter.exportStep(source, [source.bodyOrder[0]!]);
    const degreeStep = declareDegrees(radianStep);
    const degreeAngle = /CONICAL_SURFACE\s*\([^;]*,\s*([\d.E+-]+)\s*\);/i.exec(
      degreeStep
    );
    // The fixture really does say 45, not 0.785..., or it proves nothing.
    expect(Number(degreeAngle?.[1])).toBeCloseTo(45, 10);

    const manager = new CommandManager(
      createProjectDocument('Degree cone import', toUserId('user_step_degrees'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Imported degree cone',
        artifactId: 'artifact_degree_cone',
        sourceName: 'degree-cone.step',
        stepText: degreeStep
      })
    );

    const derived = await adapter.syncDocument(manager.document);
    const body = Object.values(derived.bodyRepresentations)[0];
    expect(derived.warnings).toEqual([]);
    expect(body?.source).toBe('imported-step');
    // pi * 10^2 * 10 / 3, to the digit. A kernel reading 45 radians does not
    // land near this by accident.
    expect(body?.volume).toBeCloseTo(CONE_VOLUME_MM3, 9);
    expect(body?.topology?.faces).toHaveLength(2);
    // The document stores the file as the user supplied it. Nothing in the
    // pipeline rewrites STEP text any more, and this is the assertion that
    // says so.
    expect(listFeaturesInOrder(manager.document)[0]?.data).toMatchObject({
      featureKind: 'imported-step',
      stepText: degreeStep
    });
    await expect(
      adapter.inspectStep(new TextEncoder().encode(degreeStep).buffer)
    ).resolves.toMatchObject({ solid: true, valid: true });
  });

  it('reads the same cone written in radians identically', async () => {
    const source = addPrimitiveFeature(
      createProjectDocument('Radian cone source', toUserId('user_step_degrees')),
      {
        name: 'Radian cone',
        primitiveKind: 'cone',
        dimensions: { bottomRadius: 10, topRadius: 0, height: 10 }
      }
    );
    const radianStep = await adapter.exportStep(source, [source.bodyOrder[0]!]);
    expect(radianStep).toMatch(/SI_UNIT\s*\(\s*\$\s*,\s*\.RADIAN\.\s*\)/i);

    const manager = new CommandManager(
      createProjectDocument('Radian cone import', toUserId('user_step_degrees'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Imported radian cone',
        artifactId: 'artifact_radian_cone',
        sourceName: 'radian-cone.step',
        stepText: radianStep
      })
    );

    const derived = await adapter.syncDocument(manager.document);
    const body = Object.values(derived.bodyRepresentations)[0];
    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeCloseTo(CONE_VOLUME_MM3, 9);
  });

  it('refuses a degree cone whose units are never bound to a context', async () => {
    // The rewriter never fired on this shape either — it required an
    // assigned context — so this is the case that always reached the kernel
    // raw. The
    // kernel refuses it by name rather than guessing a unit, which is the
    // behaviour the deletion has to preserve.
    const source = addPrimitiveFeature(
      createProjectDocument(
        'Unassigned cone source',
        toUserId('user_step_degrees')
      ),
      {
        name: 'Unassigned cone',
        primitiveKind: 'cone',
        dimensions: { bottomRadius: 10, topRadius: 0, height: 10 }
      }
    );
    const degreeStep = declareDegrees(
      await adapter.exportStep(source, [source.bodyOrder[0]!])
    );
    const unassigned = degreeStep.replace(
      /GLOBAL_UNIT_ASSIGNED_CONTEXT/g,
      'UNBOUND_UNIT_CONTEXT'
    );

    const manager = new CommandManager(
      createProjectDocument('Unassigned cone import', toUserId('user_step_degrees'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Imported unassigned cone',
        artifactId: 'artifact_unassigned_cone',
        sourceName: 'unassigned-cone.step',
        stepText: unassigned
      })
    );

    const derived = await adapter.syncDocument(manager.document);
    expect(derived.warnings).toEqual([
      'Feature "Imported unassigned cone": parse error: STEP file declares no ' +
        "LENGTH_UNIT in a GLOBAL_UNIT_ASSIGNED_CONTEXT; the model's length " +
        'unit is unknown'
    ]);
    expect(Object.keys(derived.bodyRepresentations)).toEqual([]);
  });
});

describe('STEP import validation diagnostics', () => {
  it('describes a partially invalid compound as an imported body', () => {
    expect(
      importedStepValidationWarning('Imported assembly', 1, 10, 'OpenCascade')
    ).toBe(
      'Body "Imported assembly" imported and rendered, but 1 of its 10 STEP solids ' +
        'has OpenCascade B-rep validity issues. Exact edits or booleans involving ' +
        'the affected solid may fail.'
    );
  });

  it('uses singular wording for one imported solid', () => {
    expect(
      importedStepValidationWarning('Imported part', 1, 1, 'OpenCascade')
    ).toContain(
      'but its STEP solid has OpenCascade B-rep validity issues'
    );
  });
});
