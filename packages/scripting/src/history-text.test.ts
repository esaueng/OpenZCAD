import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  filletEdges,
  setParameter
} from '@openzcad/document-core';
import {
  toUserId,
  type EdgeTopologyReferenceV5,
  type ProjectDocument
} from '@openzcad/shared';
import {
  historyModelOf,
  HistoryTextSyntaxError,
  parseHistoryText,
  printHistory,
  readHistoryText,
  type HistoryTextDiagnostic
} from './index';

function edgeReference(
  producingFeatureId: string,
  lineageName: string,
  currentHash: number
): EdgeTopologyReferenceV5 {
  return {
    kind: 'edge',
    producingFeatureId:
      producingFeatureId as EdgeTopologyReferenceV5['producingFeatureId'],
    lineageName,
    currentHash,
    witnessVersion: 1,
    witness: {
      curveType: 'line',
      length: 30,
      closed: false,
      endpoints: [
        [0, 0, 0],
        [30_000_000, 0, 0]
      ],
      midpoint: [15_000_000, 0, 0]
    }
  };
}

/** A box, a parameter-driven sketch extrusion and a referenced fillet. */
function sampleDocument(): ProjectDocument {
  let document = createProjectDocument('Sample', toUserId('user_text'));
  document = setParameter(document, {
    name: 'width',
    expression: '40 mm',
    quantity: 'length'
  });
  document = setParameter(document, { name: 'count', expression: '4' });
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 20, depth: 10 }
  });
  const blockFeatureId = document.featureOrder[0]!;
  const blockBody = document.bodyOrder[0]!;
  const sketch = addSketchFeature(document, {
    name: 'Profile',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [
      {
        objectKind: 'rectangle',
        centerX: 0,
        centerY: 0,
        width: 'width / 2',
        height: 12
      }
    ]
  });
  document = extrudeSketch(sketch.document, {
    name: 'Pad',
    sketchId: sketch.sketchId,
    distance: 'width / 4'
  }).document;
  const references = [
    edgeReference(blockFeatureId, 'primitive.box.edge.x-min.y-min', 111),
    edgeReference(blockFeatureId, 'primitive.box.edge.x-max.y-min', 222)
  ];
  document = filletEdges(document, {
    name: 'Round',
    targetBodyId: blockBody,
    edgeHashes: [111, 222],
    edgeReferences: references,
    size: 2
  }).document;
  return document;
}

function errors(diagnostics: HistoryTextDiagnostic[]) {
  return diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

function messages(diagnostics: HistoryTextDiagnostic[]): string[] {
  return errors(diagnostics).map(
    (diagnostic) =>
      `${diagnostic.span.start.line}:${diagnostic.span.start.column} ${diagnostic.message}`
  );
}

describe('history text printing', () => {
  it('prints parameters, features, sketch objects and references as text', () => {
    const document = sampleDocument();
    const text = printHistory(document);
    expect(text.startsWith('openzcad history 1\nunits mm\n')).toBe(true);
    expect(text).toMatch(/param #param_\S+ width: length = `40 mm`/);
    expect(text).toMatch(/param #param_\S+ count = `4`/);
    expect(text).toMatch(/primitive #feat_\S+ "Block" -> #body_\S+ \{/);
    expect(text).toContain('width: `width`');
    expect(text).toContain('width: `width / 2`');
    expect(text).toContain('distance: `width / 4`');
    expect(text).toMatch(/rectangle #ent_\S+ "/);
    expect(text).toMatch(
      /edgeReferences: \[\s*edge\(#feat_\S+, "primitive\.box\.edge\.x-min\.y-min"\),/
    );
    // The hashes are implied by the references, so the text leaves them out.
    expect(text).not.toContain('edgeHashes');
    expect(text).not.toContain('111');
    // Ids print as #ids; the kind is written once, before the id.
    expect(text).toMatch(/sketchId: #sketch_\S+,/);
    expect(text).not.toContain('featureKind');
  });

  it('prints deterministically', () => {
    const document = sampleDocument();
    expect(printHistory(document)).toBe(
      printHistory(structuredClone(document))
    );
  });

  it('keeps a hash the references do not imply', () => {
    const document = sampleDocument();
    const fillet = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'fillet'
    )!;
    if (fillet.kind !== 'feature' || fillet.data.featureKind !== 'fillet') {
      throw new Error('fixture');
    }
    fillet.data.edgeHashes = [111, 999];
    const text = printHistory(document);
    expect(text).toContain('edgeHashes: [111, 999]');
    const read = readHistoryText(text, document);
    expect(messages(read.diagnostics)).toEqual([]);
    expect(read.model).toEqual(historyModelOf(document));
  });
});

describe('history text round trip', () => {
  it('reads its own print back to the document it came from', () => {
    const document = sampleDocument();
    const read = readHistoryText(printHistory(document), document);
    expect(messages(read.diagnostics)).toEqual([]);
    expect(read.model).toEqual(historyModelOf(document));
  });

  it('round-trips awkward values: -0, exponents, escapes and odd keys', () => {
    const document = sampleDocument();
    const block = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'primitive'
    )!;
    if (block.kind !== 'feature') throw new Error('fixture');
    block.name = 'Quote " and \\ and\nnewline';
    block.metadata = { 'odd key': -0, tiny: 1e-7, big: 1e21, suppressed: true };
    const read = readHistoryText(printHistory(document), document);
    expect(messages(read.diagnostics)).toEqual([]);
    expect(read.model).toEqual(historyModelOf(document));
    expect(Object.is(read.model!.features[0]!.metadata!['odd key'], -0)).toBe(
      true
    );
  });

  it('accepts comments and any layout', () => {
    const document = sampleDocument();
    const text = printHistory(document)
      .replace('units mm', '// a comment\nunits    mm // trailing')
      .replaceAll('\n  ', '\n\t\t');
    const read = readHistoryText(text, document);
    expect(messages(read.diagnostics)).toEqual([]);
    expect(read.model).toEqual(historyModelOf(document));
  });

  it('notes a detached sketch in a comment instead of printing it as history', () => {
    const document = sampleDocument();
    const sketchFeature = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'sketch'
    )!;
    if (sketchFeature.kind !== 'feature') throw new Error('fixture');
    const extrude = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'extrude'
    )!;
    if (extrude.kind !== 'feature') throw new Error('fixture');
    delete document.nodes[sketchFeature.id];
    delete document.nodes[extrude.id];
    document.featureOrder = document.featureOrder.filter(
      (id) => id !== sketchFeature.featureId && id !== extrude.featureId
    );
    const text = printHistory(document);
    expect(text).toMatch(
      /\/\/ Sketch #sketch_\S+ "Profile" belongs to no feature/
    );
    const read = readHistoryText(text, document);
    expect(messages(read.diagnostics)).toEqual([]);
    expect(read.model).toEqual(historyModelOf(document));
  });
});

describe('history text typing', () => {
  function edited(
    replace: (text: string) => string,
    document = sampleDocument()
  ) {
    const text = replace(printHistory(document));
    return readHistoryText(text, document);
  }

  it('points a syntax error at its line and column', () => {
    expect(() =>
      parseHistoryText(
        'openzcad history 1\nunits mm\nbox #a "A" { width: 5 mm }'
      )
    ).toThrow(HistoryTextSyntaxError);
    const read = readHistoryText(
      'openzcad history 1\nunits mm\nprimitive #a "A" { width: 5 mm }',
      sampleDocument()
    );
    expect(read.model).toBeNull();
    expect(messages(read.diagnostics)).toEqual([
      '3:29 A number cannot carry units here; write an expression such as `5 mm`.'
    ]);
  });

  it('refuses another version and other units', () => {
    expect(
      messages(
        edited((text) =>
          text.replace('openzcad history 1', 'openzcad history 2')
        ).diagnostics
      )
    ).toEqual([
      '1:18 This is history text version 2; this release reads version 1.'
    ]);
    expect(
      messages(
        edited((text) => text.replace('units mm', 'units inch')).diagnostics
      )
    ).toEqual([
      "2:7 The text is in inch but the document is in mm. Change the document's units in the app, not in the text."
    ]);
  });

  it('refuses an expression of the wrong quantity, naming the field', () => {
    const read = edited((text) =>
      text.replace('distance: `width / 4`', 'distance: `30 deg`')
    );
    expect(errors(read.diagnostics)).toHaveLength(1);
    expect(errors(read.diagnostics)[0]!.message).toMatch(/length/i);
  });

  it('refuses a quoted string in an expression field and an expression in a literal field', () => {
    const quoted = edited((text) =>
      text.replace('distance: `width / 4`', 'distance: "width / 4"')
    );
    expect(messages(quoted.diagnostics)).toEqual([
      expect.stringMatching(
        /`distance` is an expression field: write `width \/ 4` in backticks, or a number\./
      )
    ]);
    const literal = edited((text) =>
      text.replace(/targetBodyId: #body_\S+,/, 'targetBodyId: `block`,')
    );
    expect(messages(literal.diagnostics)).toEqual([
      expect.stringMatching(
        /`targetBodyId` is not an expression field; write its value as a literal\./
      )
    ]);
  });

  it('refuses unknown ids, kinds, fields and references by name', () => {
    expect(
      messages(
        edited((text) =>
          text.replace(
            /(extrude [^]*?sketchId: )#sketch_\S+,/,
            '$1#sketch_missing,'
          )
        ).diagnostics
      )
    ).toEqual([
      expect.stringMatching(
        /#sketch_missing is not a feature, sketch, body, sketch object or parameter/
      )
    ]);
    expect(
      messages(
        edited((text) => text.replace(/^fillet /m, 'blend ')).diagnostics
      )
    ).toEqual([expect.stringMatching(/`blend` is not a feature kind\./)]);
    expect(
      messages(
        edited((text) =>
          text.replace(
            '"primitive.box.edge.x-max.y-min"',
            '"primitive.box.edge.nowhere"'
          )
        ).diagnostics
      )
    ).toEqual([
      expect.stringMatching(
        /edge\(#feat_\S+, "primitive\.box\.edge\.nowhere"\) is not a edge this document has picked/
      )
    ]);
    expect(
      messages(
        edited((text) =>
          text.replace(/^(fillet .*\{)$/m, '$1\n  @owner: "me",')
        ).diagnostics
      )
    ).toEqual([expect.stringMatching(/`@owner` is not a statement field/)]);
  });

  it('types an existing step against what the document stores (review finding 1)', () => {
    expect(
      messages(
        edited((text) =>
          text.replace('distance: `width / 4`', 'distance: true, typo: 12')
        ).diagnostics
      )
    ).toEqual([
      expect.stringMatching(/`distance` holds text here, not true or false\./),
      expect.stringMatching(/`typo` is not a field this step stores/)
    ]);
    // A number may become an expression and back.
    expect(
      messages(
        edited((text) => text.replace('height: 20', 'height: `width / 2`'))
          .diagnostics
      )
    ).toEqual([]);
  });

  it('accepts only primitives as new steps, field by field', () => {
    const empty = createProjectDocument('Empty', toUserId('user_text'));
    const read = (body: string, kind = 'primitive') =>
      messages(
        readHistoryText(
          `openzcad history 1\nunits mm\n${kind} #f "Bad" ${body}`,
          empty
        ).diagnostics
      );
    expect(read('{ distance: true, typo: 12 }', 'extrude')).toEqual([
      expect.stringMatching(
        /#f is not a step of this document\. Create a extrude step in the app/
      )
    ]);
    expect(
      read(
        '{ primitiveKind: "box", dimensions: { width: 1, depth: true, size: 2 }, typo: 1 }'
      )
    ).toEqual([
      expect.stringMatching(/`depth` takes a number or an expression/),
      expect.stringMatching(/A primitive has no dimension `size`/),
      expect.stringMatching(/set `typo` in the app/)
    ]);
    expect(read('{ primitiveKind: "prism", dimensions: {} }')).toEqual([
      expect.stringMatching(/A new primitive needs `primitiveKind`/)
    ]);
    expect(
      read(
        '{ primitiveKind: "box", dimensions: { width: 1, height: `2 mm`, depth: 3 } }'
      )
    ).toEqual([]);
  });

  it('refuses nesting deeper than any document holds instead of overflowing (review finding 2)', () => {
    const depth = 100_000;
    const text = `openzcad history 1\nunits mm\nextrude #f "Bad" { distance: ${'['.repeat(depth)}0${']'.repeat(depth)} }`;
    const read = readHistoryText(text, sampleDocument());
    expect(read.model).toBeNull();
    expect(messages(read.diagnostics)).toEqual([
      expect.stringMatching(/Values nest more than 64 levels deep\./)
    ]);
  });

  it('keeps a -0 hash its reference does not imply (review finding 3)', () => {
    const document = sampleDocument();
    const fillet = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'fillet'
    )!;
    if (fillet.kind !== 'feature' || fillet.data.featureKind !== 'fillet') {
      throw new Error('fixture');
    }
    fillet.data.edgeHashes = [-0, 222];
    fillet.data.edgeReferences![0]!.currentHash = 0;
    const text = printHistory(document);
    expect(text).toContain('edgeHashes: [-0, 222]');
    const read = readHistoryText(text, document);
    expect(messages(read.diagnostics)).toEqual([]);
    expect(read.model).toEqual(historyModelOf(document));
  });

  it('refuses a parameter cycle and a bad quantity at the parameter', () => {
    const cycle = edited((text) =>
      text.replace('count = `4`', 'count = `count + 1`')
    );
    expect(messages(cycle.diagnostics)).toEqual([
      expect.stringMatching(
        /Parameter "count": its expression refers back to itself/
      )
    ]);
    const quantity = edited((text) =>
      text.replace('width: length =', 'width: area =')
    );
    expect(messages(quantity.diagnostics)[0]).toMatch(
      /`area` is not a parameter quantity/
    );
  });

  it('warns rather than refuses an expression the document already cannot evaluate', () => {
    const document = sampleDocument();
    const extrude = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'extrude'
    )!;
    if (extrude.kind !== 'feature' || extrude.data.featureKind !== 'extrude') {
      throw new Error('fixture');
    }
    extrude.data.distance = 'missing_parameter * 2';
    const read = readHistoryText(printHistory(document), document);
    expect(errors(read.diagnostics)).toEqual([]);
    expect(read.diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([
      'warning'
    ]);
    expect(read.model).toEqual(historyModelOf(document));
  });

  it('reads an edit into the model without touching the document', () => {
    const document = sampleDocument();
    const before = structuredClone(document);
    const read = readHistoryText(
      printHistory(document).replace(
        'distance: `width / 4`',
        'distance: `width / 2 + 1 mm`'
      ),
      document
    );
    expect(messages(read.diagnostics)).toEqual([]);
    const pad = read.model!.features.find((feature) => feature.name === 'Pad')!;
    expect(pad.data).toMatchObject({
      featureKind: 'extrude',
      distance: 'width / 2 + 1 mm'
    });
    expect(document).toEqual(before);
  });
});
