import { writeFileSync } from 'node:fs';
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
      name: 'Raise boss',
      targetBodyId: bossBody,
      translation: { x: 0, y: 't', z: 0 }
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
    // The face-count census exposes something this sample has always done
    // silently: fusing the cylindrical boss onto the plate returns a faceted
    // approximation. Six planar faces plus one cylinder become 69 planar
    // faces and no curved ones, and the volume lands ~0.06 % low
    // (23124.47 against an exact 23137.6). The boss visibly protrudes, so a
    // correct union could not possibly have zero curved faces. Subtracting
    // the drill from that already-faceted body facets the bore too.
    //
    // The committed samples/parametric-bracket.step is therefore faceted.
    // The assertions below are recording what the kernel does today, not
    // endorsing it — see the Phase 3 report.
    expect(derived.warnings).toEqual([
      expect.stringContaining(
        'Feature "Plate + Boss": The boolean returned a faceted approximation'
      ),
      expect.stringContaining(
        'Feature "Bracket": The boolean replaced every curved surface'
      )
    ]);
    const bracket = derived.bodyRepresentations[bracketBody]!;
    expect(bracket.consumed).toBe(false);
    expect(derived.exportableBodyIds).toEqual([bracketBody]);

    // Plate 60x8x30 + boss above the plate - drilled hole through both.
    expect(bracket.volume).toBeGreaterThan(60 * 8 * 30);
    const text = await adapter.exportStep(manager.document, [bracketBody]);
    expect(text).toContain('MANIFOLD_SOLID_BREP');
    // The exported file must reimport as one closed solid of the same size.
    const reimported = await adapter.inspectStep(text);
    expect(reimported.solid).toBe(true);
    expect(reimported.valid).toBe(true);
    expect(reimported.volume).toBeCloseTo(bracket.volume, 3);

    if (process.env.OPENZCAD_WRITE_SAMPLES === '1') {
      writeFileSync(resolve('samples/parametric-bracket.step'), text);
    }
  });
});
