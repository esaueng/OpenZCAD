import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  ASSEMBLY_BOM_CSV_HEADER,
  addAssemblyComponents,
  assemblyBomToCsv,
  createProjectDocument,
  deriveAssemblyBom,
  isLiveAssemblyBody,
  normalizeDocument
} from '@openzcad/document-core';
import {
  toEntityId,
  toUserId,
  type BodyId,
  type BodyNode,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * AS03 bill of materials: a pure derivation from the assembly's components
 * and their bodies, with a stable order and grouping and a CSV form.
 */
const owner = toUserId('user_bom');
/** Every listed body counts as live: the derivation without a rebuild. */
const allLive = () => true;

function bodies(names: string[]) {
  const manager = new CommandManager(createProjectDocument('Rig', owner));
  for (const name of names)
    manager.execute(
      commandFactories.addPrimitive({
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
  return { manager, ids: [...manager.document.bodyOrder] as BodyId[] };
}

function bodyNodeName(document: ProjectDocument, bodyId: BodyId): string {
  const node = Object.values(document.nodes).find(
    (n): n is BodyNode => n.kind === 'body' && n.bodyId === bodyId
  );
  if (!node) throw new Error('no body node');
  return node.name;
}

/** A body remade from `source` by a later feature (a fillet, say). */
function remake(
  document: ProjectDocument,
  source: BodyId,
  id: string
): { document: ProjectDocument; bodyId: BodyId } {
  const next = structuredClone(document);
  const bodyId = id as BodyId;
  const feature: FeatureNode = {
    ...(Object.values(next.nodes).find(
      (n) => n.kind === 'feature'
    ) as FeatureNode),
    id: toEntityId(`feature_${id}`),
    featureId: `feature_${id}` as FeatureNode['featureId'],
    data: { targetBodyId: source } as unknown as FeatureNode['data']
  };
  const body: BodyNode = {
    ...(Object.values(next.nodes).find((n) => n.kind === 'body') as BodyNode),
    id: toEntityId(`node_${id}`),
    name: bodyNodeName(next, source),
    bodyId,
    featureId: feature.featureId
  };
  next.nodes[feature.id] = feature;
  next.nodes[body.id] = body;
  next.bodyOrder = [...next.bodyOrder, bodyId];
  return { document: next, bodyId };
}

function copyPart(
  manager: CommandManager,
  source: BodyId,
  extra: Partial<Parameters<typeof commandFactories.transformBody>[0]> = {}
): BodyId {
  manager.execute(
    commandFactories.transformBody({
      name: 'Copy',
      targetBodyId: source,
      translation: { x: 20, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 90 },
      copy: true,
      ...extra
    })
  );
  return manager.document.bodyOrder.at(-1)!;
}

function assembleAll(manager: CommandManager): void {
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: manager.document.bodyOrder.map((bodyId, index) => ({
        componentId: `comp_${index}`,
        name: `Instance ${index + 1}`,
        bodyId,
        grounded: index === 0
      }))
    })
  );
}

describe('deriveAssemblyBom (AS03)', () => {
  it('is empty for a project without an assembly', () => {
    const { manager } = bodies(['Plate']);
    const bom = deriveAssemblyBom(manager.document);
    expect(bom).toEqual({ rows: [], totalQuantity: 0 });
    expect(assemblyBomToCsv(bom)).toBe(ASSEMBLY_BOM_CSV_HEADER);
  });

  it('lists one row per part in the assembly display order', () => {
    const { manager, ids } = bodies(['Plate', 'Bracket', 'Pin']);
    const [plate, bracket, pin] = ids as [BodyId, BodyId, BodyId];
    manager.execute(
      commandFactories.addAssemblyComponents({
        components: [
          {
            componentId: 'comp_pin',
            name: 'Pin',
            bodyId: pin,
            grounded: false
          },
          {
            componentId: 'comp_plate',
            name: 'Plate',
            bodyId: plate,
            grounded: true
          },
          {
            componentId: 'comp_bracket',
            name: 'Bracket',
            bodyId: bracket,
            grounded: false
          }
        ]
      })
    );
    const bom = deriveAssemblyBom(manager.document, allLive);
    // Display order, not body order or alphabetical.
    expect(bom.rows.map((row) => [row.item, row.name, row.quantity])).toEqual([
      [1, 'Pin Body', 1],
      [2, 'Plate Body', 1],
      [3, 'Bracket Body', 1]
    ]);
    expect(bom.rows.map((row) => row.bodyId)).toEqual([pin, plate, bracket]);
    expect(bom.totalQuantity).toBe(3);
  });

  it('groups components that show the same part, in display order', () => {
    const { manager, ids } = bodies(['Plate', 'Pin']);
    const [plate, pin] = ids as [BodyId, BodyId];
    manager.execute(
      commandFactories.addAssemblyComponents({
        components: [
          {
            componentId: 'comp_pin',
            name: 'Pin A',
            bodyId: pin,
            grounded: false
          },
          {
            componentId: 'comp_plate',
            name: 'Plate',
            bodyId: plate,
            grounded: true
          }
        ]
      })
    );
    // A feature remade the pin; a second component shows the remade body.
    const { document: remade, bodyId: pin2 } = remake(
      manager.document,
      pin,
      'body_pin_remade'
    );
    const document = addAssemblyComponents(remade, {
      components: [
        {
          componentId: 'comp_pin_b',
          name: 'Pin B',
          bodyId: pin2,
          grounded: false
        }
      ]
    });
    const isLive = (bodyId: BodyId) => bodyId !== pin;
    const bom = deriveAssemblyBom(document, isLive);
    expect(bom.rows).toEqual([
      {
        item: 1,
        quantity: 2,
        status: 'ready',
        name: 'Pin Body',
        bodyId: pin2,
        instances: [
          { componentId: 'comp_pin', name: 'Pin A' },
          { componentId: 'comp_pin_b', name: 'Pin B' }
        ]
      },
      {
        item: 2,
        quantity: 1,
        status: 'ready',
        name: 'Plate Body',
        bodyId: plate,
        instances: [{ componentId: 'comp_plate', name: 'Plate' }]
      }
    ]);
    expect(bom.totalQuantity).toBe(3);
    // Without a predicate the BOM uses the viewport's rule: a body is live
    // while its rebuilt representation is not consumed, so the consumed pin
    // gives way to its remade body here too.
    const rebuilt = structuredClone(document);
    rebuilt.derived.bodyRepresentations = Object.fromEntries(
      rebuilt.bodyOrder.map((bodyId) => [
        bodyId,
        { name: 'Derived', consumed: bodyId === pin }
      ])
    ) as unknown as ProjectDocument['derived']['bodyRepresentations'];
    expect(deriveAssemblyBom(rebuilt)).toEqual(bom);
    expect(isLiveAssemblyBody(rebuilt, pin)).toBe(false);
    expect(isLiveAssemblyBody(rebuilt, pin2)).toBe(true);
    // Unresolved references stay visible and keep their quantities.
    expect(
      deriveAssemblyBom(document, (bodyId) => bodyId === plate).rows.map(
        (row) => [row.bodyId, row.status, row.quantity]
      )
    ).toEqual([
      [pin, 'missing', 1],
      [plate, 'ready', 1],
      [pin2, 'missing', 1]
    ]);
  });

  it('groups rigid copies and copy chains, keeping mirrors, scales and lookalikes separate', () => {
    const {
      manager,
      ids: [source]
    } = bodies(['Bolt']);
    const first = copyPart(manager, source!);
    copyPart(manager, first, { scale: 1 });
    copyPart(manager, source!, { scale: 2 });
    copyPart(manager, source!, { scale: '1' });
    manager.execute(
      commandFactories.mirrorBody({
        name: 'Mirror',
        targetBodyId: source!,
        plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
      })
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Lookalike',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    manager.execute(
      commandFactories.patternBody({
        name: 'Pattern aggregate',
        targetBodyId: source!,
        patternKind: 'linear',
        count: 3,
        axis: 'x',
        spacing: 20
      })
    );
    assembleAll(manager);
    const bom = deriveAssemblyBom(manager.document, allLive);
    expect(bom.rows.map((row) => row.quantity)).toEqual([3, 1, 1, 1, 1, 1]);
    expect(bom.totalQuantity).toBe(8);
    expect(bom.rows[0]?.instances.map((instance) => instance.name)).toEqual([
      'Instance 1',
      'Instance 2',
      'Instance 3'
    ]);
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(deriveAssemblyBom(reopened, allLive)).toEqual(bom);
  });

  it('keeps earlier copies separate after an in-place source scale, but groups copies of the new shape', () => {
    const {
      manager,
      ids: [source]
    } = bodies(['Bolt']);
    const before = copyPart(manager, source!);
    manager.execute(
      commandFactories.transformBody({
        name: 'Scale source',
        targetBodyId: source!,
        translation: { x: 0, y: 0, z: 0 },
        scale: 2
      })
    );
    const after = copyPart(manager, source!);
    assembleAll(manager);
    const bom = deriveAssemblyBom(manager.document, allLive);
    expect(
      bom.rows.map((row) => row.instances.map((i) => i.componentId))
    ).toEqual([['comp_0', 'comp_2'], ['comp_1']]);
    expect(bom.rows.map((row) => row.bodyId)).toEqual([source, before]);
    expect(bom.rows[0]?.quantity).toBe(2);
    expect(after).not.toBe(source);
  });

  it('starts a new identity for a shape edit, and leaves an ordinary in-place move rigid', () => {
    const {
      manager,
      ids: [source]
    } = bodies(['Bolt']);
    copyPart(manager, source!);
    manager.execute(
      commandFactories.transformBody({
        name: 'Move source',
        targetBodyId: source!,
        translation: { x: 10, y: 0, z: 0 }
      })
    );
    copyPart(manager, source!);
    manager.execute(
      commandFactories.filletEdges({
        name: 'Round source',
        targetBodyId: source!,
        edgeHashes: [123],
        size: 1
      })
    );
    const rounded = manager.document.bodyOrder.at(-1)!;
    copyPart(manager, rounded);
    assembleAll(manager);
    const bom = deriveAssemblyBom(manager.document, allLive);
    expect(bom.rows.map((row) => row.quantity)).toEqual([3, 2]);
  });

  it('retains an unresolved component and marks its CSV row as missing', () => {
    const {
      manager,
      ids: [source]
    } = bodies(['Plate']);
    assembleAll(manager);
    const bom = deriveAssemblyBom(manager.document, () => false);
    expect(bom.totalQuantity).toBe(1);
    expect(bom.rows[0]).toMatchObject({
      bodyId: source,
      name: 'Plate Body',
      quantity: 1,
      status: 'missing'
    });
    expect(assemblyBomToCsv(bom).split('\n')).toEqual([
      ASSEMBLY_BOM_CSV_HEADER,
      `1,1,Plate Body,Instance 1,${source},missing`
    ]);
  });

  it('does not group an earlier copy with a source edited in place', () => {
    const {
      manager,
      ids: [source]
    } = bodies(['Bolt']);
    copyPart(manager, source!);
    manager.execute(
      commandFactories.directEditBody({
        name: 'Offset source face',
        targetBodyId: source!,
        operation: {
          kind: 'offset-face',
          faceHash: 1,
          sourceSurfaceType: 'plane',
          sourceArea: 100,
          sourceCenter: { x: 10, y: 5, z: 5 },
          sourceNormal: { x: 1, y: 0, z: 0 },
          offset: 2
        }
      })
    );
    copyPart(manager, source!);
    assembleAll(manager);
    expect(
      deriveAssemblyBom(manager.document, allLive).rows.map((row) =>
        row.instances.map((instance) => instance.componentId)
      )
    ).toEqual([['comp_0', 'comp_2'], ['comp_1']]);
  });

  it('follows renamed bodies, while component renames only change instances', () => {
    const { manager, ids } = bodies(['Plate']);
    const [plate] = ids as [BodyId];
    manager.execute(
      commandFactories.addAssemblyComponents({
        components: [
          {
            componentId: 'comp_plate',
            name: 'Plate',
            bodyId: plate,
            grounded: true
          }
        ]
      })
    );
    const node = Object.values(manager.document.nodes).find(
      (n) => n.kind === 'body' && n.bodyId === plate
    );
    manager.execute(
      commandFactories.renameNode({ nodeId: node!.id, name: 'Base plate' })
    );
    manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'comp_plate',
        name: 'Plate (left)'
      })
    );
    const [row] = deriveAssemblyBom(manager.document, allLive).rows;
    expect(row).toMatchObject({
      name: 'Base plate',
      bodyId: plate,
      instances: [{ componentId: 'comp_plate', name: 'Plate (left)' }]
    });
  });

  it('is identical after save and reopen', () => {
    const { manager, ids } = bodies(['Plate', 'Pin']);
    manager.execute(
      commandFactories.addAssemblyComponents({
        components: ids.map((bodyId, index) => ({
          componentId: `comp_${index}`,
          name: `Part ${index}`,
          bodyId,
          grounded: index === 0
        }))
      })
    );
    const before = deriveAssemblyBom(manager.document, allLive);
    expect(before.rows).toHaveLength(2);
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(deriveAssemblyBom(reopened, allLive)).toEqual(before);
    expect(assemblyBomToCsv(deriveAssemblyBom(reopened, allLive))).toBe(
      assemblyBomToCsv(before)
    );
  });

  it('writes CSV with quoting and a formula guard', () => {
    const csv = assemblyBomToCsv({
      totalQuantity: 3,
      rows: [
        {
          item: 1,
          quantity: 2,
          status: 'ready',
          name: 'Bolt, M3 "short"',
          bodyId: 'body_1' as BodyId,
          instances: [
            { componentId: 'c1', name: 'Bolt 1' },
            { componentId: 'c2', name: 'Bolt 2' }
          ]
        },
        {
          item: 2,
          quantity: 1,
          status: 'ready',
          name: '=HYPERLINK("x")',
          bodyId: 'body_2' as BodyId,
          instances: [{ componentId: 'c3', name: '-Spacer' }]
        }
      ]
    });
    expect(csv.split('\n')).toEqual([
      'item,quantity,part,instances,source_body,status',
      '1,2,"Bolt, M3 ""short""",Bolt 1; Bolt 2,body_1,ready',
      `2,1,"'=HYPERLINK(""x"")",'-Spacer,body_2,ready`
    ]);
  });
});
