import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  getLatestBodyId
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';

/**
 * Builds the walkthrough bracket (docs/walkthrough.md) end to end: parameters,
 * primitives, a transform, and chained booleans. This both regression-tests
 * the full parametric pipeline and regenerates the committed sample STEP file
 * when OPENZCAD_WRITE_SAMPLES=1 (`OPENZCAD_WRITE_SAMPLES=1 pnpm test`).
 */
function buildBracket() {
  const manager = new CommandManager(
    createProjectDocument('Parametric Bracket', toUserId('user_sample'))
  );
  manager.execute(
    commandFactories.setParameter({ name: 'w', expression: '60' })
  );
  manager.execute(
    commandFactories.setParameter({ name: 't', expression: '8' })
  );
  manager.execute(
    commandFactories.setParameter({ name: 'hole', expression: '6' })
  );

  manager.execute(
    commandFactories.addPrimitive({
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 'w', height: 't', depth: 'w / 2' }
    })
  );
  const plateBody = getLatestBodyId(manager.document)!;

  manager.execute(
    commandFactories.addPrimitive({
      name: 'Boss',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'hole * 2', height: 't * 3' }
    })
  );
  const bossBody = getLatestBodyId(manager.document)!;
  manager.execute(
    commandFactories.transformBody({
      name: 'Center boss',
      targetBodyId: bossBody,
      translation: { x: 'w / 2', y: 't / 2', z: 0 }
    })
  );

  manager.execute(
    commandFactories.booleanBodies({
      name: 'Plate + Boss',
      operation: 'union',
      targetBodyIds: [plateBody, bossBody]
    })
  );
  const unionBody = getLatestBodyId(manager.document)!;

  manager.execute(
    commandFactories.addPrimitive({
      name: 'Drill',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'hole', height: 't * 6' }
    })
  );
  const drillBody = getLatestBodyId(manager.document)!;
  manager.execute(
    commandFactories.transformBody({
      name: 'Center drill',
      targetBodyId: drillBody,
      translation: { x: 'w / 2', y: 't / 2', z: 0 }
    })
  );

  manager.execute(
    commandFactories.booleanBodies({
      name: 'Bracket',
      operation: 'subtract',
      targetBodyIds: [unionBody, drillBody]
    })
  );
  return { manager, bracketBody: getLatestBodyId(manager.document)! };
}

// Real-kernel suite: WASM startup plus a boolean rebuild and a STEP round trip
// run past the 5 s default under pool contention.
describe('walkthrough bracket sample', { timeout: 30_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('builds a watertight parametric bracket and exports valid STEP', async () => {
    const { manager, bracketBody } = buildBracket();
    const derived = await adapter.syncDocument(manager.document);
    // The centered boss and coaxial drill keep their analytic cylindrical
    // surfaces through both booleans. This also pins the generated sample as
    // an exact STEP artifact instead of the old 20k-line faceted fallback.
    expect(derived.warnings).toEqual([]);
    const bracket = derived.bodyRepresentations[bracketBody]!;
    const curvedFaces = (bracket.topology?.faces ?? []).filter(
      (face) => face.geometry && face.geometry.surfaceType !== 'plane'
    );
    expect(bracket.faceCount).toBe(14);
    expect(curvedFaces).toHaveLength(3);
    expect(
      curvedFaces.every((face) => face.geometry?.surfaceType === 'cylinder')
    ).toBe(true);
    expect(bracket.consumed).toBe(false);
    expect(derived.exportableBodyIds).toEqual([bracketBody]);

    // Plate 60x8x30 plus the centered boss outside its footprint, minus the
    // coaxial drill through both.
    expect(bracket.volume).toBeGreaterThan(60 * 8 * 30);
    const text = await adapter.exportStep(manager.document, [bracketBody]);
    expect(text).toContain('MANIFOLD_SOLID_BREP');
    // The exported file must reimport as one closed solid of the same size.
    const reimported = await adapter.inspectStep(text);
    expect(reimported.solid).toBe(true);
    expect(reimported.valid).toBe(true);
    expect(reimported.volume).toBeCloseTo(bracket.volume, 3);

    const samplePath = resolve('samples/parametric-bracket.step');
    if (process.env.OPENZCAD_WRITE_SAMPLES === '1') {
      writeFileSync(samplePath, text);
    } else {
      expect(text).toBe(readFileSync(samplePath, 'utf8'));
    }
  });
});
