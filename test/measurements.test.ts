import { describe, expect, it } from 'vitest';
import type { BodyRepresentation, TopologySelection } from '@openzcad/shared';
import {
  appendMeasurement,
  canAppendMeasurement,
  createAngleMeasurement,
  createDistanceMeasurement,
  createSmartMeasurement,
  formatMeasurement,
  measurementTargetFromSelection,
  measurementsToCsv,
  measurementsToText,
  MEASUREMENT_LIMIT,
  refreshMeasurements,
  type Measurement,
  type MeasurementDisplayOptions
} from '../apps/web/src/lib/measurements';

const DISPLAY: MeasurementDisplayOptions = {
  unit: 'mm',
  precision: 2,
  radialDisplay: 'diameter'
};

function edge(index: number, value = index * 10): Measurement {
  return {
    id: `edge:body/${index}`,
    kind: 'edge-length',
    label: `Bracket · Edge ${index}`,
    targets: [
      {
        bodyId: 'body' as Measurement['targets'][number]['bodyId'],
        bodyName: 'Bracket',
        kind: 'edge',
        topologyId: `edge:${index}`,
        hash: index,
        label: `Bracket · Edge ${index}`,
        semantic: 'edge-midpoint',
        quality: 'exact-analytic'
      }
    ],
    result: { value, dimension: 'length' },
    quality: 'exact-kernel',
    status: 'current',
    sourceRevision: 1,
    sourceUnit: 'mm',
    visible: true
  };
}

function measuredBody(): BodyRepresentation {
  return {
    bodyId: 'body-1' as BodyRepresentation['bodyId'],
    name: 'Bracket',
    source: 'primitive',
    mesh: { kind: 'mesh', vertices: [], indices: [] },
    faceCount: 2,
    color: '#fff',
    exportableStep: true,
    consumed: false,
    volume: 6000,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 30 } },
    topology: {
      edges: [
        {
          topologyId: 'edge:x',
          hash: 11,
          length: 10,
          curve: { type: 'LINE' },
          points: [0, 0, 0, 10, 0, 0]
        },
        {
          topologyId: 'edge:y',
          hash: 12,
          length: 20,
          curve: { type: 'LINE' },
          points: [0, 0, 0, 0, 20, 0]
        },
        {
          topologyId: 'edge:circle',
          hash: 13,
          length: Math.PI * 8,
          curve: {
            type: 'CIRCLE',
            circle: {
              center: { x: 3, y: 4, z: 5 },
              axis: { x: 0, y: 0, z: 1 },
              radius: 4
            }
          },
          points: [7, 4, 5, 3, 8, 5, -1, 4, 5, 7, 4, 5]
        }
      ],
      faces: [
        {
          topologyId: 'face:top',
          hash: 21,
          triangleStart: 0,
          triangleCount: 2,
          geometry: {
            surfaceType: 'plane',
            area: 200,
            center: { x: 5, y: 10, z: 30 },
            normal: { x: 0, y: 0, z: 1 }
          }
        },
        {
          topologyId: 'face:hole',
          hash: 22,
          triangleStart: 2,
          triangleCount: 8,
          geometry: {
            surfaceType: 'cylinder',
            area: 120,
            center: { x: 3, y: 4, z: 15 },
            radius: 4,
            diameter: 8,
            axisStart: { x: 3, y: 4, z: 0 },
            axisEnd: { x: 3, y: 4, z: 30 },
            featureType: 'through-hole'
          }
        }
      ]
    }
  };
}

function selection(
  kind: TopologySelection['kind'],
  topologyId?: string,
  hash?: number
): TopologySelection {
  return {
    bodyId: 'body-1' as TopologySelection['bodyId'],
    kind,
    ...(topologyId ? { topologyId } : {}),
    ...(hash !== undefined ? { hash } : {})
  };
}

describe('measurement workbench records', () => {
  it('appends each new entity in pick order', () => {
    const list = [edge(1), edge(2)].reduce(
      appendMeasurement,
      [] as Measurement[]
    );
    expect(list.map((entry) => entry.label)).toEqual([
      'Bracket · Edge 1',
      'Bracket · Edge 2'
    ]);
  });

  it('does not duplicate an unchanged re-picked entity', () => {
    const once = appendMeasurement([], edge(1));
    const twice = appendMeasurement(once, edge(1));
    expect(twice).toHaveLength(1);
    expect(twice).toBe(once);
  });

  it('updates a raw value in place within the same stable identity', () => {
    const list = appendMeasurement(
      [edge(1, 84), edge(2, 20)].reduce(appendMeasurement, [] as Measurement[]),
      edge(1, 90)
    );
    expect(list).toHaveLength(2);
    expect(list[0]?.result.value).toBe(90);
    expect(list[1]?.result.value).toBe(20);
  });

  it('refuses past the limit rather than dropping the oldest row', () => {
    // This used to evict FIFO, which is a reasonable way to bound a scratch
    // tape and silent data loss the moment the list outlives the session: the
    // fifty-first measurement would quietly delete the first, and nothing
    // said so. The cap now holds and the caller reports it.
    let list: Measurement[] = [];
    for (let index = 0; index < MEASUREMENT_LIMIT + 5; index += 1) {
      list = appendMeasurement(list, edge(index));
    }
    expect(list).toHaveLength(MEASUREMENT_LIMIT);
    // The FIRST row survives — under FIFO it was the first thing thrown away.
    expect(list[0]?.label).toBe('Bracket · Edge 0');
    expect(list.at(-1)?.label).toBe(`Bracket · Edge ${MEASUREMENT_LIMIT - 1}`);
  });

  it('still updates a row already on a full list', () => {
    // A full list must not stop someone re-measuring something already on it:
    // that path replaces in place and cannot grow the list.
    let list: Measurement[] = [];
    for (let index = 0; index < MEASUREMENT_LIMIT; index += 1) {
      list = appendMeasurement(list, edge(index));
    }
    expect(canAppendMeasurement(list, edge(0, 999))).toBe(true);
    expect(canAppendMeasurement(list, edge(MEASUREMENT_LIMIT + 1))).toBe(false);

    const updated = appendMeasurement(list, edge(0, 999));
    expect(updated).toHaveLength(MEASUREMENT_LIMIT);
    expect(updated[0]?.result.value).toBe(999);
  });

  it('formats display units without changing the stored source value', () => {
    const measurement = edge(1, 25.4);
    expect(
      formatMeasurement(measurement, { ...DISPLAY, unit: 'inch', precision: 3 })
        .value
    ).toBe('1.000 in');
    expect(measurement.result.value).toBe(25.4);
  });

  it('copies formatted rows with provenance and status', () => {
    const body: Measurement = {
      ...edge(2, 14.21),
      id: 'body:b1',
      kind: 'body',
      label: 'Bracket',
      note: 'Inspection sample',
      targets: [
        {
          bodyId: 'b1' as Measurement['targets'][number]['bodyId'],
          bodyName: 'Bracket',
          kind: 'body',
          label: 'Bracket',
          semantic: 'body-center',
          quality: 'exact-kernel'
        }
      ],
      result: {
        value: 14.21,
        dimension: 'volume',
        components: { x: 84, y: 60, z: 35 }
      },
      // A volume is deflection-bounded where an edge length is not, so the two
      // rows in this one export deliberately carry different tiers.
      quality: 'tessellated' as const
    };
    const text = measurementsToText([edge(1, 84), body], DISPLAY);
    expect(text).toContain('Bracket · Edge 1\t84.00 mm\t\tExact\tcurrent\t');
    expect(text).toContain(
      'Bracket\t84.00 × 60.00 × 35.00 mm\tVolume 14.21 mm³\tKernel\tcurrent\tInspection sample'
    );
  });

  it('exports raw structured CSV and quotes unsafe labels', () => {
    const measurement = {
      ...edge(1, 84),
      label: 'Plate, left · Edge "A"'
    };
    const [header, row] = measurementsToCsv([measurement], DISPLAY).split('\n');
    expect(header).toContain('target_a,target_b,value,unit');
    expect(header).toContain('quality,status,source_revision,note');
    expect(row).toContain('"Plate, left · Edge ""A"""');
    expect(row).toContain(',84,mm,');
    // The CSV carries the precise tier, not the collapsed display label, so an
    // exported figure stays auditable after the row that produced it is gone.
    expect(row).toContain(',exact-kernel,current,1,');
  });

  it('neutralizes spreadsheet formulas in copied and CSV labels', () => {
    const measurement = { ...edge(1, 84), label: '=WEBSERVICE("bad")' };
    expect(measurementsToText([measurement], DISPLAY)).toContain(
      '\'=WEBSERVICE("bad")'
    );
    expect(measurementsToCsv([measurement], DISPLAY)).toContain(
      '"\'=WEBSERVICE(""bad"")"'
    );
  });

  it('creates exact edge, face-area, diameter, and body inspection records', () => {
    const body = measuredBody();
    const line = createSmartMeasurement(
      body,
      selection('edge', 'edge:x', 11),
      { x: 2, y: 0, z: 0 },
      4,
      'mm'
    );
    const area = createSmartMeasurement(
      body,
      selection('face', 'face:top', 21),
      { x: 2, y: 3, z: 30 },
      4,
      'mm'
    );
    const hole = createSmartMeasurement(
      body,
      selection('face', 'face:hole', 22),
      { x: 7, y: 4, z: 10 },
      4,
      'mm'
    );
    const bounds = createSmartMeasurement(
      body,
      selection('body'),
      undefined,
      4,
      'mm'
    );
    expect(line?.result.value).toBeCloseTo(10, 10);
    // An edge length is exact; the face area beside it is not, and the two no
    // longer share a tier.
    expect(line?.quality).toBe('exact-kernel');
    expect(area?.quality).toBe('tessellated');
    expect(area?.result.value).toBeCloseTo(200, 10);
    expect(hole?.result.value).toBeCloseTo(8, 10);
    expect(bounds?.result.components).toEqual({ x: 10, y: 20, z: 30 });
  });

  it('measures exact semantic centers and stable entity directions', () => {
    const body = measuredBody();
    const circle = measurementTargetFromSelection(
      body,
      selection('edge', 'edge:circle', 13),
      { x: 7, y: 4, z: 5 },
      'distance'
    );
    const bodyTarget = measurementTargetFromSelection(
      body,
      selection('body'),
      undefined,
      'distance'
    );
    expect(circle?.semantic).toBe('circle-center');
    expect(circle?.point).toEqual({ x: 3, y: 4, z: 5 });
    const measured = createDistanceMeasurement(circle!, bodyTarget!, 4, 'mm');
    expect(measured?.result.components).toEqual({ x: 2, y: 6, z: 10 });
    expect(measured?.result.value).toBeCloseTo(Math.sqrt(140), 10);

    const x = measurementTargetFromSelection(
      body,
      selection('edge', 'edge:x', 11),
      undefined,
      'angle'
    );
    const y = measurementTargetFromSelection(
      body,
      selection('edge', 'edge:y', 12),
      undefined,
      'angle'
    );
    expect(createAngleMeasurement(x!, y!, 4, 'mm')?.result.value).toBeCloseTo(
      90,
      10
    );
  });

  it('recomputes resolvable topology and fails closed for removed topology', () => {
    const body = measuredBody();
    const original = createSmartMeasurement(
      body,
      selection('edge', 'edge:x', 11),
      undefined,
      4,
      'mm'
    )!;
    const resized = measuredBody();
    resized.topology!.edges[0]!.length = 12;
    const refreshed = refreshMeasurements([original], [resized], 5)[0]!;
    expect(refreshed.status).toBe('current');
    expect(refreshed.result.value).toBeCloseTo(12, 10);

    resized.topology!.edges = resized.topology!.edges.slice(1);
    const unresolved = refreshMeasurements([refreshed], [resized], 6)[0]!;
    expect(unresolved.status).toBe('unresolved');
    expect(unresolved.result.value).toBeCloseTo(12, 10);
  });
});
