import { describe, expect, it } from 'vitest';
import {
  finishStepExport,
  formatStepReal,
  stepStringLiteral,
  stepTimestamp,
  stepWriterOptions,
  type StepExportMetadata
} from './step-export-metadata';

/** The paired writer's output for two solids, cut down to what it edits. */
const WRITTEN = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('remus STEP export'), '2;1');",
  "FILE_NAME('Bracket.step', '2026-10-31T12:00:00Z', (''), (''), 'remus', 'remus', '');",
  "FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));",
  'ENDSEC;',
  'DATA;',
  '#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
  "#4 = UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07), #1, 'distance_accuracy_value', 'confusion accuracy');",
  "#5 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#4)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#1)) REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY') );",
  "#6 = APPLICATION_CONTEXT('configuration controlled 3D design of mechanical parts and assemblies');",
  "#7 = MECHANICAL_CONTEXT('', #6, 'mechanical');",
  "#8 = APPLICATION_PROTOCOL_DEFINITION('international standard', 'config_control_design', 1994, #6);",
  "#9 = PRODUCT('Bracket', 'Bracket', '', (#7));",
  "#15 = PRODUCT_DEFINITION_FORMATION('', '', #9);",
  "#16 = PRODUCT_DEFINITION_CONTEXT('part definition', #6, 'design');",
  "#17 = PRODUCT_DEFINITION('design', '', #15, #16);",
  "#10 = CARTESIAN_POINT('', (-7.34788079488411875E-16, -6.00000000000000000E0, 2.66999999999999993E1));",
  "#11 = DIRECTION('', (0., -1.26687599911795176E-16, 1.00000000000000000E0));",
  "#12 = VECTOR('', #11, 8.69999999999999929E0);",
  "#13 = CYLINDRICAL_SURFACE('1.5E1 kept', #11, 6.00000000000000000E0);",
  "#14 = VECTOR('', #11, 1.00000000000000000E-13);",
  "#20 = MANIFOLD_SOLID_BREP('', #19);",
  "#30 = MANIFOLD_SOLID_BREP('Imported ''pin''', #29);",
  "#31 = ADVANCED_BREP_SHAPE_REPRESENTATION('remus export', (#20, #30), #5);",
  'ENDSEC;',
  'END-ISO-10303-21;',
  ''
].join('\n');

const METADATA: StepExportMetadata = {
  productName: 'Bracket',
  fileName: 'Bracket.step',
  timestamp: '2026-10-31T12:00:00Z',
  solids: [
    { name: "Owner's plate", color: '#12ABEF' },
    { name: 'Pin', color: '#12abef' }
  ]
};

const line = (text: string, id: string) =>
  text.split('\n').find((row) => row.startsWith(`${id} = `));

describe('STEP string literals', () => {
  it('doubles apostrophes and backslashes and escapes non-ASCII', () => {
    expect(stepStringLiteral("Owner's \\ part")).toBe("'Owner''s \\\\ part'");
    expect(stepStringLiteral('Größe')).toBe("'Gr\\X2\\00F600DF\\X0\\e'");
    expect(stepStringLiteral('a😀')).toBe("'a\\X4\\0001F600\\X0\\'");
    expect(stepStringLiteral('')).toBe("''");
  });
});

describe('STEP reals', () => {
  it('writes the shortest form that reads back as the same number', () => {
    expect(formatStepReal(0)).toBe('0.');
    expect(formatStepReal(-0)).toBe('0.');
    expect(formatStepReal(18)).toBe('18.');
    expect(formatStepReal(-6)).toBe('-6.');
    expect(formatStepReal(26.7)).toBe('26.7');
    expect(formatStepReal(1e-7)).toBe('1.E-7');
    expect(formatStepReal(2.5e21)).toBe('2.5E21');
    for (const value of [Math.PI, 1 / 3, 8.699999999999999, 4.2e-16]) {
      expect(Number(formatStepReal(value))).toBe(value);
    }
    expect(() => formatStepReal(Number.NaN)).toThrow(/non-finite/);
  });
});

describe('STEP header options', () => {
  it('hands the writer the product, file name and time stamp', () => {
    expect(JSON.parse(stepWriterOptions(METADATA))).toEqual({
      productName: 'Bracket',
      fileName: 'Bracket.step',
      timestamp: '2026-10-31T12:00:00Z'
    });
  });

  it('stamps UTC to the second', () => {
    expect(
      stepTimestamp(new Date(Date.UTC(2026, 9, 31, 23, 36, 28, 169)))
    ).toBe('2026-10-31T23:36:28Z');
  });
});

describe('finishStepExport', () => {
  const finished = finishStepExport(WRITTEN, METADATA);

  it('names OpenZCAD as the originating system and declares AP214', () => {
    expect(finished).toContain(
      "FILE_DESCRIPTION(('OpenZCAD STEP export'), '2;1');"
    );
    expect(finished).toContain(
      "FILE_NAME('Bracket.step', '2026-10-31T12:00:00Z', (''), (''), 'Remus', 'OpenZCAD', '');"
    );
    expect(finished).toContain(
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));"
    );
    expect(line(finished, '#6')).toBe(
      "#6 = APPLICATION_CONTEXT('core data for automotive mechanical design processes');"
    );
    expect(line(finished, '#7')).toBe(
      "#7 = PRODUCT_CONTEXT('', #6, 'mechanical');"
    );
    expect(line(finished, '#8')).toBe(
      "#8 = APPLICATION_PROTOCOL_DEFINITION('international standard', 'automotive_design', 2000, #6);"
    );
    expect(finished).toContain(
      "PRODUCT_RELATED_PRODUCT_CATEGORY('part', $, (#9))"
    );
    expect(finished).not.toMatch(
      /CONFIG_CONTROL|MECHANICAL_CONTEXT|remus export/
    );
  });

  it('states AP242 edition 1 when asked, changing only the protocol statements', () => {
    const ap242 = finishStepExport(WRITTEN, {
      ...METADATA,
      protocol: 'ap242'
    });
    expect(ap242).toContain(
      "FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));"
    );
    expect(line(ap242, '#6')).toBe(
      "#6 = APPLICATION_CONTEXT('managed model based 3d engineering');"
    );
    expect(line(ap242, '#8')).toBe(
      "#8 = APPLICATION_PROTOCOL_DEFINITION('international standard', 'ap242_managed_model_based_3d_engineering', 2014, #6);"
    );
    expect(ap242).not.toMatch(/AUTOMOTIVE_DESIGN|automotive/i);
    // Every other line is the AP214 file's, entity for entity.
    const differing = (a: string, b: string) => {
      const left = a.split('\n');
      const right = b.split('\n');
      expect(left).toHaveLength(right.length);
      return left.filter((row, index) => row !== right[index]);
    };
    expect(differing(ap242, finished)).toEqual([
      "FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));",
      "#6 = APPLICATION_CONTEXT('managed model based 3d engineering');",
      "#8 = APPLICATION_PROTOCOL_DEFINITION('international standard', 'ap242_managed_model_based_3d_engineering', 2014, #6);"
    ]);
    expect(finishStepExport(WRITTEN, { ...METADATA, protocol: 'ap214' })).toBe(
      finished
    );
  });

  it('names each solid after its body, in writer order, over an imported name', () => {
    expect(line(finished, '#20')).toBe(
      "#20 = MANIFOLD_SOLID_BREP('Owner''s plate', #19);"
    );
    expect(line(finished, '#30')).toBe(
      "#30 = MANIFOLD_SOLID_BREP('Pin', #29);"
    );
    expect(line(finished, '#31')).toBe(
      "#31 = ADVANCED_BREP_SHAPE_REPRESENTATION('Bracket', (#20, #30), #5);"
    );
  });

  it('styles every solid with one shared chain per colour', () => {
    expect(finished.match(/COLOUR_RGB\(/g)).toHaveLength(1);
    expect(finished).toContain(
      "#33 = COLOUR_RGB('', 0.07058823529411765,0.6705882352941176,0.9372549019607843);"
    );
    const styled = [
      ...finished.matchAll(
        /^(#\d+) = STYLED_ITEM\('', \((#\d+)\), (#\d+)\);$/gm
      )
    ];
    expect(styled.map((match) => match[3])).toEqual(['#20', '#30']);
    expect(new Set(styled.map((match) => match[2])).size).toBe(1);
    expect(finished).toContain(
      `MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('', (${styled
        .map((match) => match[1])
        .join(', ')}), #5);`
    );
    expect(finished.trimEnd().endsWith('ENDSEC;\nEND-ISO-10303-21;')).toBe(
      true
    );
  });

  it('writes reals exactly and drops zero residue only from points and directions', () => {
    expect(line(finished, '#10')).toBe(
      "#10 = CARTESIAN_POINT('', (0., -6., 26.7));"
    );
    expect(line(finished, '#11')).toBe("#11 = DIRECTION('', (0., 0., 1.));");
    expect(line(finished, '#12')).toBe("#12 = VECTOR('', #11, 8.7);");
    // A real inside a string is text; a tiny length is a length.
    expect(line(finished, '#13')).toBe(
      "#13 = CYLINDRICAL_SURFACE('1.5E1 kept', #11, 6.);"
    );
    expect(line(finished, '#14')).toBe("#14 = VECTOR('', #11, 1.E-13);");
    expect(line(finished, '#4')).toContain('LENGTH_MEASURE(1.E-7)');
  });

  it('refuses a writer whose output it does not know', () => {
    expect(() =>
      finishStepExport(
        WRITTEN.replace('CONFIG_CONTROL_DESIGN', 'AP242'),
        METADATA
      )
    ).toThrow(/schema was not in its known form/);
    expect(() =>
      finishStepExport(WRITTEN, {
        ...METADATA,
        solids: METADATA.solids.slice(1)
      })
    ).toThrow(/more than 1 solids/);
    expect(() =>
      finishStepExport(WRITTEN, {
        ...METADATA,
        solids: [...METADATA.solids, { name: 'Ghost', color: '#000000' }]
      })
    ).toThrow(/2 solids for 3/);
    expect(() =>
      finishStepExport(WRITTEN, {
        ...METADATA,
        solids: [{ name: 'A', color: 'red' }, METADATA.solids[1]!]
      })
    ).toThrow(/not #rrggbb/);
  });
});

describe('finishStepExport assembly (I02)', () => {
  const assembly = {
    folders: [
      { name: 'Fasteners', parent: null },
      { name: 'Spares', parent: 0 }
    ],
    bodies: [
      { name: "Owner's plate", solidCount: 1, folder: null },
      { name: 'Pin', solidCount: 1, folder: 1 }
    ]
  };
  const finished = finishStepExport(WRITTEN, { ...METADATA, assembly });
  const count = (pattern: RegExp) => (finished.match(pattern) ?? []).length;

  it('places a geometry-free root, folder assemblies and one part per body', () => {
    expect(line(finished, '#31')).toMatch(
      /^#31 = SHAPE_REPRESENTATION\('Bracket', \(#\d+\), #5\);$/
    );
    // Two folders and two bodies, each placed once.
    expect(count(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g)).toBe(4);
    expect(count(/CONTEXT_DEPENDENT_SHAPE_REPRESENTATION\(/g)).toBe(4);
    expect(count(/ITEM_DEFINED_TRANSFORMATION\(/g)).toBe(4);
    expect(count(/PRODUCT\('/g)).toBe(5);
    // Every new shape has its own context, a copy of the writer's.
    expect(count(/GEOMETRIC_REPRESENTATION_CONTEXT\(3\)/g)).toBe(5);
    expect(finished).toContain(
      "ADVANCED_BREP_SHAPE_REPRESENTATION('Pin', (#30, "
    );
    expect(finished).toContain("PRODUCT('Spares', 'Spares', '', (#7))");
    // The solids and their styles are unchanged.
    expect(line(finished, '#20')).toBe(
      "#20 = MANIFOLD_SOLID_BREP('Owner''s plate', #19);"
    );
    expect(count(/STYLED_ITEM\(/g)).toBe(2);
  });

  it('writes no assembly without folders, and refuses a solid count it cannot place', () => {
    expect(
      finishStepExport(WRITTEN, {
        ...METADATA,
        assembly: { folders: [], bodies: assembly.bodies }
      })
    ).toBe(finishStepExport(WRITTEN, METADATA));
    expect(() =>
      finishStepExport(WRITTEN, {
        ...METADATA,
        assembly: {
          ...assembly,
          bodies: [{ name: 'All', solidCount: 3, folder: 0 }]
        }
      })
    ).toThrow(/names 3 solids for 2 written/);
  });
});
