import { OcctKernel, type ShapeHandle } from 'occt-wasm';
import occtWasmUrl from 'occt-wasm/dist/occt-wasm.wasm?url';
import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  resolveParamValue
} from '@openzcad/document-core';
import {
  PLANE_BASES,
  circleProfile,
  polygonProfile,
  rectangleProfile,
  type PlaneBasis,
  type Vec2,
  type Vec3
} from '@openzcad/geometry';
import { writeAsciiStl } from '@openzcad/io-stl';
import {
  DEFAULT_BODY_COLOR,
  featureColor,
  nowIso,
  type BodyId,
  type BodyRepresentation,
  type BodyTopology,
  type DerivedState,
  type FeatureNode,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import type { ExactKernelAdapter } from './exact';

const TESSELLATION_DEFLECTION = 0.08;
const TESSELLATION_ANGLE = 0.35;
const GEOMETRY_EPSILON = 1e-9;

interface OcctBuildResult {
  shapes: Map<BodyId, ShapeHandle>;
  consumed: Set<BodyId>;
  warnings: string[];
}

function pointOnPlane(basis: PlaneBasis, point: Vec2, offset: number): Vec3 {
  return {
    x:
      basis.origin.x +
      basis.u.x * point.x +
      basis.v.x * point.y +
      basis.normal.x * offset,
    y:
      basis.origin.y +
      basis.u.y * point.x +
      basis.v.y * point.y +
      basis.normal.y * offset,
    z:
      basis.origin.z +
      basis.u.z * point.x +
      basis.v.z * point.y +
      basis.normal.z * offset
  };
}

function profilePoints(
  data: SketchObjectData,
  scope: Record<string, number>
): Vec2[] {
  switch (data.objectKind) {
    case 'rectangle':
      return rectangleProfile(
        resolveParamValue(data.width, scope, 'width'),
        resolveParamValue(data.height, scope, 'height'),
        resolveParamValue(data.centerX, scope, 'center X'),
        resolveParamValue(data.centerY, scope, 'center Y')
      );
    case 'circle':
      return circleProfile(
        resolveParamValue(data.radius, scope, 'radius'),
        resolveParamValue(data.centerX, scope, 'center X'),
        resolveParamValue(data.centerY, scope, 'center Y')
      );
    case 'polygon':
      return polygonProfile(
        resolveParamValue(data.sides, scope, 'sides'),
        resolveParamValue(data.radius, scope, 'radius'),
        resolveParamValue(data.centerX, scope, 'center X'),
        resolveParamValue(data.centerY, scope, 'center Y')
      );
  }
}

function axisDirection(axis: 'x' | 'y' | 'z'): Vec3 {
  return {
    x: axis === 'x' ? 1 : 0,
    y: axis === 'y' ? 1 : 0,
    z: axis === 'z' ? 1 : 0
  };
}

/** Same world-origin ZYX Euler transform used by the viewport move gizmo. */
function transformMatrix(translation: Vec3, rotationDeg: Vec3): number[] {
  const rx = (rotationDeg.x * Math.PI) / 180;
  const ry = (rotationDeg.y * Math.PI) / 180;
  const rz = (rotationDeg.z * Math.PI) / 180;
  const ca = Math.cos(rx);
  const sa = Math.sin(rx);
  const cb = Math.cos(ry);
  const sb = Math.sin(ry);
  const cc = Math.cos(rz);
  const sc = Math.sin(rz);
  return [
    cc * cb,
    cc * sb * sa - sc * ca,
    cc * sb * ca + sc * sa,
    translation.x,
    sc * cb,
    sc * sb * sa + cc * ca,
    sc * sb * ca - cc * sa,
    translation.y,
    -sb,
    cb * sa,
    cb * ca,
    translation.z
  ];
}

function importedMeshStl(
  feature: Extract<FeatureNode['data'], { featureKind: 'imported-mesh' }>
): string {
  return writeAsciiStl(feature.sourceName, [
    {
      name: feature.sourceName,
      vertices: feature.vertices,
      indices: feature.indices
    }
  ]);
}

/**
 * OpenCascade-backed document rebuild used whenever STEP geometry is present.
 * All bodies in that document are built in the same kernel, so imported solids
 * remain exact inputs to transforms, booleans, patterns, and edge modifiers.
 */
export class OcctStepKernelAdapter implements ExactKernelAdapter {
  readonly kind = 'occt' as const;

  private constructor(private readonly kernel: OcctKernel) {}

  static async create(): Promise<OcctStepKernelAdapter> {
    const browserWasmUrl =
      typeof globalThis.location === 'object' &&
      /^(?:https?:|blob:)$/.test(globalThis.location.protocol)
        ? occtWasmUrl
        : undefined;
    return new OcctStepKernelAdapter(
      await OcctKernel.init(
        browserWasmUrl ? { wasm: browserWasmUrl } : undefined
      )
    );
  }

  private makeProfileFace(
    data: SketchObjectData,
    basis: PlaneBasis,
    offset: number,
    scope: Record<string, number>
  ): ShapeHandle {
    if (data.objectKind === 'circle') {
      const center = pointOnPlane(
        basis,
        {
          x: resolveParamValue(data.centerX, scope, 'center X'),
          y: resolveParamValue(data.centerY, scope, 'center Y')
        },
        offset
      );
      const edge = this.kernel.makeCircleEdge(
        center,
        basis.normal,
        resolveParamValue(data.radius, scope, 'radius')
      );
      return this.kernel.makeFace(this.kernel.makeWire([edge]));
    }

    const points = profilePoints(data, scope).map((point) =>
      pointOnPlane(basis, point, offset)
    );
    const edges = points.map((start, index) =>
      this.kernel.makeLineEdge(start, points[(index + 1) % points.length]!)
    );
    return this.kernel.makeFace(this.kernel.makeWire(edges));
  }

  private buildPrimitive(
    data: Extract<FeatureNode['data'], { featureKind: 'primitive' }>,
    scope: Record<string, number>
  ): ShapeHandle {
    const dimension = (key: string): number =>
      resolveParamValue(data.dimensions[key] ?? 0, scope, key);
    switch (data.primitiveKind) {
      case 'box':
        return this.kernel.makeBox(
          dimension('width'),
          dimension('height'),
          dimension('depth')
        );
      case 'cylinder':
        return this.kernel.makeCylinder(
          dimension('radius'),
          dimension('height')
        );
      case 'sphere':
        return this.kernel.makeSphere(dimension('radius'));
      case 'cone':
        return this.kernel.makeCone(
          dimension('bottomRadius'),
          dimension('topRadius'),
          dimension('height')
        );
      case 'torus':
        return this.kernel.makeTorus(
          dimension('majorRadius'),
          dimension('minorRadius')
        );
    }
  }

  private buildSweep(
    document: ProjectDocument,
    feature: FeatureNode,
    scope: Record<string, number>
  ): ShapeHandle {
    if (
      feature.data.featureKind !== 'extrude' &&
      feature.data.featureKind !== 'revolve'
    ) {
      throw new Error('Expected a sweep feature.');
    }
    const sketch = findSketch(document, feature.data.sketchId);
    const objectId = sketch?.objectIds[0];
    const object = objectId ? document.nodes[objectId] : undefined;
    if (!sketch || !object || object.kind !== 'sketch-object') {
      throw new Error('Referenced sketch has no profile.');
    }
    const basis = PLANE_BASES[sketch.plane];
    const offset = resolveParamValue(sketch.offset, scope, 'sketch offset');
    const face = this.makeProfileFace(object.data, basis, offset, scope);

    if (feature.data.featureKind === 'extrude') {
      const distance = resolveParamValue(
        feature.data.distance,
        scope,
        'distance'
      );
      return this.kernel.extrude(
        face,
        basis.normal.x * distance,
        basis.normal.y * distance,
        basis.normal.z * distance
      );
    }

    const direction = feature.data.axis === 'vertical' ? basis.v : basis.u;
    return this.kernel.revolve(
      face,
      {
        point: pointOnPlane(basis, { x: 0, y: 0 }, offset),
        direction
      },
      Math.PI * 2
    );
  }

  private build(document: ProjectDocument): OcctBuildResult {
    const { scope, errors } = getParameterScope(document);
    const result: OcctBuildResult = {
      shapes: new Map(),
      consumed: new Set(),
      warnings: [...errors]
    };

    for (const feature of listFeaturesInOrder(document)) {
      try {
        switch (feature.data.featureKind) {
          case 'sketch':
            break;
          case 'primitive':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildPrimitive(feature.data, scope)
              );
            }
            break;
          case 'extrude':
          case 'revolve':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildSweep(document, feature, scope)
              );
            }
            break;
          case 'imported-step':
            if (feature.bodyId) {
              const shape = this.kernel.importStep(feature.data.stepText);
              if (this.kernel.getSubShapes(shape, 'solid').length === 0) {
                throw new Error('STEP file contains no solids.');
              }
              result.shapes.set(feature.bodyId, shape);
            }
            break;
          case 'imported-mesh':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.kernel.importStl(importedMeshStl(feature.data))
              );
            }
            break;
          case 'transform': {
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Transform target is unavailable.');
            }
            const translation = feature.data.transform.translation;
            const rotation = feature.data.transform.rotationDeg;
            result.shapes.set(
              feature.data.targetBodyId,
              this.kernel.transform(
                target,
                transformMatrix(
                  {
                    x: resolveParamValue(translation.x, scope, 'X'),
                    y: resolveParamValue(translation.y, scope, 'Y'),
                    z: resolveParamValue(translation.z, scope, 'Z')
                  },
                  {
                    x: resolveParamValue(rotation.x, scope, 'rotate X'),
                    y: resolveParamValue(rotation.y, scope, 'rotate Y'),
                    z: resolveParamValue(rotation.z, scope, 'rotate Z')
                  }
                )
              )
            );
            break;
          }
          case 'boolean': {
            if (!feature.bodyId || feature.data.targetBodyIds.length < 2) {
              throw new Error('Boolean requires at least two bodies.');
            }
            const operands = feature.data.targetBodyIds.map((bodyId) => {
              const shape = result.shapes.get(bodyId);
              if (!shape) {
                throw new Error(`Boolean target ${bodyId} is unavailable.`);
              }
              return shape;
            });
            let output: ShapeHandle;
            if (feature.data.operation === 'union') {
              output = this.kernel.fuseAll(operands);
            } else {
              output = operands[0]!;
              for (const operand of operands.slice(1)) {
                output =
                  feature.data.operation === 'subtract'
                    ? this.kernel.cut(output, operand)
                    : this.kernel.common(output, operand);
              }
            }
            output = this.kernel.unifySameDomain(output);
            feature.data.targetBodyIds.forEach((bodyId) =>
              result.consumed.add(bodyId)
            );
            result.shapes.set(feature.bodyId, output);
            break;
          }
          case 'fillet':
          case 'chamfer': {
            if (!feature.bodyId) {
              throw new Error('Edge modifier has no result body.');
            }
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Edge modifier target is unavailable.');
            }
            const requested = new Set(feature.data.edgeHashes);
            const targetEdges = this.kernel.getSubShapes(target, 'edge');
            const selected = targetEdges.filter((_, index) =>
              requested.has(index + 1)
            );
            if (selected.length !== requested.size) {
              throw new Error(
                `${requested.size - selected.length} selected edge(s) no longer exist.`
              );
            }
            const size = resolveParamValue(
              feature.data.featureKind === 'fillet'
                ? feature.data.radius
                : feature.data.distance,
              scope,
              feature.data.featureKind === 'fillet' ? 'radius' : 'distance'
            );
            if (size <= GEOMETRY_EPSILON) {
              throw new Error('Edge modifier size must be greater than zero.');
            }
            const modified =
              feature.data.featureKind === 'fillet'
                ? this.kernel.fillet(target, selected, size)
                : this.kernel.chamfer(target, selected, size);
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(feature.bodyId, modified);
            break;
          }
          case 'pattern': {
            if (!feature.bodyId) {
              throw new Error('Pattern has no result body.');
            }
            const target = result.shapes.get(feature.data.targetBodyId);
            if (!target) {
              throw new Error('Pattern target is unavailable.');
            }
            const count = Math.round(
              resolveParamValue(feature.data.count, scope, 'count')
            );
            if (count < 2 || count > 100) {
              throw new Error('Pattern count must be between 2 and 100.');
            }
            const axis = axisDirection(feature.data.axis);
            const instances: ShapeHandle[] = [target];
            if (feature.data.patternKind === 'linear') {
              const spacing = resolveParamValue(
                feature.data.spacing,
                scope,
                'spacing'
              );
              if (Math.abs(spacing) <= GEOMETRY_EPSILON) {
                throw new Error('Pattern spacing cannot be zero.');
              }
              for (let index = 1; index < count; index += 1) {
                instances.push(
                  this.kernel.translate(
                    target,
                    axis.x * spacing * index,
                    axis.y * spacing * index,
                    axis.z * spacing * index
                  )
                );
              }
            } else {
              const angle = resolveParamValue(
                feature.data.angleDeg,
                scope,
                'pattern angle'
              );
              if (Math.abs(angle) <= GEOMETRY_EPSILON) {
                throw new Error('Pattern angle cannot be zero.');
              }
              const step =
                Math.abs(Math.abs(angle) - 360) <= GEOMETRY_EPSILON
                  ? angle / count
                  : angle / (count - 1);
              for (let index = 1; index < count; index += 1) {
                instances.push(
                  this.kernel.rotate(
                    target,
                    { point: { x: 0, y: 0, z: 0 }, direction: axis },
                    (step * index * Math.PI) / 180
                  )
                );
              }
            }
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(
              feature.bodyId,
              this.kernel.makeCompound(instances)
            );
            break;
          }
        }
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'exact geometry failed';
        result.warnings.push(`Feature "${feature.name}": ${reason}`);
      }
    }

    return result;
  }

  private representation(
    document: ProjectDocument,
    bodyId: BodyId,
    shape: ShapeHandle,
    consumed: boolean
  ): BodyRepresentation | null {
    const body = listNodesByKind(document, 'body').find(
      (candidate) => candidate.bodyId === bodyId
    );
    if (!body) {
      return null;
    }
    const feature = listNodesByKind(document, 'feature').find(
      (candidate) => candidate.featureId === body.featureId
    );
    const mesh = this.kernel.meshShape(shape, {
      linearDeflection: TESSELLATION_DEFLECTION,
      angularDeflection: TESSELLATION_ANGLE
    });
    const faces: BodyTopology['faces'] = [];
    const faceGroups = mesh.faceGroups ?? new Int32Array();
    // OCCT HashCode values include process-local topology identity and change
    // when the source is rebuilt. Traversal order is deterministic for the
    // same feature history, so persist the same 1-based indices BrepKit uses.
    for (let index = 0; index + 2 < faceGroups.length; index += 3) {
      const indexStart = faceGroups[index]!;
      const indexCount = faceGroups[index + 1]!;
      const hash = faces.length + 1;
      faces.push({
        topologyId: `face:${hash}`,
        hash,
        triangleStart: indexStart / 3,
        triangleCount: indexCount / 3
      });
    }

    const wireframe = this.kernel.wireframe(shape, TESSELLATION_DEFLECTION);
    const edges: BodyTopology['edges'] = [];
    for (let index = 0; index + 2 < wireframe.edgeGroups.length; index += 3) {
      const pointStart = wireframe.edgeGroups[index]!;
      const pointCount = wireframe.edgeGroups[index + 1]!;
      const hash = edges.length + 1;
      edges.push({
        topologyId: `edge:${hash}`,
        hash,
        points: Array.from(
          wireframe.points.slice(pointStart, pointStart + pointCount)
        )
      });
    }

    const bounds = this.kernel.getBoundingBox(shape, true);
    return {
      bodyId,
      name: body.name,
      source: feature?.featureKind ?? 'primitive',
      mesh: {
        kind: 'mesh',
        vertices: Array.from(mesh.positions),
        indices: Array.from(mesh.indices)
      },
      faceCount: faces.length,
      color:
        String(
          body.metadata?.color ??
            featureColor(feature?.featureKind ?? 'primitive')
        ) || DEFAULT_BODY_COLOR,
      exportableStep: body.exportableStep,
      consumed,
      volume: this.kernel.getVolume(shape),
      bbox: {
        min: { x: bounds.xmin, y: bounds.ymin, z: bounds.zmin },
        max: { x: bounds.xmax, y: bounds.ymax, z: bounds.zmax }
      },
      topology: { faces, edges }
    };
  }

  async syncDocument(document: ProjectDocument): Promise<DerivedState> {
    try {
      const build = this.build(document);
      const bodyRepresentations: Record<BodyId, BodyRepresentation> = {};
      const exportableBodyIds: BodyId[] = [];
      const bodies = new Map(
        listNodesByKind(document, 'body').map((body) => [body.bodyId, body])
      );

      for (const bodyId of document.bodyOrder) {
        const body = bodies.get(bodyId);
        const shape = build.shapes.get(bodyId);
        if (!body || !shape) {
          continue;
        }
        const consumed = build.consumed.has(bodyId);
        if (
          body.representationSource !== 'mesh-import' &&
          !this.kernel.isValid(shape)
        ) {
          build.warnings.push(
            `Body "${body.name}" failed OpenCascade B-rep validation.`
          );
        }
        const representation = this.representation(
          document,
          bodyId,
          shape,
          consumed
        );
        if (representation) {
          bodyRepresentations[bodyId] = representation;
        }
        if (body.exportableStep && !consumed) {
          exportableBodyIds.push(bodyId);
        }
      }

      return {
        bodyRepresentations,
        exportableBodyIds,
        warnings: build.warnings,
        updatedAt: nowIso()
      };
    } finally {
      this.kernel.releaseAll();
    }
  }

  private exportShape(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): ShapeHandle {
    const build = this.build(document);
    const shapes = bodyIds.map((bodyId) => {
      const shape = build.shapes.get(bodyId);
      if (!shape) {
        throw new Error(`Body ${bodyId} has no exact geometry.`);
      }
      return shape;
    });
    if (shapes.length === 0) {
      throw new Error('Select at least one body to export.');
    }
    return shapes.length === 1 ? shapes[0]! : this.kernel.makeCompound(shapes);
  }

  async exportStep(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    try {
      return this.kernel.exportStep(this.exportShape(document, bodyIds));
    } finally {
      this.kernel.releaseAll();
    }
  }

  async exportStl(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    try {
      return this.kernel.exportStl(
        this.exportShape(document, bodyIds),
        TESSELLATION_DEFLECTION,
        true
      );
    } finally {
      this.kernel.releaseAll();
    }
  }

  async inspectStep(data: string | ArrayBuffer): Promise<{
    solid: boolean;
    valid: boolean;
    volume: number;
  }> {
    try {
      const shape = this.kernel.importStep(data);
      const solid = this.kernel.getSubShapes(shape, 'solid').length > 0;
      return {
        solid,
        valid: solid && this.kernel.isValid(shape),
        volume: solid ? this.kernel.getVolume(shape) : 0
      };
    } finally {
      this.kernel.releaseAll();
    }
  }

  dispose(): void {
    this.kernel[Symbol.dispose]();
  }
}
