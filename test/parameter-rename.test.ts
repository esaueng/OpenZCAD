import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  directEditBody,
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listParameters,
  renameParameter,
  resolveParamValue,
  setParameter
} from '@openzcad/document-core';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  replayCommands
} from '@openzcad/command-system';
import {
  createCadDocumentDigest,
  parseCadPatchProposal,
  validateCadPatchProposalAgainstDigest
} from '@openzcad/ai-contracts';
import { toUserId } from '@openzcad/shared';

/**
 * Renaming a parameter used to be impossible: the panel only edits the
 * expression, and the AI patch schema had no rename or delete operation, so
 * "overhaul my parameters" could not be expressed at all. The rename must
 * rewrite every reading expression atomically or the readers are stranded on
 * the old name.
 */

const USER = toUserId('user_param_rename');

function documentWithReaders() {
  let document = createProjectDocument('Rename', USER, 'mm');
  document = setParameter(document, { name: 'w', expression: '40' });
  document = setParameter(document, { name: 'twice', expression: 'w * 2' });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'w * 10 + 2e3', height: 12, depth: 'twice' }
  });
  const created = addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [{ objectKind: 'circle', centerX: 0, centerY: 0, radius: 'w / 4' }]
  });
  return { document: created.document, sketchId: created.sketchId };
}

describe('renameParameter', () => {
  it('renames the node and rewrites every reading expression', () => {
    const { document, sketchId } = documentWithReaders();
    const renamed = renameParameter(document, {
      name: 'w',
      newName: 'plate_width'
    });

    const names = listParameters(renamed).map((parameter) => parameter.name);
    expect(names).toContain('plate_width');
    expect(names).not.toContain('w');
    expect(
      listParameters(renamed).find((entry) => entry.name === 'twice')
        ?.expression
    ).toBe('plate_width * 2');

    const plate = listFeaturesInOrder(renamed).find(
      (feature) => feature.name === 'Plate'
    );
    expect(plate?.data).toMatchObject({
      // The 2e3 literal must survive: `e3` inside it is an exponent, not an
      // identifier, even when a parameter of that name could exist.
      dimensions: { width: 'plate_width * 10 + 2e3', depth: 'twice' }
    });

    const sketch = findSketch(renamed, sketchId)!;
    const circle = renamed.nodes[sketch.objectIds[0]!];
    expect(circle?.kind === 'sketch-object' && circle.data).toMatchObject({
      radius: 'plate_width / 4'
    });

    const { scope } = getParameterScope(renamed);
    expect(scope.plate_width).toBe(40);
    expect(scope.twice).toBe(80);
    expect(scope.w).toBeUndefined();
  });

  it('refuses collisions, unknown names, and invalid names', () => {
    const { document } = documentWithReaders();
    expect(() =>
      renameParameter(document, { name: 'w', newName: 'twice' })
    ).toThrow(/already exists/);
    expect(() =>
      renameParameter(document, { name: 'missing', newName: 'anything' })
    ).toThrow(/not found/);
    expect(() =>
      renameParameter(document, { name: 'w', newName: 'pi' })
    ).toThrow(/not a valid parameter name/);
    expect(() =>
      renameParameter(document, { name: 'w', newName: '2wide' })
    ).toThrow(/not a valid parameter name/);
  });

  it('replays a serialized parameter.rename command', () => {
    const { document } = documentWithReaders();
    const command = commandFactories.renameParameter({
      name: 'w',
      newName: 'plate_width'
    });
    const applied = command.apply(document);
    const replayed = replayCommands(document, [command.serialize()]);
    expect(listParameters(replayed).map((parameter) => parameter.name)).toEqual(
      listParameters(applied).map((parameter) => parameter.name)
    );
  });
});

describe('parameter patch operations', () => {
  it('renames, rebinds, and deletes parameters through one proposal', () => {
    const { document } = documentWithReaders();
    const manager = new CommandManager(document);
    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_overhaul',
      summary: 'Overhaul the parameters.',
      assumptions: [],
      operations: [
        { kind: 'rename_parameter', name: 'w', newName: 'plate_width' },
        { kind: 'set_parameter', name: 'plate_height', expression: '12' },
        {
          kind: 'set_feature_dimension',
          featureId: listFeaturesInOrder(document).find(
            (feature) => feature.name === 'Plate'
          )!.featureId,
          field: 'height',
          value: 'plate_height'
        }
      ]
    });
    manager.runTransaction(
      'Apply AI patch',
      commandsForCadPatch(manager.document, proposal)
    );

    const names = listParameters(manager.document).map(
      (parameter) => parameter.name
    );
    expect(names).toEqual(
      expect.arrayContaining(['plate_width', 'plate_height', 'twice'])
    );
    expect(names).not.toContain('w');
  });

  it('deletes a parameter once the same proposal rebinds its reader', () => {
    let document = createProjectDocument('Delete', USER, 'mm');
    document = setParameter(document, { name: 'legacy', expression: '5' });
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'legacy', height: 5, depth: 5 }
    });
    const featureId = listFeaturesInOrder(document)[0]!.featureId;
    const manager = new CommandManager(document);
    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_freeze',
      summary: 'Freeze the width and drop the parameter.',
      assumptions: [],
      operations: [
        { kind: 'set_feature_dimension', featureId, field: 'width', value: 5 },
        { kind: 'delete_parameter', name: 'legacy' }
      ]
    });
    manager.runTransaction(
      'Apply AI patch',
      commandsForCadPatch(manager.document, proposal)
    );
    expect(listParameters(manager.document)).toHaveLength(0);
  });

  it('keeps earlier renames when later edits update the same direct feature', () => {
    let document = createProjectDocument('Hole cleanup', USER, 'mm');
    document = setParameter(document, {
      name: 'm4_hole_1_radius',
      expression: '2.25'
    });
    document = setParameter(document, {
      name: 'm4_hole_1_depth',
      expression: '8'
    });
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 80, height: 60, depth: 6 }
    });
    const plateBodyId = document.bodyOrder.at(-1)!;
    document = directEditBody(document, {
      name: 'M4 Hole 1',
      targetBodyId: plateBodyId,
      operation: {
        kind: 'resize-imported-blind-hole',
        faceHash: 101,
        sourceOpeningPoint: { x: 10, y: 10, z: 6 },
        sourceAxisDirection: { x: 0, y: 0, z: -1 },
        sourceDiameter: 4.5,
        sourceDepth: 8,
        diameter: 'm4_hole_1_radius * 2',
        depth: 'm4_hole_1_depth'
      }
    }).document;
    const hole = listFeaturesInOrder(document).at(-1)!;
    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_hole_cleanup',
      summary: 'Consolidate the M4 hole dimensions.',
      assumptions: [],
      preserveGeometry: true,
      operations: [
        {
          kind: 'rename_parameter',
          name: 'm4_hole_1_radius',
          newName: 'm4_hole_radius'
        },
        {
          kind: 'rename_parameter',
          name: 'm4_hole_1_depth',
          newName: 'm4_hole_depth'
        },
        {
          kind: 'set_feature_dimension',
          featureId: hole.featureId,
          field: 'diameter',
          value: 'm4_hole_radius * 2'
        },
        {
          kind: 'set_feature_dimension',
          featureId: hole.featureId,
          field: 'depth',
          value: 'm4_hole_depth'
        }
      ]
    });

    const manager = new CommandManager(document);
    manager.runTransaction(
      'Apply AI patch',
      commandsForCadPatch(manager.document, proposal)
    );

    expect(listFeaturesInOrder(manager.document).at(-1)?.data).toMatchObject({
      featureKind: 'direct-edit',
      operation: {
        diameter: 'm4_hole_radius * 2',
        depth: 'm4_hole_depth'
      }
    });
    expect(listParameters(manager.document).map(({ name }) => name)).toEqual([
      'm4_hole_radius',
      'm4_hole_depth'
    ]);
  });

  it('consolidates a high-cardinality hole layout without reviving stale parameters', () => {
    let document = createProjectDocument('M4 hole grid', USER, 'mm');
    const plateParameters = {
      plate_width: '120',
      plate_height: '80',
      plate_thickness: '6',
      cutout_width: '40',
      cutout_height: '24'
    };
    for (const [name, expression] of Object.entries(plateParameters)) {
      document = setParameter(document, { name, expression });
    }
    for (let holeNumber = 1; holeNumber <= 8; holeNumber += 1) {
      const column = (holeNumber - 1) % 4;
      const row = Math.floor((holeNumber - 1) / 4);
      for (const [suffix, expression] of Object.entries({
        radius: '2.25',
        depth: '8',
        x: String(15 + column * 30),
        y: String(20 + row * 40),
        z: '6'
      })) {
        document = setParameter(document, {
          name: `m4_hole_${holeNumber}_${suffix}`,
          expression
        });
      }
    }
    expect(listParameters(document)).toHaveLength(45);

    document = addPrimitiveFeature(document, {
      name: 'Mounting plate',
      primitiveKind: 'box',
      dimensions: {
        width: 'plate_width',
        height: 'plate_height',
        depth: 'plate_thickness'
      }
    });
    const plateBodyId = document.bodyOrder.at(-1)!;
    for (let holeNumber = 1; holeNumber <= 8; holeNumber += 1) {
      const column = (holeNumber - 1) % 4;
      const row = Math.floor((holeNumber - 1) / 4);
      document = directEditBody(document, {
        name: `M4 Hole ${holeNumber}`,
        targetBodyId: plateBodyId,
        operation: {
          kind: 'resize-imported-blind-hole',
          faceHash: 100 + holeNumber,
          sourceOpeningPoint: {
            x: 15 + column * 30,
            y: 20 + row * 40,
            z: 6
          },
          sourceAxisDirection: { x: 0, y: 0, z: -1 },
          sourceDiameter: 4.5,
          sourceDepth: 8,
          diameter: `m4_hole_${holeNumber}_radius * 2`,
          depth: `m4_hole_${holeNumber}_depth`
        }
      }).document;
    }
    const holes = listFeaturesInOrder(document).filter(
      (feature) => feature.data.featureKind === 'direct-edit'
    );
    expect(holes).toHaveLength(8);

    const operations: Array<Record<string, unknown>> = [
      {
        kind: 'rename_parameter',
        name: 'm4_hole_1_radius',
        newName: 'm4_hole_radius'
      },
      {
        kind: 'rename_parameter',
        name: 'm4_hole_1_depth',
        newName: 'm4_hole_depth'
      }
    ];
    for (const hole of holes) {
      operations.push(
        {
          kind: 'set_feature_dimension',
          featureId: hole.featureId,
          field: 'diameter',
          value: 'm4_hole_radius * 2'
        },
        {
          kind: 'set_feature_dimension',
          featureId: hole.featureId,
          field: 'depth',
          value: 'm4_hole_depth'
        }
      );
    }
    for (let holeNumber = 2; holeNumber <= 8; holeNumber += 1) {
      operations.push(
        {
          kind: 'delete_parameter',
          name: `m4_hole_${holeNumber}_radius`
        },
        {
          kind: 'delete_parameter',
          name: `m4_hole_${holeNumber}_depth`
        }
      );
    }
    expect(operations).toHaveLength(32);

    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_m4_grid_cleanup',
      summary: 'Consolidate every M4 hole without moving or resizing it.',
      assumptions: [],
      preserveGeometry: true,
      operations
    });
    const commands = commandsForCadPatch(document, proposal);
    expect(commands).toHaveLength(32);

    const manager = new CommandManager(document);
    manager.runTransaction('Apply AI patch', commands);

    const consolidatedNames = listParameters(manager.document).map(
      ({ name }) => name
    );
    expect(consolidatedNames).toHaveLength(31);
    expect(consolidatedNames).toEqual(
      expect.arrayContaining([
        'm4_hole_radius',
        'm4_hole_depth',
        'm4_hole_8_x',
        'm4_hole_8_y',
        'm4_hole_8_z',
        ...Object.keys(plateParameters)
      ])
    );
    expect(
      consolidatedNames.some((name) =>
        /^m4_hole_[1-8]_(?:radius|depth)$/.test(name)
      )
    ).toBe(false);
    for (let holeNumber = 1; holeNumber <= 8; holeNumber += 1) {
      expect(consolidatedNames).toEqual(
        expect.arrayContaining([
          `m4_hole_${holeNumber}_x`,
          `m4_hole_${holeNumber}_y`,
          `m4_hole_${holeNumber}_z`
        ])
      );
    }

    const expectEveryHoleToResolve = (
      candidate: typeof manager.document,
      diameter: number,
      depth: number
    ) => {
      const { scope } = getParameterScope(candidate);
      const directEdits = listFeaturesInOrder(candidate).filter(
        (feature) => feature.data.featureKind === 'direct-edit'
      );
      expect(directEdits).toHaveLength(8);
      for (const feature of directEdits) {
        if (
          feature.data.featureKind !== 'direct-edit' ||
          feature.data.operation.kind !== 'resize-imported-blind-hole'
        ) {
          throw new Error('Expected a blind-hole direct edit.');
        }
        expect(feature.data.operation).toMatchObject({
          diameter: 'm4_hole_radius * 2',
          depth: 'm4_hole_depth'
        });
        expect(
          resolveParamValue(feature.data.operation.diameter, scope, 'diameter')
        ).toBe(diameter);
        expect(
          resolveParamValue(feature.data.operation.depth, scope, 'depth')
        ).toBe(depth);
      }
    };
    expectEveryHoleToResolve(manager.document, 4.5, 8);

    const replayed = replayCommands(
      document,
      commands.map((command) => command.serialize())
    );
    expectEveryHoleToResolve(replayed, 4.5, 8);
    expect(listParameters(replayed).map(({ name }) => name)).toEqual(
      consolidatedNames
    );

    manager.undo();
    expect(listParameters(manager.document)).toHaveLength(45);
    expect(listParameters(manager.document).map(({ name }) => name)).toEqual(
      expect.arrayContaining(['m4_hole_1_radius', 'm4_hole_8_depth'])
    );
    manager.redo();
    expectEveryHoleToResolve(manager.document, 4.5, 8);

    manager.runTransaction('Resize every M4 hole', [
      commandFactories.setParameter({
        name: 'm4_hole_radius',
        expression: '3'
      }),
      commandFactories.setParameter({
        name: 'm4_hole_depth',
        expression: '9'
      })
    ]);
    expectEveryHoleToResolve(manager.document, 6, 9);
  });

  it('still refuses a delete whose readers were not rebound', () => {
    let document = createProjectDocument('Guarded', USER, 'mm');
    document = setParameter(document, { name: 'legacy', expression: '5' });
    document = addPrimitiveFeature(document, {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 'legacy', height: 5, depth: 5 }
    });
    const manager = new CommandManager(document);
    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_bad_delete',
      summary: 'Delete a parameter that is still read.',
      assumptions: [],
      operations: [{ kind: 'delete_parameter', name: 'legacy' }]
    });
    expect(() =>
      manager.runTransaction(
        'Apply AI patch',
        commandsForCadPatch(manager.document, proposal)
      )
    ).toThrow(/still read it/);
  });

  it('accepts the dotted operation.offset spelling for a direct edit', () => {
    let document = createProjectDocument('Offset', USER, 'mm');
    document = addPrimitiveFeature(document, {
      name: 'Cyl',
      primitiveKind: 'cylinder',
      dimensions: { radius: 10, height: 20 }
    });
    const bodyId = document.bodyOrder.at(-1)!;
    const edited = directEditBody(document, {
      name: 'Offset cap',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: 1,
        sourceSurfaceType: 'plane',
        sourceArea: 314,
        sourceCenter: { x: 0, y: 0, z: 20 },
        sourceNormal: { x: 0, y: 0, z: 1 },
        offset: 5
      }
    });
    document = edited.document;
    const feature = listFeaturesInOrder(document).find(
      (candidate) => candidate.name === 'Offset cap'
    )!;
    const proposal = parseCadPatchProposal({
      proposalId: 'proposal_dotted',
      summary: 'Drive the cap offset with a parameter.',
      assumptions: [],
      operations: [
        { kind: 'set_parameter', name: 'cap_offset', expression: '8' },
        {
          kind: 'set_feature_dimension',
          featureId: feature.featureId,
          field: 'operation.offset',
          value: 'cap_offset'
        }
      ]
    });
    const commands = commandsForCadPatch(document, proposal);
    expect(commands[1]?.payload).toMatchObject({
      data: { operation: { kind: 'offset-face', offset: 'cap_offset' } }
    });
  });

  it('validates rename and delete targets against the evolving digest', () => {
    const { document } = documentWithReaders();
    const digest = createCadDocumentDigest(document);
    const chained = parseCadPatchProposal({
      proposalId: 'proposal_chain',
      summary: 'Rename then delete through the new name.',
      assumptions: [],
      operations: [
        { kind: 'rename_parameter', name: 'w', newName: 'plate_width' },
        { kind: 'rename_parameter', name: 'plate_width', newName: 'span' }
      ]
    });
    expect(() =>
      validateCadPatchProposalAgainstDigest(chained, digest)
    ).not.toThrow();

    expect(() =>
      validateCadPatchProposalAgainstDigest(
        parseCadPatchProposal({
          proposalId: 'proposal_unknown_rename',
          summary: 'Rename a parameter that does not exist.',
          assumptions: [],
          operations: [
            { kind: 'rename_parameter', name: 'ghost', newName: 'anything' }
          ]
        }),
        digest
      )
    ).toThrow(/unknown parameter "ghost"/);

    expect(() =>
      validateCadPatchProposalAgainstDigest(
        parseCadPatchProposal({
          proposalId: 'proposal_unknown_delete',
          summary: 'Delete a parameter that does not exist.',
          assumptions: [],
          operations: [{ kind: 'delete_parameter', name: 'ghost' }]
        }),
        digest
      )
    ).toThrow(/unknown parameter "ghost"/);
  });
});
