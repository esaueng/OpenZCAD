import { describe, expect, it } from 'vitest';

import { resolveShaprImportLimits } from './limits';
import { parseWorkspace269 } from './schema-v269';
import type { ShaprDatabase, ShaprDatabaseRow } from './types';
import type { ShaprArchiveEntry, ShaprArchiveInspection } from './zip';

const tableColumns: Record<string, string[]> = {
  Settings: ['SettingName', 'SettingValue'],
  HistoryTreeNodes: ['HistoryTreeNodeID', 'HistoryTreeNodeType', 'Properties'],
  SketchControllers: [
    'SketchID',
    'Name',
    'IsHidden',
    'PlaneCenterX',
    'PlaneCenterY',
    'PlaneCenterZ',
    'PlaneNormX',
    'PlaneNormY',
    'PlaneNormZ',
    'PlaneUDirX',
    'PlaneUDirY',
    'PlaneUDirZ'
  ],
  SketchCurves: ['CurveID', 'SketchID', 'Data', 'IsMissingReference'],
  Constraints: ['RowID', 'SketchID', 'Data', 'IsBroken'],
  HistorySketchConstraints: [
    'DescriptorID',
    'SketchID',
    'ConstraintType',
    'Data'
  ],
  HistoryImportedBodies: ['ImportedBodyID', 'ImportedPrototypeID', 'Transform'],
  HistoryImportedPrototypes: ['ImportedPrototypeID', 'BodyData'],
  BodyRevisionBlocks: [
    'PartitionID',
    'ChunkIndex',
    'Block',
    'Phase',
    'IsDeleted'
  ],
  BodyRevisionDeltas: [
    'PartitionID',
    'ChunkIndex',
    'Delta',
    'Phase',
    'IsDeleted'
  ]
};

function concat(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function packedString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  return concat(new Uint8Array([0xa0 | bytes.byteLength]), bytes);
}

function packedFloat(value: number): Uint8Array {
  const bytes = new Uint8Array(9);
  bytes[0] = 0xcb;
  new DataView(bytes.buffer).setFloat64(1, value, false);
  return bytes;
}

class FixtureDatabase implements ShaprDatabase {
  constructor(private readonly workspaceVersion = 269) {}

  all(sql: string): ShaprDatabaseRow[] {
    if (sql.startsWith('SELECT name FROM sqlite_schema')) {
      return Object.keys(tableColumns).map((name) => ({ name }));
    }
    const tableInfo = /^PRAGMA table_info\("([^"]+)"\)$/.exec(sql);
    if (tableInfo) {
      return (tableColumns[tableInfo[1]!] ?? []).map((name) => ({ name }));
    }
    if (sql === 'PRAGMA quick_check(1)') return [{ quick_check: 'ok' }];
    if (sql.startsWith('SELECT SettingName, SettingValue FROM Settings')) {
      return [
        {
          SettingName: 'WorkspaceSchemaVersion',
          SettingValue: this.workspaceVersion
        },
        { SettingName: 'SchemaVersion', SettingValue: 307000 },
        { SettingName: 'HistoryVersion', SettingValue: 100 },
        { SettingName: 'Persistence_ProjectVersion', SettingValue: 249000 }
      ];
    }
    if (sql.startsWith('SELECT COUNT(*) AS rowCount FROM')) {
      const table = /FROM "([^"]+)"/.exec(sql)?.[1];
      const counts: Record<string, number> = {
        HistoryTreeNodes: 2,
        SketchControllers: 1,
        SketchCurves: 1,
        Constraints: 0,
        HistorySketchConstraints: 0
      };
      return [{ rowCount: counts[table ?? ''] ?? 0 }];
    }
    if (sql.startsWith('SELECT CurveID, SketchID')) {
      return [
        {
          CurveID: 10,
          SketchID: 5,
          Data: JSON.stringify({
            type: 0,
            start: { x: 0, y: 0 },
            end: { x: 1, y: 2 }
          }),
          IsMissingReference: 0
        }
      ];
    }
    if (sql.startsWith('SELECT RowID, SketchID')) return [];
    if (sql.startsWith('SELECT DescriptorID, SketchID')) return [];
    if (sql.startsWith('SELECT SketchID, Name')) {
      return [
        {
          SketchID: 5,
          Name: 'Sketch 01',
          IsHidden: 0,
          PlaneCenterX: 0,
          PlaneCenterY: 0,
          PlaneCenterZ: 0,
          PlaneNormX: 0,
          PlaneNormY: 0,
          PlaneNormZ: 1,
          PlaneUDirX: 1,
          PlaneUDirY: 0,
          PlaneUDirZ: 0
        }
      ];
    }
    if (sql.startsWith('SELECT HistoryTreeNodeID')) {
      return [
        {
          HistoryTreeNodeID: 1,
          HistoryTreeNodeType: 3,
          Properties: concat(new Uint8Array([0x91]), packedFloat(0.01))
        },
        {
          HistoryTreeNodeID: 2,
          HistoryTreeNodeType: 2,
          Properties: concat(
            new Uint8Array([0x95, 0x02, 0xc0]),
            packedString('Extrusion 01'),
            packedString('Extrude'),
            new Uint8Array([0x91, 0x01])
          )
        }
      ];
    }
    if (sql.includes(' AS value FROM ')) return [{ value: 0 }];
    throw new Error(`Unexpected fixture query: ${sql}`);
  }

  close(): void {}
}

const workspace: ShaprArchiveEntry = {
  name: 'workspace',
  compressedBytes: 100,
  uncompressedBytes: 200,
  compression: 8
};
const archive: ShaprArchiveInspection = {
  entries: [workspace],
  workspace,
  declaredOutputBytes: workspace.uncompressedBytes
};

describe('SHAPR workspace-269 adapter', () => {
  it('produces versioned, non-operative sketch and operation evidence', () => {
    const result = parseWorkspace269(
      new FixtureDatabase(),
      archive,
      120,
      'checksum',
      resolveShaprImportLimits()
    );

    expect(result.schemaAdapter).toBe('workspace-269');
    expect(result.sketches).toMatchObject([
      {
        sourceSketchId: 5,
        curves: [{ kind: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 2 } }]
      }
    ]);
    expect(result.operations).toMatchObject([
      {
        name: 'Extrusion 01',
        token: 'Extrude',
        kind: 'extrude',
        status: 'candidate',
        numericCandidates: [0.01]
      }
    ]);
    expect(result.units.evidence).toBe('inferred');
  });

  it('rejects an unrecognized schema tuple instead of guessing', () => {
    expect(() =>
      parseWorkspace269(
        new FixtureDatabase(270),
        archive,
        120,
        'checksum',
        resolveShaprImportLimits()
      )
    ).toThrow('Unsupported SHAPR schema 270/307000/100/249000');
  });
});
