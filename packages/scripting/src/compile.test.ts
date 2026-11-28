import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  deleteParameter,
  findSketch,
  helicalSweepProfile,
  setParameter
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { compileHistoryEdit, printHistory } from './index';

function sample(): ProjectDocument {
  let document = createProjectDocument('Edit', toUserId('user_edit'));
  document = setParameter(document, {
    name: 'width',
    expression: '40 mm',
    quantity: 'length'
  });
  document = setParameter(document, { name: 'spare', expression: '1' });
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 20, depth: 10 }
  });
  const sketch = addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [
      { objectKind: 'circle', centerX: 0, centerY: 0, radius: 'width / 8' }
    ]
  });
  return extrudeSketch(sketch.document, {
    name: 'Pad',
    sketchId: sketch.sketchId,
    distance: 'width / 4'
  }).document;
}

function edit(document: ProjectDocument, change: (text: string) => string) {
  return compileHistoryEdit(document, change(printHistory(document)));
}

function errorsOf(result: ReturnType<typeof compileHistoryEdit>): string[] {
  return result.diagnostics
    .filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message);
}

describe('compileHistoryEdit', () => {
  it('compiles unchanged text to no proposal', () => {
    const document = sample();
    const result = compileHistoryEdit(document, printHistory(document));
    expect(result).toEqual({ proposal: null, diagnostics: [], summary: [] });
  });

  it('compiles parameter edits, renames, additions and deletions', () => {
    const document = sample();
    const result = edit(document, (text) =>
      text
        .replace('width: length = `40 mm`', 'width: length = `55 mm`')
        .replace(/param (#\S+) spare = `1`/, 'param $1 extra: number = `2`')
        .replace(
          /(param #\S+ width)/,
          'param #param_new count: number = `3`\n$1'
        )
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.proposal!.operations).toEqual([
      { kind: 'rename_parameter', name: 'spare', newName: 'extra' },
      {
        kind: 'set_parameter',
        name: 'count',
        expression: '3',
        quantity: 'number'
      },
      { kind: 'set_parameter', name: 'width', expression: '55 mm' },
      {
        kind: 'set_parameter',
        name: 'extra',
        expression: '2',
        quantity: 'number'
      }
    ]);
    expect(result.proposal!.summary).toBe('Edit history text');
  });

  it('compiles feature data, names, sketch values, deletes, moves and new primitives', () => {
    const document = sample();
    const [block, sketch, pad] = document.featureOrder;
    const result = edit(document, (text) => {
      const sections = text.split('\n\n');
      const [header, parameters, blockText, sketchText, padText] = sections;
      return [
        header,
        parameters,
        sketchText!.replace('radius: `width / 8`', 'radius: `width / 5`'),
        blockText!
          .replace('"Block"', '"Base"')
          .replace('height: 20', 'height: 25'),
        padText!.replace('distance: `width / 4`', 'distance: `width / 2`'),
        'primitive #feat_lid "Lid" {\n  primitiveKind: "cylinder",\n  dimensions: { radius: 5, height: `width / 10` },\n}\n'
      ].join('\n\n');
    });
    expect(errorsOf(result)).toEqual([]);
    expect(result.proposal!.operations).toEqual([
      expect.objectContaining({
        kind: 'update_sketch_object',
        data: expect.objectContaining({
          radius: 'width / 5'
        }) as unknown
      }),
      { kind: 'rename_feature', featureId: block, name: 'Base' },
      {
        kind: 'update_feature',
        featureId: block,
        data: { dimensions: { width: 'width', height: 25, depth: 10 } },
        clearData: []
      },
      {
        kind: 'update_feature',
        featureId: pad,
        data: { distance: 'width / 2' },
        clearData: []
      },
      { kind: 'reorder_feature', featureId: sketch, toIndex: 0 },
      {
        kind: 'add_primitive',
        name: 'Lid',
        primitiveKind: 'cylinder',
        dimensions: {
          width: null,
          height: 'width / 10',
          depth: null,
          radius: 5,
          bottomRadius: null,
          topRadius: null,
          majorRadius: null,
          minorRadius: null
        }
      }
    ]);
    expect(result.summary).toContain('Move Profile to step 1');
  });

  it('compiles a removed statement to a delete and a removed parameter last', () => {
    const document = sample();
    const pad = document.featureOrder[2];
    const result = edit(document, (text) =>
      text
        .split('\n\n')
        .filter((section) => !section.startsWith('extrude '))
        .join('\n\n')
        .replace(/param #\S+ spare = `1`\n?/, '')
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.proposal!.operations).toEqual([
      { kind: 'delete_feature', featureId: pad },
      { kind: 'delete_parameter', name: 'spare' }
    ]);
  });

  describe("a helical sweep's radius (#2120)", () => {
    function spring(
      construction?: 'in-place',
      radius: number | string = 12
    ): ProjectDocument {
      const wire = addSketchFeature(
        setParameter(createProjectDocument('Spring', toUserId('user_edit')), {
          name: 'R',
          expression: '12'
        }),
        {
          name: 'Wire',
          planeRef: { type: 'canonical', plane: 'XZ', offset: 0 },
          objects: [
            { objectKind: 'circle', centerX: 12, centerY: 0, radius: 1.5 }
          ]
        }
      );
      return helicalSweepProfile(wire.document, {
        name: 'Spring',
        profile: {
          sketchId: wire.sketchId,
          profile: {
            all: true,
            sourceEntityIds: [
              ...findSketch(wire.document, wire.sketchId)!.objectIds
            ]
          }
        },
        axisOrigin: { x: 0, y: 0, z: 0 },
        axisDirection: { x: 0, y: 0, z: 1 },
        radius,
        pitch: 5.25,
        turns: 6.25,
        ...(construction ? { construction } : {})
      }).document;
    }
    const wider = (text: string) => text.replace('radius: 12,', 'radius: 20,');

    it('is refused on a coil wound in place, where it would change nothing', () => {
      // The edit applied as one undo step and exported a byte-identical
      // STEP: the coil runs through its profile, wherever `radius` says.
      const result = edit(spring('in-place'), wider);
      expect(result.proposal).toBeNull();
      expect(errorsOf(result)).toEqual([
        "Spring is wound through its profile, so its radius is the profile's distance from the axis and `radius` only records it. Move the profile in its sketch, or the axis, to change the coil's radius."
      ]);
      // Beside another change too: the whole step is held, not half applied.
      expect(
        errorsOf(
          edit(spring('in-place'), (text) =>
            wider(text).replace('turns: 6.25,', 'turns: 8,')
          )
        )
      ).toHaveLength(1);
    });

    it('takes a number in place of a record that no longer reads', () => {
      // `radius: R` with R since deleted. The coil does not read it, but
      // the text still shows it and nothing else can put it right.
      const stranded = deleteParameter(spring('in-place', 'R'), { name: 'R' });
      const repair = (text: string) =>
        text.replace('radius: `R`,', 'radius: 12,');
      expect(printHistory(stranded)).toContain('radius: `R`,');
      const result = edit(stranded, repair);
      expect(errorsOf(result)).toEqual([]);
      expect(result.proposal?.operations).toEqual([
        expect.objectContaining({
          kind: 'update_feature',
          data: { radius: 12 }
        })
      ]);
      // While R still reads, the record is as good as a number: refused.
      expect(errorsOf(edit(spring('in-place', 'R'), repair))).toHaveLength(1);
    });

    it('leaves the rest of a coil wound in place editable', () => {
      const result = edit(spring('in-place'), (text) =>
        text.replace('pitch: 5.25,', 'pitch: 6,')
      );
      expect(errorsOf(result)).toEqual([]);
      expect(result.proposal?.operations).toEqual([
        expect.objectContaining({ kind: 'update_feature', data: { pitch: 6 } })
      ]);
    });

    it('is applied to a faceted helix, which is built at its radius', () => {
      const result = edit(spring(), wider);
      expect(errorsOf(result)).toEqual([]);
      expect(result.proposal?.operations).toEqual([
        expect.objectContaining({
          kind: 'update_feature',
          data: { radius: 20 }
        })
      ]);
      expect(result.summary).toEqual(['Edit Spring: radius']);
    });

    it('is applied when the same edit makes the coil a faceted helix', () => {
      const result = edit(spring('in-place'), (text) =>
        wider(text).replace(/\n {2}construction: "in-place",/, '')
      );
      expect(errorsOf(result)).toEqual([]);
      expect(result.proposal?.operations).toEqual([
        expect.objectContaining({
          kind: 'update_feature',
          data: { radius: 20 },
          clearData: ['construction']
        })
      ]);
    });
  });

  it('refuses what the text does not edit, at the statement', () => {
    const document = sample();
    const refused = (change: (text: string) => string) =>
      errorsOf(edit(document, change));
    // Another kind's fields are typed first, so the reader refuses this one.
    expect(
      refused((text) => text.replace(/^primitive /m, 'extrude '))
    ).not.toEqual([]);
    expect(
      refused((text) =>
        text.replace(
          /^primitive (#\S+) "Block"[^]*?\n\}/m,
          'datum-plane $1 "Block" {\n  definition: { kind: "offset", source: { type: "canonical", plane: "XY", offset: 0 }, offset: 5 },\n}'
        )
      )
    ).toEqual([expect.stringMatching(/a step's kind cannot change/)]);
    expect(
      refused((text) =>
        text.replace(
          /("Block" -> #body_\S+ \{)/,
          '$1\n  @metadata: { suppressed: true },'
        )
      )
    ).toEqual([expect.stringMatching(/does not change @metadata/)]);
    expect(
      refused((text) =>
        text.replace('plane: "XY", offset: 0', 'plane: "XY", offset: 5')
      )
    ).toEqual([expect.stringMatching(/Change Profile's plane/)]);
    // A new sketch object is refused by the reader; a removed one by compile.
    expect(
      refused((text) =>
        text.replace(
          /(@objects: \[\n)/,
          '$1    point #ent_new "P" { x: 1, y: 2 },\n'
        )
      )
    ).toEqual([expect.stringMatching(/draw new sketch objects in the app/)]);
    expect(
      refused((text) =>
        text.replace(/\n\s+circle #ent_[^\n]*\{[^]*?\},(?=\n\s+\])/, '')
      )
    ).toEqual([
      expect.stringMatching(/Draw, delete or reorder Profile's objects/)
    ]);
    expect(
      refused((text) =>
        text.replace(
          /^(sketch #)/m,
          'primitive #feat_early "Early" {\n  primitiveKind: "box",\n  dimensions: { width: 1, height: 1, depth: 1 },\n}\n\n$1'
        )
      )
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/New steps go at the end/)])
    );
    expect(
      refused(
        (text) =>
          `${text}\ndatum-plane #feat_new "Plane" {\n  definition: { kind: "offset", source: { type: "canonical", plane: "XY", offset: 0 }, offset: 5 },\n}\n`
      )
    ).toEqual([expect.stringMatching(/Create a datum-plane step in the app/)]);
    // Refused at the statement's own line, with nothing else said about it.
    const hole = edit(
      document,
      (text) => `${text}\nhole #feat_new "Hole" {\n  diameter: 3,\n}\n`
    );
    expect(errorsOf(hole)).toEqual([
      expect.stringMatching(/Create a hole step in the app/)
    ]);
    expect(hole.diagnostics[0]!.span.start.line).toBeGreaterThan(1);
    expect(
      refused((text) =>
        text.replace('param #', 'param #param_dup width = `1`\nparam #')
      )
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/already exists|declared twice/)
      ])
    );
  });

  it('passes read errors through and builds no proposal', () => {
    const document = sample();
    const result = edit(document, (text) =>
      text.replace('distance: `width / 4`', 'distance: `30 deg`')
    );
    expect(result.proposal).toBeNull();
    expect(errorsOf(result)).toHaveLength(1);
  });
});
