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
import { normalizeStepPlaneAnglesForKernel } from '../packages/kernel-adapter/src/step-import';

const DEGREE_TO_RADIAN = 0.0174532925199433;

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

describe('STEP plane-angle compatibility', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('converts degree CONICAL_SURFACE values only for transient kernel input', async () => {
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
    expect(Number(degreeAngle?.[1])).toBeCloseTo(45, 10);

    const normalized = normalizeStepPlaneAnglesForKernel(degreeStep);
    const normalizedAngle = /CONICAL_SURFACE\s*\([^;]*,\s*([\d.E+-]+)\s*\);/i.exec(
      normalized
    );
    expect(Number(normalizedAngle?.[1])).toBeCloseTo(
      Number(degreeAngle?.[1]) * DEGREE_TO_RADIAN,
      12
    );
    expect(degreeStep).toContain(degreeAngle![0]);

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
    expect(body?.volume).toBeGreaterThan(0);
    expect(listFeaturesInOrder(manager.document)[0]?.data).toMatchObject({
      featureKind: 'imported-step',
      stepText: degreeStep
    });
    await expect(
      adapter.inspectStep(new TextEncoder().encode(degreeStep).buffer)
    ).resolves.toMatchObject({ solid: true, valid: true });
  });

  it('leaves radian and ambiguous unit contexts unchanged', () => {
    const radian = `ISO-10303-21;\nDATA;\n#1=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));\n#2=(GLOBAL_UNIT_ASSIGNED_CONTEXT((#1))REPRESENTATION_CONTEXT('',''));\n#3=CONICAL_SURFACE('',#4,10.,0.7853981633974483);\nENDSEC;\nEND-ISO-10303-21;\n`;
    expect(normalizeStepPlaneAnglesForKernel(radian)).toBe(radian);

    const noContext = `ISO-10303-21;\nDATA;\n#1=(CONVERSION_BASED_UNIT('DEGREE',#2)NAMED_UNIT(*)PLANE_ANGLE_UNIT());\n#2=PLANE_ANGLE_MEASURE_WITH_UNIT(PLANE_ANGLE_MEASURE(${DEGREE_TO_RADIAN}),#3);\n#3=CONICAL_SURFACE('',#4,10.,45.);\nENDSEC;\nEND-ISO-10303-21;\n`;
    expect(normalizeStepPlaneAnglesForKernel(noContext)).toBe(noContext);
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
