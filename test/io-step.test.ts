import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStepMetadata } from '@openzcad/io-step';

/**
 * `parseStepMetadata` is the cheap textual scan the upload flow runs before any
 * kernel is loaded, so it has to survive whatever a real STEP file contains and
 * must never claim geometry it has not read.
 */
describe('STEP metadata parsing', () => {
  it('extracts product names from a kernel-written export', () => {
    const text = readFileSync(resolve('samples/parametric-bracket.step'), 'utf8');
    const metadata = parseStepMetadata('parametric-bracket.step', text);
    expect(metadata.name).toBe('parametric-bracket.step');
    expect(metadata.products.length).toBeGreaterThan(0);
  });

  it('extracts every product of a multi-part assembly', () => {
    const text = readFileSync(resolve('samples/simple-assembly.step'), 'utf8');
    const metadata = parseStepMetadata('simple-assembly.step', text);
    expect(metadata.products).toContain('Simple Block');
  });

  it('names unnamed colours instead of dropping them', () => {
    const metadata = parseStepMetadata(
      'colours.step',
      "#1=COLOUR_RGB('',0.1,0.2,0.3);\n#2=COLOUR_RGB('Anodised Red',1.,0.,0.);"
    );
    expect(metadata.colors).toEqual(['unnamed', 'Anodised Red']);
  });

  it('returns empty lists for a file with no products or colours', () => {
    const metadata = parseStepMetadata('empty.step', 'ISO-10303-21;\nEND-ISO-10303-21;');
    expect(metadata).toEqual({ name: 'empty.step', products: [], colors: [] });
  });
});
