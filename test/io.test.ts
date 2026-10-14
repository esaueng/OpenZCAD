import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStepMetadata } from '@openzcad/io-step';
import {
  MAX_IMPORT_TRIANGLES,
  parseStl,
  StlParseError,
  StlWriteError,
  writeAsciiStl
} from '@openzcad/io-stl';
import { solidFromTriangles, solidVolume, validateSolid } from '@openzcad/geometry';

describe('STL parsing', () => {
  it('parses sample STL geometry, not just metadata', () => {
    const stlPath = resolve('samples/simple-block.stl');
    const stlSource = readFileSync(stlPath);
    const parsed = parseStl(
      stlSource.buffer.slice(stlSource.byteOffset, stlSource.byteOffset + stlSource.byteLength),
      'simple-block.stl'
    );
    expect(parsed.triangleCount).toBeGreaterThan(0);
    expect(parsed.vertices.length).toBe(parsed.triangleCount * 9);
    expect(parsed.indices.length).toBe(parsed.triangleCount * 3);
  });

  it('parses ASCII facets beyond the first kilobyte', () => {
    const facet = [
      '  facet normal 0 0 0',
      '    outer loop',
      '      vertex 0 0 0',
      '      vertex 1 0 0',
      '      vertex 0 1 0',
      '    endloop',
      '  endfacet'
    ].join('\n');
    const text = `solid big\n${Array.from({ length: 50 }, () => facet).join('\n')}\nendsolid big\n`;
    expect(text.length).toBeGreaterThan(1024);

    const buffer = new TextEncoder().encode(text).buffer;
    const parsed = parseStl(buffer, 'big.stl');
    expect(parsed.format).toBe('ascii');
    expect(parsed.triangleCount).toBe(50);
    expect(parsed.vertices.slice(0, 9)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('detects binary STL by exact size even when it starts with "solid"', () => {
    const triangleCount = 3;
    const buffer = new ArrayBuffer(84 + triangleCount * 50);
    const bytes = new Uint8Array(buffer);
    bytes.set(new TextEncoder().encode('solid binary-exporter'), 0);
    const view = new DataView(buffer);
    view.setUint32(80, triangleCount, true);
    // Give the first triangle real coordinates.
    view.setFloat32(84 + 12, 1.5, true);

    const parsed = parseStl(buffer, 'tricky.stl');
    expect(parsed.format).toBe('binary');
    expect(parsed.triangleCount).toBe(triangleCount);
    expect(parsed.vertices[0]).toBeCloseTo(1.5, 6);
  });

  it('detects binary STL with a "solid" header even when trailing bytes break the exact size', () => {
    const triangleCount = 3;
    const buffer = new ArrayBuffer(84 + triangleCount * 50 + 1);
    const bytes = new Uint8Array(buffer);
    bytes.set(new TextEncoder().encode('solid binary-exporter'), 0);
    bytes[buffer.byteLength - 1] = 0x0a; // trailing newline
    const view = new DataView(buffer);
    view.setUint32(80, triangleCount, true);
    view.setFloat32(84 + 12, 1.5, true);

    const parsed = parseStl(buffer, 'tricky-padded.stl');
    expect(parsed.format).toBe('binary');
    expect(parsed.triangleCount).toBe(triangleCount);
    expect(parsed.vertices[0]).toBeCloseTo(1.5, 6);
  });

  it('rejects an ASCII STL with no facets', () => {
    const buffer = new TextEncoder().encode('solid empty\nendsolid empty\n').buffer;
    expect(() => parseStl(buffer, 'empty.stl')).toThrowError(StlParseError);
    expect(() => parseStl(buffer, 'empty.stl')).toThrow(/no facets/);
  });

  it('rejects a binary STL containing a non-finite vertex', () => {
    const triangleCount = 1;
    const buffer = new ArrayBuffer(84 + triangleCount * 50);
    const view = new DataView(buffer);
    view.setUint32(80, triangleCount, true);
    view.setFloat32(84 + 12, Number.NaN, true);

    expect(() => parseStl(buffer, 'nan.stl')).toThrowError(StlParseError);
    expect(() => parseStl(buffer, 'nan.stl')).toThrow(/non-finite/);
  });

  it('rejects an ASCII STL that exceeds the triangle budget', () => {
    // Whole facets: the reader refuses a vertex statement outside one.
    const facet =
      'facet normal 0 0 0\nouter loop\nvertex 0 0 0\nvertex 0 0 0\nvertex 0 0 0\nendloop\nendfacet\n';
    const text = `solid big\n${facet.repeat(MAX_IMPORT_TRIANGLES + 1)}endsolid big\n`;
    const buffer = new TextEncoder().encode(text).buffer;
    expect(() => parseStl(buffer, 'big.stl')).toThrow(/browser import limit/);
  });

  describe('ASCII facet structure', () => {
    function asciiStlText(
      facets: string[][],
      keyword: (word: string) => string = (word) => word
    ): string {
      const lines = [`${keyword('solid')} probe`];
      for (const vertices of facets) {
        lines.push(
          `  ${keyword('facet normal')} 0 0 0`,
          `    ${keyword('outer loop')}`
        );
        for (const vertex of vertices)
          lines.push(`      ${keyword('vertex')} ${vertex}`);
        lines.push(`    ${keyword('endloop')}`, `  ${keyword('endfacet')}`);
      }
      lines.push(`${keyword('endsolid')} probe`, '');
      return lines.join('\n');
    }

    function asciiStl(
      facets: string[][],
      keyword?: (word: string) => string
    ): ArrayBuffer {
      return new TextEncoder().encode(asciiStlText(facets, keyword)).buffer;
    }

    it('refuses a vertex that is not three finite numbers instead of re-pairing the rest', () => {
      // One unreadable (MSVC-style NaN) vertex per facet keeps the vertex count
      // a multiple of three, so the old reader skipped them and paired the six
      // it could read into two triangles that were never in the file.
      const buffer = asciiStl([
        ['0 0 0', '1 0 0', '1.#QNAN 0 0'],
        ['10 0 0', '-1.#IND 0 0', '10 1 0'],
        ['nan 0 0', '20 0 0', '20 1 0']
      ]);
      expect(() => parseStl(buffer, 'nan.stl')).toThrowError(StlParseError);
      expect(() => parseStl(buffer, 'nan.stl')).toThrow(
        'ASCII STL facet 1 has a vertex that is not three finite numbers: "vertex 1.#QNAN 0 0".'
      );
    });

    it.each([
      ['two coordinates', '1 0'],
      ['four coordinates', '1 0 0 0'],
      ['an overflowing coordinate', '1e999 0 0'],
      ['a decimal comma', '1,5 0 0']
    ])('refuses a vertex with %s', (_label, vertex) => {
      expect(() =>
        parseStl(asciiStl([['0 0 0', '0 1 0', vertex]]), 'bad.stl')
      ).toThrow(/facet 1 has a vertex that is not three finite numbers/);
    });

    it('refuses a facet that does not hold exactly three vertices', () => {
      expect(() =>
        parseStl(
          asciiStl([
            ['0 0 0', '1 0 0'],
            ['0 0 0', '1 0 0', '0 1 0', '0 0 1']
          ]),
          'short.stl'
        )
      ).toThrow('ASCII STL facet 1 has 2 vertices; a facet needs three.');
      expect(() =>
        parseStl(asciiStl([['0 0 0', '1 0 0', '0 1 0', '0 0 1']]), 'long.stl')
      ).toThrow('ASCII STL facet 1 has more than three vertices.');
    });

    it('refuses a vertex outside any facet and a file that ends inside one', () => {
      const stray = new TextEncoder().encode(
        'solid stray\nvertex 0 0 0\nendsolid stray\n'
      ).buffer;
      expect(() => parseStl(stray, 'stray.stl')).toThrow(
        /vertex outside any facet/
      );

      const truncated = new TextEncoder().encode(
        'solid cut\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\n'
      ).buffer;
      expect(() => parseStl(truncated, 'cut.stl')).toThrow(
        /ends inside facet 1/
      );
    });

    it('reads an upper-case ASCII STL as ASCII, not as a corrupt binary one', () => {
      const parsed = parseStl(
        asciiStl(
          [
            ['0 0 0', '1 0 0', '0 1 0'],
            ['0 0 0', '0 1 0', '0 0 1']
          ],
          (word) => word.toUpperCase()
        ),
        'UPPER.STL'
      );
      expect(parsed.format).toBe('ascii');
      expect(parsed.triangleCount).toBe(2);
      expect(parsed.vertices).toEqual([
        0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1
      ]);
    });

    it('ignores the facet normal, which exports recompute', () => {
      const text =
        'solid seam\nfacet normal nan nan nan\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 2 0 0\nendloop\nendfacet\nendsolid seam\n';
      const parsed = parseStl(
        new TextEncoder().encode(text).buffer,
        'seam.stl'
      );
      expect(parsed.triangleCount).toBe(1);
      expect(parsed.vertices).toEqual([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    });

    // Line breaks carry no meaning in ASCII STL: statements are
    // whitespace-separated tokens, however the exporter wrapped them.
    const TWO_FACETS = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1];

    it('reads an ASCII STL written on one line', () => {
      const text =
        'solid x facet normal 0 0 1 outer loop vertex 0 0 0 vertex 1 0 0 vertex 0 1 0 endloop endfacet ' +
        'facet normal 1 0 0 outer loop vertex 0 0 0 vertex 0 1 0 vertex 0 0 1 endloop endfacet endsolid x';
      const parsed = parseStl(
        new TextEncoder().encode(text).buffer,
        'one-line.stl'
      );
      expect(parsed.format).toBe('ascii');
      expect(parsed.triangleCount).toBe(2);
      expect(parsed.vertices).toEqual(TWO_FACETS);
    });

    it('reads an ASCII STL with CRLF or bare CR line endings', () => {
      for (const ending of ['\r\n', '\r']) {
        const text = asciiStlText([
          ['0 0 0', '1 0 0', '0 1 0'],
          ['0 0 0', '0 1 0', '0 0 1']
        ]).replaceAll('\n', ending);
        const parsed = parseStl(
          new TextEncoder().encode(text).buffer,
          'crlf.stl'
        );
        expect(parsed.format).toBe('ascii');
        expect(parsed.triangleCount).toBe(2);
        expect(parsed.vertices).toEqual(TWO_FACETS);
      }
    });

    it.each([
      'my facet vertex 1 2 part',
      'facet normal bracket',
      'FACET OUTER bracket'
    ])('reads keywords in the solid name "%s" as part of the name', (name) => {
      for (const ending of ['\n', '\r\n']) {
        const text = [
          `solid ${name}`,
          'facet normal 0 0 1',
          'outer loop',
          'vertex 0 0 0',
          'vertex 1 0 0',
          'vertex 0 1 0',
          'endloop',
          'endfacet',
          `endsolid ${name}`,
          ''
        ].join(ending);
        const parsed = parseStl(
          new TextEncoder().encode(text).buffer,
          'named.stl'
        );
        expect(parsed.triangleCount).toBe(1);
        expect(parsed.vertices).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      }
    });

    it('reads a one-line ASCII STL that ends with a line break', () => {
      const text =
        'solid x facet normal 0 0 1 outer loop vertex 0 0 0 vertex 1 0 0 vertex 0 1 0 endloop endfacet endsolid x\n';
      const parsed = parseStl(
        new TextEncoder().encode(text).buffer,
        'one-line.stl'
      );
      expect(parsed.triangleCount).toBe(1);
      expect(parsed.vertices).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    });
  });

  it('round-trips write -> parse -> solid', () => {
    // A tetrahedron written as STL, parsed back, and welded into a solid.
    const vertices = [
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 0, 0, 1, 1, 0, 0,
      0, 0, 0, 0, 1, 0, 0, 0, 1,
      1, 0, 0, 0, 0, 1, 0, 1, 0
    ];
    const indices = [...Array(12).keys()];
    const stl = writeAsciiStl('tetra', [{ name: 'Tetra', vertices, indices }]);
    expect((stl.match(/facet normal/g) ?? []).length).toBe(4);

    const parsed = parseStl(new TextEncoder().encode(stl).buffer, 'tetra.stl');
    expect(parsed.triangleCount).toBe(4);
    const solid = solidFromTriangles(parsed.vertices, parsed.indices);
    expect(solid.vertices).toHaveLength(4);
    expect(validateSolid(solid).closed).toBe(true);
    expect(Math.abs(solidVolume(solid))).toBeCloseTo(1 / 6, 6);
  });

  it('omits only exact zero-area ASCII facets', () => {
    const stl = writeAsciiStl('seam', [
      {
        name: 'Seam',
        vertices: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1e-12, 0],
        indices: [0, 1, 2, 0, 1, 3]
      }
    ]);

    expect((stl.match(/facet normal/g) ?? []).length).toBe(1);
    expect(stl).toContain('1e-12');
  });

  it('rejects writing a mesh whose indices are out of range', () => {
    const mesh = { name: 'Bad', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 3] };
    expect(() => writeAsciiStl('bad', [mesh])).toThrowError(StlWriteError);
    expect(() => writeAsciiStl('bad', [mesh])).toThrow(/references vertex 3/);
  });

  it('rejects writing a mesh with a non-finite vertex component', () => {
    const mesh = {
      name: 'Bad',
      vertices: [0, 0, 0, 1, 0, Number.NaN, 0, 1, 0],
      indices: [0, 1, 2]
    };
    expect(() => writeAsciiStl('bad', [mesh])).toThrowError(StlWriteError);
    expect(() => writeAsciiStl('bad', [mesh])).toThrow(/non-finite/);
  });

  it('rejects files too small to be STL', () => {
    expect(() => parseStl(new ArrayBuffer(10), 'tiny.stl')).toThrow(/too small/);
  });

  it('reports a truncated binary STL as a parse error', () => {
    const buffer = new ArrayBuffer(84 + 49);
    new DataView(buffer).setUint32(80, 1, true);

    expect(() => parseStl(buffer, 'truncated.stl')).toThrowError(StlParseError);
    expect(() => parseStl(buffer, 'truncated.stl')).toThrow(
      /declares 1 triangles requiring 134 bytes/
    );
  });
});

describe('STEP metadata', () => {
  it('parses STEP product metadata without inventing B-Rep geometry', () => {
    const stepPath = resolve('samples/simple-assembly.step');
    const text = readFileSync(stepPath, 'utf8');
    const metadata = parseStepMetadata('simple-assembly.step', text);
    expect(metadata.products).toContain('Simple Block');
  });
});
