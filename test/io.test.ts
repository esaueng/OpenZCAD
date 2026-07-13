import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStepMetadata } from '@openzcad/io-step';
import { parseStl, writeAsciiStl } from '@openzcad/io-stl';
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

  it('rejects files too small to be STL', () => {
    expect(() => parseStl(new ArrayBuffer(10), 'tiny.stl')).toThrow(/too small/);
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
