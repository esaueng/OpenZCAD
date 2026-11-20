import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  toBodyId,
  toUserId,
  type BodyTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { TopologyTransport, unpackReplyTopologies } from './topologyTransport';
import {
  copyDerivedMeshBuffers,
  derivedMeshTransferables
} from './meshTransport';

const id = toBodyId('body_wire');
function projection(topology: unknown): ProjectDocument['derived'] {
  return {
    ...createProjectDocument('Transport', toUserId('user')).derived,
    bodyRepresentations: {
      [id]: {
        bodyId: id,
        name: 'Box',
        source: 'primitive',
        mesh: {
          kind: 'mesh',
          vertices: new Float32Array([1, 2, 3]),
          indices: new Uint32Array([0])
        },
        bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
        faceCount: 0,
        color: '#ffffff',
        consumed: false,
        exportableStep: true,
        volume: 1,
        topology: topology as BodyTopology
      }
    }
  };
}
const tree = () => ({
  faces: [],
  edges: [],
  extra: {
    text: '曲面\ud800',
    number: 1 / 3,
    small: Number.MIN_VALUE,
    flag: true,
    nil: null
  }
});

describe('explicit reply topology transport', () => {
  it('encodes adapter optional fields in v2, preserving own keys, order and null values', () => {
    const topology = {
      faces: [
        {
          topologyId: 'face:hash',
          hash: 'hash',
          reference: undefined,
          triangleStart: 0,
          triangleCount: 2,
          geometry: { kind: 'plane' },
          extra: null
        }
      ],
      edges: [
        {
          topologyId: 'edge:hash',
          hash: 'hash',
          reference: undefined,
          length: 1,
          displayRole: 'boundary',
          isSmooth: undefined,
          adjacentFaceHashes: ['hash']
        }
      ],
      values: [undefined, null, '曲面'],
      ...Object.fromEntries([
        ['__proto__', undefined],
        ['a/b~曲面', undefined]
      ])
    };
    const source = projection(topology);
    const transport = new TopologyTransport();
    expect(transport.pack(source)).toEqual({ derived: source });
    const receive = () => {
      const packet = transport.pack(source, 'json-v2');
      expect(packet.topologyJson).toBeDefined();
      expect(packet.topologyUndefined).toBeDefined();
      const copy = structuredClone(packet);
      unpackReplyTopologies(
        copy.derived,
        copy.topologyJson,
        copy.topologyUndefined
      );
      const restored = copy.derived.bodyRepresentations[id]!.topology!;
      expect(restored).toStrictEqual(structuredClone(topology));
      expect(Object.keys(restored)).toEqual(Object.keys(topology));
      expect(Object.keys(restored.faces[0]!)).toEqual(
        Object.keys(topology.faces[0]!)
      );
      expect(Object.hasOwn(restored.faces[0]!, 'reference')).toBe(true);
      expect(Object.hasOwn(restored, '__proto__')).toBe(true);
      expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
      return restored;
    };
    receive().faces.push({} as never);
    receive();
    // A cached v2 entry must never send null placeholders to a v1 receiver.
    expect(transport.pack(source, 'json-v1')).toEqual({ derived: source });
    for (const value of [
      new Array(1),
      Object.assign([], { extra: undefined })
    ]) {
      const unsupported = projection({ faces: [], edges: [], value });
      expect(transport.pack(unsupported, 'json-v2')).toEqual({
        derived: unsupported
      });
    }
  });

  it('adopts no topology when a later body has invalid markers', () => {
    const source = projection({ faces: [], edges: [], value: undefined });
    const otherId = toBodyId('other');
    source.bodyRepresentations[otherId] = {
      ...source.bodyRepresentations[id]!,
      bodyId: otherId,
      topology: { faces: [], edges: [], value: undefined } as BodyTopology
    };
    const packet = structuredClone(
      new TopologyTransport().pack(source, 'json-v2')
    );
    packet.topologyUndefined![otherId] = '[["missing"]]';
    expect(() =>
      unpackReplyTopologies(
        packet.derived,
        packet.topologyJson,
        packet.topologyUndefined
      )
    ).toThrow();
    for (const body of Object.values(packet.derived.bodyRepresentations))
      expect(body.topology).toBeUndefined();
  });

  it.each([
    'null',
    '{}',
    '[[]]',
    '[[1]]',
    '[["missing"]]',
    '[["faces"]]',
    '[["value","missing"]]',
    '[["constructor","prototype"]]',
    '[["value"] , ["value"]]',
    '[["nil","nested"]]',
    JSON.stringify([Array.from({ length: 514 }, () => 'nested')])
  ])('rejects invalid undefined paths atomically: %s', (paths) => {
    const source = projection({
      faces: [],
      edges: [],
      value: undefined,
      nil: null
    });
    const packet = structuredClone(
      new TopologyTransport().pack(source, 'json-v2')
    );
    expect(() =>
      unpackReplyTopologies(packet.derived, packet.topologyJson, {
        [id]: paths
      })
    ).toThrow();
    expect(packet.derived.bodyRepresentations[id]!.topology).toBeUndefined();
  });

  it('requires a matching JSON entry and bounds marker text before parsing', () => {
    const source = projection(tree());
    for (const [json, markers] of [
      [undefined, { [id]: '[]' }],
      [{ [id]: '{"faces":[],"edges":[]}' }, { missing: '[]' }],
      [
        { [id]: '{"faces":[],"edges":[]}' },
        { [id]: ' '.repeat(8 * 1024 * 1024) }
      ]
    ] as const) {
      expect(() => unpackReplyTopologies(source, json, markers)).toThrow();
    }
    const value = projection({ faces: [], edges: [], value: undefined });
    expect(new TopologyTransport(100).pack(value, 'json-v2')).toEqual({
      derived: value
    });
  });

  it.each([
    { name: 'number', value: 1 },
    { name: 'string', value: 'not topology' },
    { name: 'boolean', value: true },
    { name: 'array', value: [] },
    { name: 'missing faces', value: { edges: [] } },
    { name: 'invalid edges', value: { faces: [], edges: 1 } },
    {
      name: 'non-enumerable faces',
      value: Object.defineProperty({ edges: [] }, 'faces', {
        value: [],
        enumerable: false
      })
    }
  ])(
    'leaves an unrecognized topology root on the legacy path: $name',
    ({ value }) => {
      const source = projection(value);
      const packet = new TopologyTransport().pack(source);
      expect(packet.topologyJson).toBeUndefined();
      expect(packet.derived).toBe(source);
    }
  );

  it.each(['root', 'map', 'body', 'topology'] as const)(
    'falls back without evaluating an enumerable %s getter',
    (place) => {
      const source = projection(tree());
      const body = source.bodyRepresentations[id]!;
      const value: unknown =
        place === 'root'
          ? source.bodyRepresentations
          : place === 'map'
            ? body
            : place === 'topology'
              ? body.topology
              : body.name;
      const read = vi.fn(() => value);
      const target =
        place === 'root'
          ? source
          : place === 'map'
            ? source.bodyRepresentations
            : source.bodyRepresentations[id]!;
      const key =
        place === 'root'
          ? 'bodyRepresentations'
          : place === 'map'
            ? id
            : place === 'topology'
              ? 'topology'
              : 'name';
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: true,
        get: read
      });
      const packet = new TopologyTransport().pack(source);
      expect(packet).toEqual({ derived: source });
      expect(read).not.toHaveBeenCalled();
      structuredClone(packet);
      expect(read).toHaveBeenCalledOnce();
    }
  );

  it('does not publish a non-enumerable topology or read its getter', () => {
    const source = projection(tree());
    const read = vi.fn(() => tree());
    Object.defineProperty(source.bodyRepresentations[id]!, 'topology', {
      enumerable: false,
      configurable: true,
      get: read
    });
    const packet = new TopologyTransport().pack(source);
    const received = structuredClone(packet);
    expect(read).not.toHaveBeenCalled();
    expect(received.derived).toStrictEqual(structuredClone(source));
    expect(
      Object.hasOwn(received.derived.bodyRepresentations[id]!, 'topology')
    ).toBe(false);
  });

  it('keeps a large ASCII publication inside the same cache budget with UTF-8', () => {
    const source = projection({ faces: [], edges: [], note: 'a'.repeat(160) });
    const body = source.bodyRepresentations[id]!;
    for (let i = 0; i < 16; i += 1) {
      const bodyId = toBodyId(`body_${i}`);
      source.bodyRepresentations[bodyId] = {
        ...body,
        bodyId,
        topology: structuredClone(body.topology!)
      };
    }
    const transport = new TopologyTransport(6500);
    expect(transport.pack(source, 'json-v2').topologyJson).toBeUndefined();
    const packet = structuredClone(transport.pack(source, 'utf8-v1'));
    expect(Object.keys(packet.topologyJson!)).toHaveLength(17);
    expect(ArrayBuffer.isView(packet.topologyJson![id])).toBe(true);
    unpackReplyTopologies(packet.derived, packet.topologyJson);
    expect(packet.derived).toStrictEqual(source);
    expect(transport.pack(source, 'json-v2').topologyJson).toBeUndefined();
  });

  it('round-trips UTF-8, unpaired surrogates and optional properties across encodings', () => {
    const source = projection({ ...tree(), missing: undefined });
    const transport = new TopologyTransport();
    for (const encoding of ['utf8-v1', 'json-v2', 'utf8-v1'] as const) {
      const packet = structuredClone(transport.pack(source, encoding));
      expect(typeof packet.topologyJson![id]).toBe(
        encoding === 'json-v2' ? 'string' : 'object'
      );
      unpackReplyTopologies(
        packet.derived,
        packet.topologyJson,
        packet.topologyUndefined
      );
      expect(packet.derived).toStrictEqual(source);
      if (encoding === 'utf8-v1') {
        const payload = packet.topologyJson![id] as Uint8Array;
        payload.fill(0);
        const again = structuredClone(transport.pack(source, encoding));
        unpackReplyTopologies(
          again.derived,
          again.topologyJson,
          again.topologyUndefined
        );
        expect(again.derived).toStrictEqual(source);
      }
    }
  });

  it('rejects invalid UTF-8 before installing any body topology', () => {
    const source = projection(tree());
    const other = toBodyId('body_other');
    source.bodyRepresentations[other] = {
      ...source.bodyRepresentations[id]!,
      bodyId: other,
      topology: structuredClone(source.bodyRepresentations[id]!.topology!)
    };
    const packet = structuredClone(
      new TopologyTransport().pack(source, 'utf8-v1')
    );
    packet.topologyJson![other] = new Uint8Array([0xc0, 0x80]);
    expect(() =>
      unpackReplyTopologies(packet.derived, packet.topologyJson)
    ).toThrow();
    expect(packet.derived.bodyRepresentations[id]!.topology).toBeUndefined();
    expect(packet.derived.bodyRepresentations[other]!.topology).toBeUndefined();
  });

  it('bounds the aggregate encoded publication as well as individual cache entries', () => {
    const source = projection({ faces: [], edges: [] });
    const body = source.bodyRepresentations[id]!;
    for (const name of ['body_second', 'body_third']) {
      const bodyId = toBodyId(name);
      source.bodyRepresentations[bodyId] = {
        ...body,
        bodyId,
        topology: { faces: [], edges: [] }
      };
    }
    const packet = new TopologyTransport(400).pack(source);
    expect(packet.topologyJson).toBeUndefined();
    expect(packet.derived).toBe(source);
    expect(structuredClone(packet.derived)).toStrictEqual(
      structuredClone(source)
    );
  });

  it('round-trips values, own __proto__ properties and key order like structuredClone', () => {
    const topology = {
      ...tree(),
      ...(JSON.parse('{"__proto__":{"safe":true}}') as object)
    };
    const source = projection(topology);
    const packet = new TopologyTransport().pack(source);
    expect(packet.topologyJson).toBeDefined();
    expect(source.bodyRepresentations[id]!.topology).toBe(topology);
    const received = structuredClone(packet);
    unpackReplyTopologies(received.derived, received.topologyJson);
    expect(received.derived).toStrictEqual(structuredClone(source));
    expect(
      Object.keys(received.derived.bodyRepresentations[id]!.topology!)
    ).toEqual(Object.keys(topology));
    expect(Object.keys(received.derived.bodyRepresentations[id]!)).toEqual(
      Object.keys(source.bodyRepresentations[id]!)
    );
    expect(
      Object.getPrototypeOf(received.derived.bodyRepresentations[id]!.topology)
    ).toBe(Object.prototype);
  });

  it.each([
    ['undefined', () => ({ value: undefined })],
    ['negative zero', () => ({ value: -0 })],
    ['NaN', () => ({ value: NaN })],
    ['infinity', () => ({ value: Infinity })],
    ['bigint', () => ({ value: 1n })],
    ['sparse array', () => ({ value: new Array(2) })],
    [
      'array extra property',
      () => ({ value: Object.assign([], { extra: 1 }) })
    ],
    [
      'nonenumerable array index',
      () => ({ value: Object.defineProperty([1], '0', { enumerable: false }) })
    ],
    ['Date', () => ({ value: new Date(0) })],
    ['Map', () => ({ value: new Map([['key', 1]]) })],
    ['Set', () => ({ value: new Set([1]) })],
    ['typed array', () => ({ value: new Float64Array([1]) })],
    [
      'custom prototype',
      () => ({ value: Object.create({ inherited: 1 }) as object })
    ],
    ['toJSON', () => ({ value: { toJSON: () => 'different' } })],
    ['symbol key', () => ({ [Symbol('key')]: 1 })],
    [
      'shared object',
      () => {
        const value = {};
        return { a: value, b: value };
      }
    ],
    [
      'cycle',
      () => {
        const value: { self?: object } = {};
        value.self = value;
        return value;
      }
    ]
  ])('retains native structured-clone behavior for %s', (_label, extra) => {
    const source = projection({ ...tree(), ...extra() });
    expect(new TopologyTransport().pack(source)).toEqual({ derived: source });
  });

  it('does not call accessors while checking the topology fast path', () => {
    const getter = vi.fn(() => 1);
    const topology = Object.defineProperty(tree(), 'value', {
      enumerable: true,
      get: getter
    });
    const source = projection(topology);
    expect(new TopologyTransport().pack(source).topologyJson).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it('falls back for shared topology between bodies and into other metadata', () => {
    const topology = tree();
    const source = projection(topology);
    const otherId = toBodyId('other');
    source.bodyRepresentations[otherId] = {
      ...source.bodyRepresentations[id]!,
      bodyId: otherId
    };
    const transport = new TopologyTransport();
    expect(transport.pack(source).topologyJson).toBeUndefined();
    source.bodyRepresentations[otherId].topology = {
      ...tree(),
      edges: topology.edges
    };
    expect(transport.pack(source).topologyJson).toBeUndefined();
    delete source.bodyRepresentations[otherId];
    Object.assign(source.bodyRepresentations[id]!.bbox, {
      extra: topology.extra
    });
    expect(transport.pack(source).topologyJson).toBeUndefined();
    const received = structuredClone(transport.pack(source).derived);
    expect(
      (received.bodyRepresentations[id]!.bbox as unknown as { extra: object })
        .extra
    ).toBe(
      (
        received.bodyRepresentations[id]!.topology as unknown as {
          extra: object;
        }
      ).extra
    );
  });

  it('uses cached text but gives each reply fresh topology and transferable buffers', () => {
    const source = projection(tree());
    const transport = new TopologyTransport();
    const receive = () => {
      const packet = transport.pack(copyDerivedMeshBuffers(source));
      expect(packet.topologyJson).toBeDefined();
      const received = structuredClone(packet, {
        transfer: derivedMeshTransferables(packet.derived)
      });
      unpackReplyTopologies(received.derived, received.topologyJson);
      return received.derived;
    };
    const first = receive();
    first.bodyRepresentations[id]!.topology!.faces.push({} as never);
    first.bodyRepresentations[id]!.mesh.vertices[0] = 42;
    const second = receive();
    expect(second).toStrictEqual(source);
    expect(source.bodyRepresentations[id]!.mesh.vertices.byteLength).toBe(12);
    expect(second.bodyRepresentations[id]!.topology).not.toBe(
      source.bodyRepresentations[id]!.topology
    );
  });

  it('bounds retained text and node references, falling back if an entry cannot fit', () => {
    const source = projection(tree());
    expect(new TopologyTransport(1).pack(source).topologyJson).toBeUndefined();
    const transport = new TopologyTransport(1024);
    for (let index = 0; index < 20; index++) {
      const value = projection({ faces: [], edges: [], index });
      const packet = structuredClone(transport.pack(value));
      expect(packet.topologyJson).toBeDefined();
      unpackReplyTopologies(packet.derived, packet.topologyJson);
      expect(packet.derived).toStrictEqual(value);
    }
  });

  it('accepts old replies and rejects invalid encodings before changing any body', () => {
    const source = projection(tree());
    expect(() => unpackReplyTopologies(source)).not.toThrow();
    const packet = new TopologyTransport().pack(source);
    for (const text of [
      { missing: '{"faces":[],"edges":[]}' },
      { [id]: 'null' },
      { [id]: '{"faces":[]}' },
      { [id]: '{' },
      { [id]: '{"faces":[],"edges":[]}', missing: '{}' }
    ]) {
      expect(() => unpackReplyTopologies(packet.derived, text)).toThrow();
      expect(packet.derived.bodyRepresentations[id]!.topology).toBeUndefined();
    }
    expect(() =>
      unpackReplyTopologies(source, { [id]: '{"faces":[],"edges":[]}' })
    ).toThrow();
  });
});
