import { describe, expect, it } from 'vitest';
import type {
  EdgeWitnessV1,
  FaceWitnessV1,
  QuantizedTopologyPoint
} from '@openzcad/shared';
import {
  compileScript,
  customFeatureScriptError,
  evaluatePick,
  publishScript,
  runCustomFeature,
  sha256Hex,
  type CustomFeatureStepData,
  type ScriptPick,
  type TopologyView
} from './index';

const SCRIPT = `script "acme/tray" "1.0.0" api 1 {
  input round: length = \`5 mm\`
  input wall: length
  pick corners: edges 4 = edges().type("line").axis("z")
  step fillet { edges: #corners, radius: \`round\` }
  pick top: face = faces().normal("z").max("z")
  step shell { faces: #top, thickness: \`wall\` }
}`;

const q = (value: number) => Math.round(value / 1e-6);
const point = (x: number, y: number, z: number): QuantizedTopologyPoint => [
  q(x),
  q(y),
  q(z)
];

function face(
  hash: number,
  centroid: QuantizedTopologyPoint,
  analytic: FaceWitnessV1['analytic'],
  surfaceType = 'plane'
) {
  const witness: FaceWitnessV1 = {
    surfaceType,
    perimeter: 0,
    centroid,
    analytic,
    closure: { u: 'open', v: 'open' }
  };
  return { hash, witness };
}

function line(
  hash: number,
  from: QuantizedTopologyPoint,
  to: QuantizedTopologyPoint
) {
  const witness: EdgeWitnessV1 = {
    curveType: 'LINE',
    length: 0,
    closed: false,
    endpoints: [from, to],
    midpoint: from.map(
      (value, index) => (value + to[index]!) / 2
    ) as QuantizedTopologyPoint
  };
  return { hash, witness };
}

/** A 40×30×20 box's faces and edges, by witness. */
function box(): TopologyView {
  const plane = (axis: 0 | 1 | 2) =>
    ({
      kind: 'plane',
      normal: [0, 1, 2].map((i) =>
        i === axis ? 1000000000 : 0
      ) as QuantizedTopologyPoint,
      offset: 0
    }) as const;
  const faces = [
    face(1, point(20, 15, 0), plane(2)),
    face(2, point(20, 15, 20), plane(2)),
    face(3, point(0, 15, 10), plane(0)),
    face(4, point(40, 15, 10), plane(0)),
    face(5, point(20, 0, 10), plane(1)),
    face(6, point(20, 30, 10), plane(1))
  ];
  const corners = [
    [0, 0],
    [40, 0],
    [40, 30],
    [0, 30]
  ] as const;
  const edges = [
    ...corners.map(([x, y], index) =>
      line(10 + index, point(x, y, 0), point(x, y, 20))
    ),
    ...corners.map(([x, y], index) => {
      const [nx, ny] = corners[(index + 1) % 4]!;
      return line(20 + index, point(x, y, 0), point(nx, ny, 0));
    }),
    ...corners.map(([x, y], index) => {
      const [nx, ny] = corners[(index + 1) % 4]!;
      return line(30 + index, point(x, y, 20), point(nx, ny, 20));
    })
  ];
  return { faces, edges };
}

const radius = () => 0;

function pick(source: string, name: string): ScriptPick {
  const compiled = compileScript(source);
  expect(compiled.diagnostics.filter((d) => d.severity === 'error')).toEqual(
    []
  );
  return compiled.script!.picks.get(name)!;
}

function errors(source: string): string[] {
  return compileScript(source)
    .diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    .map(
      (diagnostic) =>
        `${diagnostic.span.start.line}:${diagnostic.span.start.column} ${diagnostic.message}`
    );
}

describe('custom-feature scripts (api 1)', () => {
  it('compiles a script into inputs, picks and steps', () => {
    const { script, diagnostics } = compileScript(SCRIPT);
    expect(diagnostics).toEqual([]);
    expect(script).toMatchObject({
      id: 'acme/tray',
      version: '1.0.0',
      api: 1,
      inputs: [
        { name: 'round', quantity: 'length', defaultValue: '5 mm' },
        { name: 'wall', quantity: 'length', defaultValue: null }
      ],
      steps: [
        { kind: 'fillet', pick: 'corners', size: 'round' },
        { kind: 'shell', pick: 'top', size: 'wall' }
      ]
    });
    expect(script!.picks.get('corners')).toEqual({
      name: 'corners',
      entity: 'edge',
      count: 4,
      filters: [
        { kind: 'type', value: 'line' },
        { kind: 'axis', axis: 2 }
      ]
    });
  });

  it('refuses a malformed script at its line and column', () => {
    expect(errors(SCRIPT.replace('"acme/tray"', '"Tray"'))).toEqual([
      '1:8 A script id is lower-case and namespaced, such as "acme/mounting-boss".'
    ]);
    expect(errors(SCRIPT.replace('"1.0.0"', '"1.0"'))).toEqual([
      '1:20 A script version is major.minor.patch, such as "1.0.0".'
    ]);
    expect(errors(SCRIPT.replace('api 1', 'api 2'))).toEqual([
      '1:32 This script is written for api 2; this release runs api 1.'
    ]);
    expect(errors(SCRIPT.replace('edges 4 =', 'edges ='))[0]).toMatch(
      /^4:17 Say how many edges #corners picks/
    );
    expect(errors(SCRIPT.replace('#corners, radius', '#top, radius'))).toEqual([
      '5:24 #top is not a pick declared above this step.'
    ]);
    expect(errors(SCRIPT.replace('faces: #top', 'faces: #corners'))).toEqual([
      '7:23 A shell takes faces; #corners picks edges.'
    ]);
    expect(errors(SCRIPT.replace('normal("z")', 'normal("w")'))).toEqual([
      '6:28 `normal` takes one axis: "x", "y" or "z".'
    ]);
    expect(errors(SCRIPT.replace('.axis("z")', '.near(1)'))[0]).toMatch(
      /`near` is not a query filter/
    );
    expect(errors(SCRIPT.replace('step shell', 'step loop'))[0]).toMatch(
      /`loop` is not a script step; api 1 runs fillet, chamfer and shell\./
    );
    expect(
      errors(SCRIPT.replace('input wall: length', 'input round: length'))[0]
    ).toMatch(/`round` is declared twice\./);
    expect(
      errors(SCRIPT.replace('radius: `round`', 'radius: `round`, depth: 2'))[0]
    ).toMatch(/A fillet step takes `edges` and `radius`, not `depth`\./);
    expect(errors('script "acme/x" "1.0.0" api 1 { }')).toEqual([
      '1:8 A script needs at least one step.'
    ]);
    // Syntax errors come from the shared parser.
    expect(errors(SCRIPT.replace('edges()', 'edges(')).length).toBe(1);
  });

  it('pins a script by the SHA-256 of its source', () => {
    // FIPS 180-2 test vectors.
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(
      sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3'
    );
    expect(sha256Hex('é✓')).toBe(sha256Hex('é✓'));
    const { script } = publishScript(SCRIPT);
    expect(script!.digest).toBe(sha256Hex(SCRIPT));
    expect(customFeatureScriptError(script!)).toBeNull();
    expect(
      customFeatureScriptError({ ...script!, source: `${SCRIPT} ` })
    ).toMatch(/does not match its pinned digest/);
    expect(customFeatureScriptError({ ...script!, version: '1.0.1' })).toMatch(
      /Script source says acme\/tray 1.0.0, but it is stored as acme\/tray 1.0.1\./
    );
  });

  it('evaluates picks exactly: filters, ties at an extreme and the declared count', () => {
    const topology = box();
    const corners = pick(SCRIPT, 'corners');
    expect(evaluatePick(corners, topology, radius)).toEqual([10, 11, 12, 13]);
    // Ties at an extreme are all kept, and the count decides: four top edges.
    const topEdges = pick(
      SCRIPT.replace('edges().type("line").axis("z")', 'edges().max("z")'),
      'corners'
    );
    expect(evaluatePick(topEdges, topology, radius)).toEqual([30, 31, 32, 33]);
    expect(evaluatePick(pick(SCRIPT, 'top'), topology, radius)).toEqual([2]);
    const bottom = pick(SCRIPT.replace('max("z")', 'min("z")'), 'top');
    expect(evaluatePick(bottom, topology, radius)).toEqual([1]);
    // An extreme keeps only the entities at it: one face at y max.
    const tied = pick(
      SCRIPT.replace(
        'pick top: face = faces().normal("z").max("z")',
        'pick top: face = faces().max("y")'
      ),
      'top'
    );
    expect(evaluatePick(tied, topology, radius)).toEqual([6]);
    const wrongCount = pick(
      SCRIPT.replace('edges 4 =', 'edges 3 ='),
      'corners'
    );
    expect(() => evaluatePick(wrongCount, topology, radius)).toThrow(
      'Pick #corners found 4 edges; it needs exactly 3.'
    );
    const none = pick(
      SCRIPT.replace('type("line")', 'type("circle")'),
      'corners'
    );
    expect(() => evaluatePick(none, topology, radius)).toThrow('found 0 edges');
  });

  it('runs steps in order, re-reading topology before each, with inputs in scope', () => {
    const { script } = compileScript(SCRIPT);
    const steps: CustomFeatureStepData[] = [];
    let reads = 0;
    runCustomFeature(
      script!,
      { wall: 'thickness * 2' },
      { thickness: 1.5 },
      'mm',
      {
        topology: () => {
          reads += 1;
          return box();
        },
        run: (step) => steps.push(step)
      }
    );
    expect(reads).toBe(2);
    expect(steps).toEqual([
      { featureKind: 'fillet', edgeHashes: [10, 11, 12, 13], radius: 5 },
      { featureKind: 'shell', openingFaceHashes: [2], thickness: 3 }
    ]);
  });

  it('refuses unknown, missing and mistyped inputs and a non-positive size', () => {
    const { script } = compileScript(SCRIPT);
    const host = { topology: box, run: () => undefined };
    expect(() =>
      runCustomFeature(script!, { wall: 1, depth: 2 }, {}, 'mm', host)
    ).toThrow('Script acme/tray has no input `depth`.');
    expect(() => runCustomFeature(script!, {}, {}, 'mm', host)).toThrow(
      'Input `wall` of acme/tray has no value and no default.'
    );
    expect(() =>
      runCustomFeature(script!, { wall: '30 deg' }, {}, 'mm', host)
    ).toThrow(/^Input `wall`: /);
    expect(() =>
      runCustomFeature(script!, { wall: 1, round: 0 }, {}, 'mm', host)
    ).toThrow('Step 1 (fillet): its size must be greater than zero.');
  });
});
