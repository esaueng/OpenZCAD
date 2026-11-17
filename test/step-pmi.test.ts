import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createObjectFolder,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ModelPmiAnnotation,
  type ModelPmiId,
  type ProjectDocument
} from '@openzcad/shared';
import { appendStepPmi } from '../packages/kernel-adapter/src/step-pmi';
import { pmiFaceRef } from '../apps/web/src/lib/pmi/modelPmi';

/**
 * D07 slice D: the model's PMI written to an AP242 STEP as semantic PMI,
 * each entry on the exact face it tolerances, checked here entity by
 * entity: the face each usage points at is found from its own surface
 * geometry, every reference resolves, and AP214 files carry none.
 */

type Adapter = Awaited<ReturnType<typeof createExactKernelAdapter>>;
let adapter: Adapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});
afterAll(() => adapter.dispose());

const id = (name: string) => `pmi_${name}` as ModelPmiId;

/** A 20 × 10 × 6 box and a Ø8 pin 40 along x, with their PMI. */
async function bracket(): Promise<ProjectDocument> {
  let document = createProjectDocument('Bracket', toUserId('test'));
  document = addPrimitiveFeature(document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 6 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Pin',
    primitiveKind: 'cylinder',
    dimensions: { radius: 4, height: 12 }
  });
  document = transformBody(document, {
    name: 'Move',
    targetBodyId: document.bodyOrder[1]!,
    translation: { x: 40, y: 0, z: 0 }
  }).document;
  const bodies = (await adapter.syncDocument(document)).bodyRepresentations;
  const [boxId, pinId] = document.bodyOrder as [BodyId, BodyId];
  type Face = NonNullable<(typeof bodies)[BodyId]>['topology'] extends infer T
    ? T extends { faces: (infer F)[] }
      ? F
      : never
    : never;
  const face = (bodyId: BodyId, test: (face: Face) => boolean) =>
    pmiFaceRef(
      bodies,
      bodyId,
      bodies[bodyId]!.topology!.faces.find((candidate) => test(candidate))!.hash
    )!;
  const bottom = face(
    boxId,
    (candidate) =>
      candidate.geometry?.surfaceType === 'plane' &&
      (candidate.geometry.normal?.z ?? 0) < -0.999
  );
  const side = face(
    boxId,
    (candidate) =>
      candidate.geometry?.surfaceType === 'plane' &&
      (candidate.geometry.normal?.x ?? 0) > 0.999
  );
  const barrel = face(
    pinId,
    (candidate) => candidate.geometry?.surfaceType === 'cylinder'
  );
  const annotations: ModelPmiAnnotation[] = [
    {
      pmiId: id('a'),
      kind: 'datum-feature',
      face: bottom,
      anchor: { x: 0, y: 0, z: 0 },
      letter: 'A'
    },
    {
      pmiId: id('perp'),
      kind: 'feature-control-frame',
      face: side,
      anchor: { x: 10, y: 0, z: 5 },
      characteristic: 'perpendicularity',
      amount: 0.05,
      datums: [{ letter: 'A' }]
    },
    {
      pmiId: id('pos'),
      kind: 'feature-control-frame',
      face: barrel,
      anchor: { x: 44, y: 0, z: 6 },
      characteristic: 'position',
      amount: 0.1,
      diameterZone: true,
      material: 'mmc',
      datums: [{ letter: 'A', material: 'mmc' }]
    },
    {
      pmiId: id('flat'),
      kind: 'feature-control-frame',
      face: bottom,
      anchor: { x: 1, y: 0, z: 0 },
      characteristic: 'flatness',
      amount: 0.02
    }
  ];
  return { ...document, pmi: { annotations } };
}

/** The file's entities by id, and helpers to read them. */
function parse(step: string) {
  const entities = new Map<string, string>();
  for (const line of step.split('\n')) {
    const match = /^(#\d+) = (.*);$/.exec(line);
    if (match) {
      expect(entities.has(match[1]!)).toBe(false);
      entities.set(match[1]!, match[2]!);
    }
  }
  const refs = (text: string) =>
    [...text.replace(/'(?:[^']|'')*'/g, "''").matchAll(/#\d+/g)].map(
      (match) => match[0]
    );
  const all = (pattern: RegExp) =>
    [...entities].filter(([, text]) => pattern.test(text));
  const numbers = (text: string) =>
    [...text.matchAll(/-?\d+(?:\.\d*)?(?:E-?\d+)?/g)].map((m) => Number(m[0]));
  /** The face an ADVANCED_FACE id lies on, read from its surface. */
  const surfaceOf = (faceId: string) => {
    const faceRefs = refs(entities.get(faceId)!);
    const surface = entities.get(faceRefs[faceRefs.length - 1]!)!;
    const placement = entities.get(refs(surface)[0]!)!;
    const [point, axis] = refs(placement).map((ref) =>
      numbers(entities.get(ref)!.replace(/^[A-Z_]+\('[^']*', /, ''))
    );
    return { surface, point: point!, axis: axis! };
  };
  /** The ADVANCED_FACE a shape aspect's usage points at. */
  const usageFace = (aspect: string) => {
    const usage = all(/^GEOMETRIC_ITEM_SPECIFIC_USAGE\(/).find(
      ([, text]) => refs(text)[0] === aspect
    )!;
    return refs(usage[1])[2]!;
  };
  return { entities, refs, all, surfaceOf, usageFace };
}

describe('D07 AP242 semantic PMI (slice D)', () => {
  it('writes each datum and frame on its exact face, with every reference resolving', async () => {
    const document = await bracket();
    const step = await adapter.exportStep(document, [...document.bodyOrder], {
      protocol: 'ap242',
      timestamp: '2026-11-17T00:00:00'
    });
    const file = parse(step);
    // Referential integrity: every #n a line names is in the file.
    for (const [, text] of file.entities)
      for (const ref of file.refs(text))
        expect(file.entities.has(ref), `${ref} in ${text}`).toBe(true);
    const [pds] = file.all(/^PRODUCT_DEFINITION_SHAPE\(/)[0]!;
    const [rep] = file.all(/^ADVANCED_BREP_SHAPE_REPRESENTATION\(/)[0]!;

    // Datum A: a datum feature on the box's bottom (the plane z = 0, its
    // axis along Z), related to the datum it establishes.
    const [feature] = file.all(/^DATUM_FEATURE\('datum feature A'/)[0]!;
    expect(file.entities.get(feature)).toBe(
      `DATUM_FEATURE('datum feature A', '', ${pds}, .T.)`
    );
    const bottom = file.surfaceOf(file.usageFace(feature));
    expect(bottom.surface.startsWith('PLANE(')).toBe(true);
    expect(Math.abs(bottom.axis[2]!)).toBeCloseTo(1, 12);
    expect(bottom.point[2]).toBeCloseTo(0, 12);
    const [datum, datumText] = file.all(/^DATUM\(/)[0]!;
    expect(datumText).toBe(`DATUM('datum A', '', ${pds}, .F., 'A')`);
    expect(
      file.all(/^SHAPE_ASPECT_RELATIONSHIP\(/).map(([, text]) => text)
    ).toEqual([`SHAPE_ASPECT_RELATIONSHIP('', $, ${feature}, ${datum})`]);
    for (const [, usage] of file.all(/^GEOMETRIC_ITEM_SPECIFIC_USAGE\(/))
      expect(file.refs(usage)[1]).toBe(rep);

    // Perpendicularity to A on the +x side (the plane x = 20): the leaf
    // entity carries its own datum system.
    const [perpId, perp] = file.all(/^PERPENDICULARITY_TOLERANCE\(/)[0]!;
    const [magnitude, aspect, system] = file.refs(perp);
    expect(perp).toBe(
      `PERPENDICULARITY_TOLERANCE('perpendicularity', '', ${magnitude}, ${aspect}, (${system}))`
    );
    expect(file.entities.get(magnitude!)).toMatch(
      /^LENGTH_MEASURE_WITH_UNIT\(LENGTH_MEASURE\(0\.05\), #\d+\)$/
    );
    expect(
      file.entities.get(file.refs(file.entities.get(magnitude!)!)[0]!)
    ).toContain('LENGTH_UNIT()');
    const side = file.surfaceOf(file.usageFace(aspect!));
    expect(Math.abs(side.axis[0]!)).toBeCloseTo(1, 12);
    expect(side.point[0]).toBeCloseTo(20, 9);
    const compartments = file.refs(file.entities.get(system!)!).slice(1);
    expect(compartments).toHaveLength(1);
    expect(file.entities.get(compartments[0]!)).toBe(
      `DATUM_REFERENCE_COMPARTMENT('', $, ${pds}, .F., ${datum}, $)`
    );
    // Its system is named by its references (datum_system.UR1).
    expect(file.entities.get(system!)).toMatch(/^DATUM_SYSTEM\('A', '', /);
    expect(perpId).toBeTruthy();

    // Position Ø0.1 Ⓜ to A Ⓜ on the pin's barrel (the cylinder of radius 4
    // about x = 40): a complex instance with its modifier and datum system,
    // its zone cylindrical.
    const [positionId, position] = file.all(/POSITION_TOLERANCE\(\)/)[0]!;
    expect(position).toMatch(
      /^\( GEOMETRIC_TOLERANCE\('position', '', #\d+, #\d+\) GEOMETRIC_TOLERANCE_WITH_DATUM_REFERENCE\(\(#\d+\)\) GEOMETRIC_TOLERANCE_WITH_MODIFIERS\(\(\.MAXIMUM_MATERIAL_REQUIREMENT\.\)\) POSITION_TOLERANCE\(\) \)$/
    );
    const [positionMagnitude, positionAspect, positionSystem] =
      file.refs(position);
    expect(file.entities.get(positionMagnitude!)).toContain(
      'LENGTH_MEASURE(0.1)'
    );
    const barrel = file.surfaceOf(file.usageFace(positionAspect!));
    expect(barrel.surface).toMatch(/^CYLINDRICAL_SURFACE\('', #\d+, 4\.\)$/);
    expect(barrel.point[0]).toBeCloseTo(40, 9);
    const positionCompartment = file.refs(
      file.entities.get(positionSystem!)!
    )[1]!;
    expect(file.entities.get(positionCompartment)).toBe(
      `DATUM_REFERENCE_COMPARTMENT('', $, ${pds}, .F., ${datum}, (SIMPLE_DATUM_REFERENCE_MODIFIER(.MAXIMUM_MATERIAL_REQUIREMENT.)))`
    );
    const [, zone] = file.all(/^TOLERANCE_ZONE\(/)[0]!;
    expect(file.refs(zone)).toEqual([pds, positionId, expect.any(String)]);
    expect(file.entities.get(file.refs(zone)[2]!)).toBe(
      "TOLERANCE_ZONE_FORM('cylindrical or circular')"
    );

    // Flatness on the same bottom face: a form tolerance, no datums.
    const [, flatness] = file.all(/^FLATNESS_TOLERANCE\(/)[0]!;
    expect(flatness).toMatch(
      /^FLATNESS_TOLERANCE\('flatness', '', #\d+, #\d+\)$/
    );
    expect(file.usageFace(file.refs(flatness)[1]!)).toBe(
      file.usageFace(feature)
    );
  }, 120_000);

  it('shares one datum system per reference frame, each uniquely named', async () => {
    const base = await bracket();
    const [, perp] = base.pmi!.annotations as [
      ModelPmiAnnotation,
      ModelPmiAnnotation & { kind: 'feature-control-frame' }
    ];
    // A second frame to A on the same face, and a tiny one in metres.
    const document: ProjectDocument = {
      ...base,
      pmi: {
        annotations: [
          ...base.pmi!.annotations,
          {
            ...perp,
            pmiId: id('perp2'),
            characteristic: 'parallelism',
            amount: 0.000001
          }
        ]
      }
    };
    const file = parse(
      await adapter.exportStep(document, [...document.bodyOrder], {
        protocol: 'ap242',
        units: 'm',
        timestamp: '2026-11-17T00:00:00'
      })
    );
    const systems = file.all(/^DATUM_SYSTEM\(/).map(([, text]) => text);
    // A (perpendicularity and parallelism) and A(M) (position): two.
    expect(
      systems.map((text) => /^DATUM_SYSTEM\('([^']*)'/.exec(text)![1])
    ).toEqual(['A', 'A(M)']);
    const [, parallel] = file.all(/^PARALLELISM_TOLERANCE\(/)[0]!;
    const [, perpendicular] = file.all(/^PERPENDICULARITY_TOLERANCE\(/)[0]!;
    expect(file.refs(parallel)[2]).toBe(file.refs(perpendicular)[2]);
    // 0.000001 mm in metres is a Part 21 real: a point and an upper E.
    expect(file.entities.get(file.refs(parallel)[0]!)).toMatch(
      /^LENGTH_MEASURE_WITH_UNIT\(LENGTH_MEASURE\(1\.E-9\), #\d+\)$/
    );
  }, 120_000);

  it('restates tolerances in an inch file, and writes none to AP214', async () => {
    const document = await bracket();
    const inch = parse(
      await adapter.exportStep(document, [...document.bodyOrder], {
        protocol: 'ap242',
        units: 'inch',
        timestamp: '2026-11-17T00:00:00'
      })
    );
    const [, perp] = inch.all(/^PERPENDICULARITY_TOLERANCE\(/)[0]!;
    const magnitude = inch.entities.get(inch.refs(perp)[0]!)!;
    const value = Number(/LENGTH_MEASURE\(([^)]*)\)/.exec(magnitude)![1]);
    expect(value).toBeCloseTo(0.05 / 25.4, 12);
    // The unit it names is the file's inch.
    expect(inch.entities.get(inch.refs(magnitude)[0]!)).toMatch(
      /CONVERSION_BASED_UNIT\('INCH'|'inch'/i
    );
    const ap214 = await adapter.exportStep(document, [...document.bodyOrder], {
      timestamp: '2026-11-17T00:00:00'
    });
    expect(ap214).not.toMatch(
      /DATUM|TOLERANCE\(|GEOMETRIC_ITEM_SPECIFIC_USAGE/
    );
    // A frame on a face that no longer resolves is left out, not moved.
    const stale: ProjectDocument = {
      ...document,
      pmi: {
        annotations: document.pmi!.annotations.map((entry) =>
          entry.pmiId === id('perp')
            ? {
                ...entry,
                face: { bodyId: entry.face.bodyId, hash: 12345 }
              }
            : entry
        )
      }
    };
    const without = parse(
      await adapter.exportStep(stale, [...stale.bodyOrder], {
        protocol: 'ap242',
        timestamp: '2026-11-17T00:00:00'
      })
    );
    expect(without.all(/PERPENDICULARITY_TOLERANCE/)).toHaveLength(0);
    expect(without.all(/POSITION_TOLERANCE/)).toHaveLength(1);
  }, 120_000);

  it('ties PMI to each body’s own part in a file with Objects folders', async () => {
    const plain = await bracket();
    const document = {
      ...createObjectFolder(plain, {
        folderId: 'fold_parts',
        name: 'Parts',
        parentId: null,
        bodyIds: [...plain.bodyOrder] as BodyId[]
      }),
      pmi: plain.pmi
    };
    const file = parse(
      await adapter.exportStep(document, [...document.bodyOrder], {
        protocol: 'ap242',
        timestamp: '2026-11-17T00:00:00'
      })
    );
    for (const [, text] of file.entities)
      for (const ref of file.refs(text))
        expect(file.entities.has(ref), `${ref} in ${text}`).toBe(true);
    // The part named after the box: its shape and its solid's
    // representation hold the box's datum and frames.
    const shapeOf = (name: string) => {
      const [productId] = file.all(new RegExp(`^PRODUCT\\('${name}`))[0]!;
      const [formation] = file
        .all(/^PRODUCT_DEFINITION_FORMATION\(/)
        .find(([, text]) => file.refs(text)[0] === productId)!;
      const [definition] = file
        .all(/^PRODUCT_DEFINITION\(/)
        .find(([, text]) => file.refs(text)[0] === formation)!;
      return file
        .all(/^PRODUCT_DEFINITION_SHAPE\(/)
        .find(([, text]) => file.refs(text)[0] === definition)![0];
    };
    const box = shapeOf('Box');
    const [feature, featureText] = file.all(/^DATUM_FEATURE\(/)[0]!;
    expect(file.refs(featureText)[0]).toBe(box);
    const [, perp] = file.all(/^PERPENDICULARITY_TOLERANCE\(/)[0]!;
    const aspect = file.refs(perp)[1]!;
    expect(file.refs(file.entities.get(aspect)!)[0]).toBe(box);
    const usage = file
      .all(/^GEOMETRIC_ITEM_SPECIFIC_USAGE\(/)
      .find(([, text]) => file.refs(text)[0] === feature)![1];
    expect(file.entities.get(file.refs(usage)[1]!)).toMatch(
      /^ADVANCED_BREP_SHAPE_REPRESENTATION\('Box/
    );
    // The pin's position frame names datum A, which is on the box: another
    // part's datum is not in its frame, so it is left out.
    expect(file.all(/POSITION_TOLERANCE/)).toHaveLength(0);
    expect(file.all(/FLATNESS_TOLERANCE/)).toHaveLength(1);
  }, 120_000);

  it('refuses a shell that is not the kernel’s faces', () => {
    const data = [
      '#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
      "#5 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#1)) REPRESENTATION_CONTEXT('', '') );",
      "#10 = AXIS2_PLACEMENT_3D('', #11, #12, #13);",
      "#14 = PLANE('', #10);",
      "#20 = ADVANCED_FACE('', (#21), #14, .T.);",
      "#30 = CLOSED_SHELL('', (#20));",
      "#31 = MANIFOLD_SOLID_BREP('Part #9', #30);"
    ];
    const context = {
      data,
      entity: () => '#99',
      breps: ['#31'],
      parts: [{ productShape: '#40', representation: '#41' }]
    };
    const datum = (surface: string, face = 0) => [
      {
        kind: 'datum' as const,
        letter: 'A',
        face: { solid: 0, face, surface }
      }
    ];
    // The right face: written. A name holding "#9" is not a reference.
    expect(appendStepPmi(context, datum('plane'))).toBe(1);
    expect(() => appendStepPmi(context, datum('cylinder'))).toThrow(
      /another surface/
    );
    expect(() => appendStepPmi(context, datum('plane', 1))).toThrow(
      /other than the kernel’s faces/
    );
  });
});
