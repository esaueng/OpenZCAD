import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  ASSEMBLY_BOM_CSV_HEADER,
  addAssemblyComponents,
  assemblyBomToCsv,
  createProjectDocument,
  deriveAssemblyBom,
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
    const bom = deriveAssemblyBom(manager.document);
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
        name: 'Plate Body',
        bodyId: plate,
        instances: [{ componentId: 'comp_plate', name: 'Plate' }]
      }
    ]);
    expect(bom.totalQuantity).toBe(3);
    // A deleted body has no part to list.
    expect(
      deriveAssemblyBom(document, (bodyId) => bodyId === plate).rows.map(
        (row) => row.bodyId
      )
    ).toEqual([plate]);
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
    const [row] = deriveAssemblyBom(manager.document).rows;
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
    const before = deriveAssemblyBom(manager.document);
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(manager.document)) as ProjectDocument
    );
    expect(deriveAssemblyBom(reopened)).toEqual(before);
    expect(assemblyBomToCsv(deriveAssemblyBom(reopened))).toBe(
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
          name: '=HYPERLINK("x")',
          bodyId: 'body_2' as BodyId,
          instances: [{ componentId: 'c3', name: '-Spacer' }]
        }
      ]
    });
    expect(csv.split('\n')).toEqual([
      'item,quantity,part,instances,source_body',
      '1,2,"Bolt, M3 ""short""",Bolt 1; Bolt 2,body_1',
      `2,1,"'=HYPERLINK(""x"")",'-Spacer,body_2`
    ]);
  });
});
