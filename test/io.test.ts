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
    const text = `solid big\n${'vertex 0 0 0\n'.repeat((MAX_IMPORT_TRIANGLES + 1) * 3)}endsolid big\n`;
    const buffer = new TextEncoder().encode(text).buffer;
    expect(() => parseStl(buffer, 'big.stl')).toThrow(/browser import limit/);
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
