import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { indexOcctDisplayGroups } from './occt-display-groups';
import { OcctStepKernelAdapter } from './occt-step';
import { importDocument } from '../corpus-metrics';
import { IMPORT_MODELING_SCENARIOS } from '../scenarios';

describe('OCCT display topology identity', () => {
  let kernel: OcctKernel;
  let adapter: OcctStepKernelAdapter;

  beforeAll(async () => {
    kernel = await OcctKernel.init();
    adapter = await OcctStepKernelAdapter.create();
  });
  afterAll(() => {
    adapter.dispose();
    kernel[Symbol.dispose]();
  });

  it('resolves reordered edge ranges and rejects ambiguous or unknown identities', () => {
    const box = kernel.makeBox(10, 20, 30);
    const edges = kernel.getSubShapes(box, 'edge');
    const wireframe = kernel.wireframe(box);
    const triples = Array.from(
      { length: wireframe.edgeGroups.length / 3 },
      (_, index) =>
        Array.from(wireframe.edgeGroups.slice(index * 3, index * 3 + 3))
    );
    const reordered = new Int32Array(triples.slice().reverse().flat());
    const ranges = indexOcctDisplayGroups(
      kernel,
      edges,
      reordered,
      wireframe.points.length,
      'edge'
    );
    for (const edge of edges) {
      const group = triples.find(
        (triple) => triple[2] === kernel.hashCode(edge, 2_147_483_647)
      )!;
      expect(ranges.get(edge)).toEqual({ start: group[0], count: group[1] });
    }
    const unknown = reordered.slice();
    unknown[2] = -1;
    expect(() =>
      indexOcctDisplayGroups(
        kernel,
        edges,
        unknown,
        wireframe.points.length,
        'edge'
      )
    ).toThrow('unique handles');
    const duplicate = reordered.slice();
    duplicate[5] = duplicate[2]!;
    expect(() =>
      indexOcctDisplayGroups(
        kernel,
        edges,
        duplicate,
        wireframe.points.length,
        'edge'
      )
    ).toThrow('unique handles');
    expect(() =>
      indexOcctDisplayGroups(
        kernel,
        [edges[0]!, edges[0]!],
        reordered,
        wireframe.points.length,
        'edge'
      )
    ).toThrow('ambiguous display hash');
    expect(() =>
      indexOcctDisplayGroups(
        kernel,
        edges,
        reordered.slice(1),
        wireframe.points.length,
        'edge'
      )
    ).toThrow('incomplete');
    const invalid = reordered.slice();
    invalid[1] = wireframe.points.length + 3;
    expect(() =>
      indexOcctDisplayGroups(
        kernel,
        edges,
        invalid,
        wireframe.points.length,
        'edge'
      )
    ).toThrow('invalid edge display range');
  });

  it.each([
    ['a-export-cone', 3, 1],
    ['a-export-sphere', 36, 2]
  ] as const)(
    'keeps all %s topology when display groups omit degenerate edges',
    async (id, edgeCount, omittedCount) => {
      const text = readFileSync(`test/parity/corpus/${id}.step`, 'utf8');
      const { document } = importDocument(text, id);
      const derived = await adapter.syncDocument(document);
      const edges =
        derived.bodyRepresentations[document.bodyOrder[0]!]!.topology!.edges;
      expect(derived.warnings).toEqual([]);
      expect(edges).toHaveLength(edgeCount);
      expect(edges.filter((edge) => edge.points.length === 0)).toHaveLength(
        omittedCount
      );
      expect(edges.every((edge) => edge.reference?.kind === 'edge')).toBe(true);
    }
  );

  it('qualifies the repaired wall-crossing boss against its circular-segment volume', async () => {
    const plate = kernel.makeBox(40, 24, 10);
    const boss = kernel.translate(kernel.makeCylinder(6, 20), 3, 12, 0);
    const fused = kernel.unifySameDomain(kernel.fuse(plate, boss));
    const closedForm =
      40 * 24 * 10 +
      Math.PI * 36 * 20 -
      (Math.PI * 36 - (36 * Math.acos(0.5) - 3 * Math.sqrt(27))) * 10;
    expect(kernel.isValid(fused)).toBe(true);
    expect(kernel.getVolume(fused)).toBeCloseTo(closedForm, 8);
    expect(kernel.getSubShapes(fused, 'solid')).toHaveLength(1);
    expect(kernel.getSubShapes(fused, 'face')).toHaveLength(9);
    expect(kernel.getSubShapes(fused, 'edge')).toHaveLength(21);

    const scenario = IMPORT_MODELING_SCENARIOS.find(
      (entry) => entry.key === 'boss-crossing-a-wall'
    )!;
    const derived = await adapter.syncDocument(
      await scenario.build(adapter.syncDocument.bind(adapter))
    );
    const bodies = derived.exportableBodyIds.map(
      (id) => derived.bodyRepresentations[id]!
    );
    expect(derived.warnings).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.volume).toBeCloseTo(closedForm, 8);
    expect(bodies[0]!.topology!.faces).toHaveLength(9);
    expect(bodies[0]!.topology!.edges).toHaveLength(21);
  });
});
