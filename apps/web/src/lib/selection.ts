import type { BodyId, EditableDimension } from '@openzcad/shared';

export type ModelingTool = 'select' | 'fillet';

export interface SelectionAnchor {
  x: number;
  y: number;
}

interface BaseGeometrySelection {
  bodyId: BodyId;
  bodyName: string;
  anchor: SelectionAnchor;
}

export interface FaceSelection extends BaseGeometrySelection {
  kind: 'face';
  primitiveKind: 'box' | 'cylinder' | 'sphere';
  faceKey: string;
  materialIndex: number;
  dimension: EditableDimension;
  axis: 'x' | 'y' | 'z';
  side: -1 | 1;
  value: number;
}

export interface EdgeSelection extends BaseGeometrySelection {
  kind: 'edge';
  edgeKey: string;
  meshIndex: number;
  segmentIndex: number;
  filletSupported: boolean;
  maxFilletRadius: number;
}

export type GeometrySelection = FaceSelection | EdgeSelection;
