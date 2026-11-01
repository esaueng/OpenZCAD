/**
 * The written loss contract for every exchange format: what an export →
 * reimport keeps, and what it drops by design. `docs/exchange-loss-contract.md`
 * is the prose version; `test/exchange-round-trip.test.ts` measures every
 * line here, so a writer that starts dropping a kept property — or quietly
 * starts keeping a dropped one — fails a test instead of drifting from the
 * document.
 */

/** Properties of a solid export a round trip can keep. */
export type SolidProperty =
  | 'body-count'
  | 'bounds'
  | 'volume'
  | 'watertight'
  | 'exact-faces'
  | 'declared-units'
  | 'body-names'
  | 'body-colors'
  | 'history';

/** Properties of a sketch export a round trip can keep. */
export type SketchProperty =
  | 'curve-kinds'
  | 'coordinates'
  | 'declared-units'
  | 'constraints'
  | 'construction'
  | 'plane';

export interface SolidFormatContract {
  kind: 'solid';
  label: string;
  keeps: readonly SolidProperty[];
  drops: readonly SolidProperty[];
  /** How the reimport reads the file's length unit. */
  units: 'declared' | 'bare-numbers' | 'metres';
  /** Why each dropped property is dropped, in one line. */
  notes: Partial<Record<SolidProperty, string>>;
}

export interface SketchFormatContract {
  kind: 'sketch';
  label: string;
  keeps: readonly SketchProperty[];
  drops: readonly SketchProperty[];
  /** False for a write-only format: there is no reader to round-trip. */
  reimport: boolean;
  notes: Partial<Record<SketchProperty, string>>;
}

const MESH_DROPS = {
  'exact-faces':
    'Curved faces arrive as triangles within the chosen chord and angle tolerances.',
  'body-names': 'The writer emits no object or group names.',
  'body-colors': 'No colour or material is written (I04).',
  history: 'Features, sketches and parameters are not part of the file.'
} as const;

export const EXCHANGE_LOSS_CONTRACT = {
  step: {
    kind: 'solid',
    label: 'STEP (AP214)',
    keeps: [
      'body-count',
      'bounds',
      'volume',
      'watertight',
      'exact-faces',
      'declared-units',
      'body-names',
      'body-colors'
    ],
    drops: ['history'],
    units: 'declared',
    notes: {
      history:
        'The reimport is one imported solid per body; features, sketches and parameters are not transferred.'
    }
  },
  'stl-binary': {
    kind: 'solid',
    label: 'STL (binary)',
    keeps: ['bounds', 'volume', 'watertight'],
    drops: [
      'body-count',
      'exact-faces',
      'declared-units',
      'body-names',
      'body-colors',
      'history'
    ],
    units: 'bare-numbers',
    notes: {
      ...MESH_DROPS,
      'body-count': 'Every body is one facet stream; the reimport is one body.',
      'declared-units':
        'STL has no unit field: the import asks, and must be told the export unit.'
    }
  },
  stl: {
    kind: 'solid',
    label: 'STL (ASCII)',
    keeps: ['bounds', 'volume', 'watertight'],
    drops: [
      'body-count',
      'exact-faces',
      'declared-units',
      'body-names',
      'body-colors',
      'history'
    ],
    units: 'bare-numbers',
    notes: {
      ...MESH_DROPS,
      'body-count':
        'Every body shares one solid block, which several readers require; the reimport is one body.',
      'declared-units':
        'STL has no unit field: the import asks, and must be told the export unit.'
    }
  },
  '3mf': {
    kind: 'solid',
    label: '3MF',
    keeps: ['bounds', 'volume', 'watertight', 'declared-units'],
    drops: [
      'body-count',
      'exact-faces',
      'body-names',
      'body-colors',
      'history'
    ],
    units: 'declared',
    notes: {
      ...MESH_DROPS,
      'body-count':
        'The package keeps one object per body, but the import merges them into one body (ZC-184).'
    }
  },
  obj: {
    kind: 'solid',
    label: 'OBJ',
    keeps: ['bounds', 'volume', 'watertight'],
    drops: [
      'body-count',
      'exact-faces',
      'declared-units',
      'body-names',
      'body-colors',
      'history'
    ],
    units: 'bare-numbers',
    notes: {
      ...MESH_DROPS,
      'body-count': 'One merged mesh; the reimport is one body.',
      'declared-units':
        'OBJ has no unit field: the import asks, and must be told the export unit.'
    }
  },
  ply: {
    kind: 'solid',
    label: 'PLY (binary)',
    keeps: ['bounds', 'volume', 'watertight'],
    drops: [
      'body-count',
      'exact-faces',
      'declared-units',
      'body-names',
      'body-colors',
      'history'
    ],
    units: 'bare-numbers',
    notes: {
      ...MESH_DROPS,
      'body-count': 'One merged mesh; the reimport is one body.',
      'declared-units':
        'PLY has no unit field: the import asks, and must be told the export unit.'
    }
  },
  glb: {
    kind: 'solid',
    label: 'glTF (GLB)',
    keeps: ['bounds', 'volume', 'watertight', 'declared-units'],
    drops: [
      'body-count',
      'exact-faces',
      'body-names',
      'body-colors',
      'history'
    ],
    units: 'metres',
    notes: {
      ...MESH_DROPS,
      'body-count':
        'One merged mesh under one root node; the reimport is one body.',
      'declared-units':
        'glTF is metres and +Y up by definition; the export unit does not apply.'
    }
  },
  dxf: {
    kind: 'sketch',
    label: 'DXF (R12, whole sketch)',
    reimport: true,
    keeps: ['curve-kinds', 'coordinates', 'declared-units'],
    drops: ['constraints', 'construction', 'plane'],
    notes: {
      constraints:
        'Constraints, dimensions and rectangle/polygon identity are not written; a rectangle returns as four lines.',
      construction: 'Construction geometry is left out of the drawing.',
      plane:
        'Coordinates are sketch-local; the import places the sketch on Top (XY).'
    }
  },
  svg: {
    kind: 'sketch',
    label: 'SVG (whole sketch)',
    reimport: false,
    keeps: ['curve-kinds', 'coordinates', 'declared-units'],
    drops: ['constraints', 'construction', 'plane'],
    notes: {
      constraints:
        'Write-only: there is no SVG import (I07), so nothing comes back; the file itself states its physical size and keeps lines, circles and arcs.',
      construction: 'Construction geometry is left out of the drawing.',
      plane: 'Coordinates are sketch-local, Y flipped for SVG.'
    }
  }
} as const satisfies Record<string, SolidFormatContract | SketchFormatContract>;

export type ExchangeFormat = keyof typeof EXCHANGE_LOSS_CONTRACT;
