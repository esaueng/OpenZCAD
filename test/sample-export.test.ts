import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, getLatestBodyId } from '@openzcad/document-core';
import { createKernelAdapter, OpenZCADKernel } from '@openzcad/kernel-adapter';
import { writeStepFile } from '@openzcad/io-step';
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
  manager.execute(commandFactories.setParameter({ name: 'w', expression: '60' }));
  manager.execute(commandFactories.setParameter({ name: 't', expression: '8' }));
  manager.execute(commandFactories.setParameter({ name: 'hole', expression: '6' }));

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

describe('walkthrough bracket sample', () => {
  it('builds a watertight parametric bracket and exports valid STEP', () => {
    const { manager, bracketBody } = buildBracket();
    const kernel = createKernelAdapter();
    const derived = kernel.syncDocument(manager.document);
    expect(derived.warnings).toEqual([]);
    const bracket = derived.bodyRepresentations[bracketBody]!;
    expect(bracket.consumed).toBe(false);
    expect(derived.exportableBodyIds).toEqual([bracketBody]);

    // Plate 60x8x30 + boss above the plate - drilled hole through both.
    expect(bracket.volume).toBeGreaterThan(60 * 8 * 30);
    const { text, warnings } = kernel.exportStep(manager.document, [bracketBody]);
    expect(warnings).toEqual([]);
    expect(text).toContain('MANIFOLD_SOLID_BREP');

    if (process.env.OPENZCAD_WRITE_SAMPLES === '1') {
      const { solids } = new OpenZCADKernel().buildSolids(manager.document);
      const deterministic = writeStepFile(
        [{ name: 'Parametric Bracket', solid: solids.get(bracketBody)! }],
        {
          name: 'Parametric Bracket',
          units: 'mm',
          timestamp: '2026-01-01T00:00:00.000Z'
        }
      );
      writeFileSync(resolve('samples/parametric-bracket.step'), deterministic.text);
    }
  });
});
