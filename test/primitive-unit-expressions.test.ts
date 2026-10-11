import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type ParamValue,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import { featureValueSummary } from '../apps/web/src/lib/featureSummary';
import { previewExpression } from '../apps/web/src/lib/model';

/**
 * Production QA CAD-004 (2026-10-11), ROADMAP F05: in an inch project the Box
 * form refused `1 in + 25.4 mm` and `50.8 mm` as "needs the document's units",
 * because the field preview and the kernel's primitive build evaluated without
 * them. A primitive size is a length, so preview, build and summary now all
 * resolve it in the document's units, and the field refuses an angle or area
 * typed there.
 */
const user = toUserId('user_primitive_units');

function boxCommand(dimensions: Record<string, ParamValue>) {
  return commandFactories.addPrimitive({
    name: 'Imperial fixture',
    primitiveKind: 'box',
    dimensions
  });
}

describe('primitive sizes typed with units', { timeout: 60_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => adapter.dispose());

  async function build(
    units: UnitSystem,
    dimensions: Record<string, ParamValue>
  ) {
    const manager = new CommandManager(
      createProjectDocument(`Units ${units}`, user, units)
    );
    manager.execute(boxCommand(dimensions));
    const document = manager.document;
    const derived = await adapter.syncDocument(document);
    return { manager, document, derived, bodyId: document.bodyOrder[0]! };
  }

  it('previews the QA inputs in an inch document as the kernel builds them', async () => {
    const length = { documentUnits: 'inch', dimension: 'length' } as const;
    expect(previewExpression('1 in + 25.4 mm', {}, length)).toMatchObject({
      ok: true,
      value: 2
    });
    expect(previewExpression('50.8 mm', {}, length)).toMatchObject({
      ok: true
    });
    // Untyped fields keep refusing a suffix rather than guessing a unit.
    expect(previewExpression('50.8 mm', {}).ok).toBe(false);

    const { derived, bodyId, document } = await build('inch', {
      width: '1 in + 25.4 mm',
      height: '25.4 mm',
      depth: '0.5'
    });
    const body = derived.bodyRepresentations[bodyId]!;
    expect(derived.warnings).toEqual([]);
    expect(body.bbox.max.x - body.bbox.min.x).toBeCloseTo(2, 9);
    expect(body.bbox.max.y - body.bbox.min.y).toBeCloseTo(1, 9);
    expect(body.bbox.max.z - body.bbox.min.z).toBeCloseTo(0.5, 9);
    expect(body.volume).toBeCloseTo(1, 9);
    const feature = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.name === 'Imperial fixture'
    );
    expect(feature?.kind).toBe('feature');
    if (feature?.kind === 'feature')
      expect(featureValueSummary(feature, {}, 'inch')).toBe('2 × 1 × 0.5 in');
  });

  it('builds the same body from equivalent inputs in a millimetre document', async () => {
    const { derived, bodyId } = await build('mm', {
      width: '1 in + 25.4 mm',
      height: '1 in',
      depth: '12.7'
    });
    const body = derived.bodyRepresentations[bodyId]!;
    expect(derived.warnings).toEqual([]);
    expect(body.bbox.max.x - body.bbox.min.x).toBeCloseTo(50.8, 9);
    expect(body.volume).toBeCloseTo(16_387.064, 6);
  });

  it('refuses an angle typed into a size at the field', () => {
    // The field refuses it before any command exists. (The kernel build does
    // not repeat the dimension check: see buildPrimitive.)
    const length = { documentUnits: 'inch', dimension: 'length' } as const;
    for (const input of ['30 deg', '(2 mm) * (3 mm)']) {
      const preview = previewExpression(input, {}, length);
      expect(preview.ok).toBe(false);
      expect(preview.text).toBe(
        'Incompatible dimensions in expression: expected a length, not an angle or area.'
      );
    }
  });

  it('keeps the size through undo, redo, reload and STEP export', async () => {
    const { manager, bodyId } = await build('inch', {
      width: '1 in + 25.4 mm',
      height: '25.4 mm',
      depth: '0.5'
    });
    const size = async (document: ProjectDocument) => {
      const body = (await adapter.syncDocument(document)).bodyRepresentations[
        bodyId
      ];
      return body ? body.bbox.max.x - body.bbox.min.x : null;
    };
    manager.undo();
    expect(await size(manager.document)).toBeNull();
    manager.redo();
    expect(await size(manager.document)).toBeCloseTo(2, 9);
    const reloaded = JSON.parse(
      JSON.stringify(manager.document)
    ) as ProjectDocument;
    expect(await size(reloaded)).toBeCloseTo(2, 9);

    // STEP carries millimetres: a 2 × 1 × 0.5 in box reimports into a
    // millimetre document as 50.8 × 25.4 × 12.7.
    const step = await adapter.exportStep(reloaded, [bodyId]);
    const roundTrip = importStepBody(
      createProjectDocument('Imperial STEP', user, 'mm'),
      {
        name: 'Imperial box',
        artifactId: 'artifact_imperial_box',
        sourceName: 'imperial-box.step',
        stepText: step
      }
    ).document;
    const imported = await adapter.syncDocument(roundTrip);
    const body = imported.bodyRepresentations[roundTrip.bodyOrder[0]!]!;
    expect(imported.warnings).toEqual([]);
    expect(body.bbox.max.x - body.bbox.min.x).toBeCloseTo(50.8, 6);
    expect(body.bbox.max.y - body.bbox.min.y).toBeCloseTo(25.4, 6);
    expect(body.bbox.max.z - body.bbox.min.z).toBeCloseTo(12.7, 6);
    expect(body.volume).toBeCloseTo(16_387.064, 3);
  });
});
