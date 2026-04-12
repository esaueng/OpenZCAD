import { listNodesByKind } from '@openzcad/document-core';
import {
  DEFAULT_BODY_COLOR,
  identityTransform,
  nowIso,
  type BodyId,
  type BodyRepresentation,
  type FeatureNode,
  type MeshGeometry,
  type PrimitiveGeometry,
  type ProjectDocument,
  type SketchObjectNode
} from '@openzcad/shared';

export interface KernelAdapter {
  syncDocument(document: ProjectDocument): ProjectDocument['derived'];
  buildFeature(document: ProjectDocument, featureId: string): BodyRepresentation | null;
  booleanOp(document: ProjectDocument, bodyId: BodyId): BodyRepresentation | null;
  transformBody(document: ProjectDocument, bodyId: BodyId): BodyRepresentation | null;
  importStep(input: { fileName: string; text: string }): Promise<{
    name: string;
    products: string[];
    colors: string[];
  }>;
  exportStep(document: ProjectDocument, bodyIds: BodyId[]): Promise<string>;
  exportStl(document: ProjectDocument, bodyIds: BodyId[]): Promise<string>;
  tessellate(body: BodyRepresentation): MeshGeometry;
}

function dimensionsToPrimitive(feature: FeatureNode): PrimitiveGeometry | null {
  if (feature.featureKind === 'primitive' && feature.data.featureKind === 'primitive') {
    return {
      kind: feature.data.primitiveKind,
      dimensions: feature.data.dimensions
    };
  }

  return null;
}

function colorForFeature(featureKind: FeatureNode['featureKind']): string {
  switch (featureKind) {
    case 'primitive':
      return '#e1a948';
    case 'extrude':
      return '#4bb7a7';
    case 'boolean':
      return '#ff7452';
    case 'transform':
      return '#8b80f9';
    case 'imported-mesh':
      return '#7aa3ff';
    default:
      return DEFAULT_BODY_COLOR;
  }
}

function triangleMeshFromPrimitive(geometry: PrimitiveGeometry): MeshGeometry {
  if (geometry.kind === 'box') {
    const width = geometry.dimensions.width ?? 1;
    const height = geometry.dimensions.height ?? 1;
    const depth = geometry.dimensions.depth ?? 1;
    const x = width / 2;
    const y = height / 2;
    const z = depth / 2;
    const vertices = [
      -x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z,
      -x, y, z
    ];
    const indices = [
      0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2,
      6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0
    ];
    return { kind: 'mesh', vertices, indices };
  }

  if (geometry.kind === 'sphere') {
    const radius = geometry.dimensions.radius ?? 1;
    const vertices = [
      0,
      radius,
      0,
      radius,
      0,
      0,
      0,
      0,
      radius,
      -radius,
      0,
      0,
      0,
      0,
      -radius,
      0,
      -radius,
      0
    ];
    const indices = [
      0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 5, 2, 1, 5, 3, 2, 5, 4, 3, 5, 1, 4
    ];
    return { kind: 'mesh', vertices, indices };
  }

  const radius = geometry.dimensions.radius ?? 1;
  const height = geometry.dimensions.height ?? 1;
  const half = height / 2;
  const vertices = [
    -radius,
    -half,
    -radius,
    radius,
    -half,
    -radius,
    radius,
    half,
    -radius,
    -radius,
    half,
    -radius,
    -radius,
    -half,
    radius,
    radius,
    -half,
    radius,
    radius,
    half,
    radius,
    -radius,
    half,
    radius
  ];
  const indices = [
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2,
    6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0
  ];
  return { kind: 'mesh', vertices, indices };
}

function asciiStlFacet(vertices: number[], a: number, b: number, c: number): string {
  const ax = vertices[a * 3];
  const ay = vertices[a * 3 + 1];
  const az = vertices[a * 3 + 2];
  const bx = vertices[b * 3];
  const by = vertices[b * 3 + 1];
  const bz = vertices[b * 3 + 2];
  const cx = vertices[c * 3];
  const cy = vertices[c * 3 + 1];
  const cz = vertices[c * 3 + 2];

  return [
    '  facet normal 0 0 0',
    '    outer loop',
    `      vertex ${ax} ${ay} ${az}`,
    `      vertex ${bx} ${by} ${bz}`,
    `      vertex ${cx} ${cy} ${cz}`,
    '    endloop',
    '  endfacet'
  ].join('\n');
}

export class MockKernelAdapter implements KernelAdapter {
  syncDocument(document: ProjectDocument): ProjectDocument['derived'] {
    const features = listNodesByKind(document, 'feature');
    const bodies = listNodesByKind(document, 'body');
    const bodyRepresentations: Record<string, BodyRepresentation> = {};
    const warnings: string[] = [];

    for (const body of bodies) {
      const feature = features.find((candidate) => candidate.featureId === body.featureId);
      if (!feature) {
        warnings.push(`Body ${body.bodyId} has no feature.`);
        continue;
      }

      const representation = this.representationForFeature(document, feature);
      if (!representation) {
        warnings.push(`No renderable geometry for feature ${feature.name}.`);
        continue;
      }

      bodyRepresentations[body.bodyId] = {
        ...representation,
        bodyId: body.bodyId,
        name: body.name,
        color:
          String(body.metadata?.color ?? colorForFeature(feature.featureKind)) ||
          DEFAULT_BODY_COLOR,
        exportableStep: body.exportableStep
      };
    }

    return {
      bodyRepresentations: bodyRepresentations as ProjectDocument['derived']['bodyRepresentations'],
      exportableBodyIds: Object.values(bodyRepresentations)
        .filter((body) => body.exportableStep)
        .map((body) => body.bodyId),
      warnings,
      updatedAt: nowIso()
    };
  }

  buildFeature(document: ProjectDocument, featureId: string): BodyRepresentation | null {
    const feature = listNodesByKind(document, 'feature').find(
      (candidate) => candidate.featureId === featureId
    );
    return feature ? this.representationForFeature(document, feature) : null;
  }

  booleanOp(document: ProjectDocument, bodyId: BodyId): BodyRepresentation | null {
    return document.derived.bodyRepresentations[bodyId] ?? null;
  }

  transformBody(document: ProjectDocument, bodyId: BodyId): BodyRepresentation | null {
    return document.derived.bodyRepresentations[bodyId] ?? null;
  }

  async importStep(input: { fileName: string; text: string }) {
    const products = Array.from(
      input.text.matchAll(/PRODUCT\('([^']+)'/g),
      (match) => match[1]
    ).filter((value): value is string => Boolean(value));
    const colors = Array.from(input.text.matchAll(/COLOUR_RGB\('([^']*)'/g), (match) =>
      match[1] || 'unnamed'
    );

    return {
      name: input.fileName,
      products,
      colors
    };
  }

  async exportStep(_document: ProjectDocument, _bodyIds: BodyId[]): Promise<string> {
    throw new Error(
      'STEP export is not available until a native OpenCascade.js-backed kernel is connected.'
    );
  }

  async exportStl(document: ProjectDocument, bodyIds: BodyId[]): Promise<string> {
    const facets: string[] = ['solid openzcad'];

    for (const bodyId of bodyIds) {
      const representation = document.derived.bodyRepresentations[bodyId];
      if (!representation) {
        continue;
      }
      const mesh = this.tessellate(representation);
      for (let index = 0; index < mesh.indices.length; index += 3) {
        facets.push(
          asciiStlFacet(
            mesh.vertices,
            mesh.indices[index] ?? 0,
            mesh.indices[index + 1] ?? 0,
            mesh.indices[index + 2] ?? 0
          )
        );
      }
    }

    facets.push('endsolid openzcad');
    return facets.join('\n');
  }

  tessellate(body: BodyRepresentation): MeshGeometry {
    if (body.geometry.kind === 'mesh') {
      return body.geometry;
    }

    if (body.geometry.kind === 'composite') {
      const childMeshes = body.geometry.children.map((child) => this.tessellate(child));
      const vertices: number[] = [];
      const indices: number[] = [];
      let vertexOffset = 0;
      for (const child of childMeshes) {
        vertices.push(...child.vertices);
        indices.push(...child.indices.map((index) => index + vertexOffset));
        vertexOffset += child.vertices.length / 3;
      }
      return { kind: 'mesh', vertices, indices };
    }

    return triangleMeshFromPrimitive(body.geometry);
  }

  private representationForFeature(
    document: ProjectDocument,
    feature: FeatureNode
  ): BodyRepresentation | null {
    const base = {
      bodyId: feature.bodyId ?? ('missing' as BodyId),
      name: feature.name,
      source: feature.featureKind,
      transform: identityTransform(),
      color: colorForFeature(feature.featureKind),
      exportableStep: false
    } satisfies Omit<BodyRepresentation, 'geometry'>;

    if (feature.featureKind === 'primitive') {
      const primitive = dimensionsToPrimitive(feature);
      return primitive ? { ...base, geometry: primitive } : null;
    }

    if (feature.data.featureKind === 'extrude') {
      const extrudeData = feature.data;
      const sketch = listNodesByKind(document, 'sketch').find(
        (candidate) => candidate.sketchId === extrudeData.sketchId
      );
      const sketchObjectId = sketch?.objectIds[0];
      const sketchObject = sketchObjectId
        ? (document.nodes[sketchObjectId] as SketchObjectNode | undefined)
        : undefined;
      if (sketchObject?.kind === 'sketch-object') {
        const sketchData = sketchObject.data;
        if (sketchData.objectKind === 'rectangle') {
          return {
            ...base,
            geometry: {
              kind: 'box',
              dimensions: {
                width: sketchData.width,
                height: sketchData.height,
                depth: extrudeData.distance
              }
            }
          };
        }

        if (sketchData.objectKind === 'circle') {
          return {
            ...base,
            geometry: {
              kind: 'cylinder',
              dimensions: {
                radius: sketchData.radius,
                height: extrudeData.distance
              }
            }
          };
        }

        return {
          ...base,
          geometry: {
            kind: 'box',
            dimensions: {
              width: Math.abs(sketchData.end.x - sketchData.start.x) || 20,
              height: 2,
              depth: extrudeData.distance
            }
          }
        };
      }

      return null;
    }

    if (feature.data.featureKind === 'boolean') {
      const children = feature.data.targetBodyIds
        .map((bodyId) => document.derived.bodyRepresentations[bodyId])
        .filter((candidate): candidate is BodyRepresentation => Boolean(candidate));

      return {
        ...base,
        geometry: {
          kind: 'composite',
          operation: feature.data.operation,
          children
        }
      };
    }

    if (feature.data.featureKind === 'transform') {
      const target = document.derived.bodyRepresentations[feature.data.targetBodyId];
      if (!target) {
        return null;
      }
      return {
        ...target,
        transform: feature.data.transform,
        source: 'transform'
      };
    }

    if (feature.data.featureKind === 'imported-mesh') {
      return {
        ...base,
        geometry: {
          kind: 'mesh',
          vertices: [-10, 0, -10, 10, 0, -10, 0, 20, 0, -10, 0, 10, 10, 0, 10],
          indices: [0, 1, 2, 0, 2, 3, 1, 4, 2]
        }
      };
    }

    return null;
  }
}

export function createMockKernelAdapter(): KernelAdapter {
  return new MockKernelAdapter();
}
