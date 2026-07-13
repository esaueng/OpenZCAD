import { OcctError, OcctKernel, type ShapeHandle, type Vec3 } from 'occt-wasm';
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
  type Vec2
} from '@openzcad/geometry';
import {
  DEFAULT_BODY_COLOR,
  featureColor,
  nowIso,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type FeatureNode,
  type ProjectDocument,
  type SketchObjectData
} from '@openzcad/shared';
import { OpenZCADKernel } from './index';

interface ExactBuildResult {
  shapes: Map<BodyId, ShapeHandle>;
  consumed: Set<BodyId>;
  warnings: string[];
  handles: Set<ShapeHandle>;
}

function axisDirection(axis: 'x' | 'y' | 'z'): Vec3 {
  return {
    x: axis === 'x' ? 1 : 0,
    y: axis === 'y' ? 1 : 0,
    z: axis === 'z' ? 1 : 0
  };
}

export interface ExactKernelAdapter {
  readonly kind: 'open-cascade';
  syncDocument(document: ProjectDocument): Promise<DerivedState>;
  exportStep(document: ProjectDocument, bodyIds: BodyId[]): Promise<string>;
  exportStl(document: ProjectDocument, bodyIds: BodyId[]): Promise<string>;
  inspectStep(data: string | ArrayBuffer): Promise<{
    solid: boolean;
    valid: boolean;
    volume: number;
  }>;
  dispose(): void;
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

function addHandle(result: ExactBuildResult, handle: ShapeHandle): ShapeHandle {
  result.handles.add(handle);
  return handle;
}

export class OpenCascadeKernelAdapter implements ExactKernelAdapter {
  readonly kind = 'open-cascade' as const;
  private readonly legacy = new OpenZCADKernel();

  private constructor(private readonly kernel: OcctKernel) {}

  static async create(): Promise<OpenCascadeKernelAdapter> {
    return new OpenCascadeKernelAdapter(await OcctKernel.init());
  }

  private makeProfileFace(
    data: SketchObjectData,
    basis: PlaneBasis,
    offset: number,
    scope: Record<string, number>,
    build: ExactBuildResult
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
      const edge = addHandle(
        build,
        this.kernel.makeCircleEdge(
          center,
          basis.normal,
          resolveParamValue(data.radius, scope, 'radius')
        )
      );
      const wire = addHandle(build, this.kernel.makeWire([edge]));
      return addHandle(build, this.kernel.makeFace(wire));
    }

    const points = profilePoints(data, scope).map((point) =>
      pointOnPlane(basis, point, offset)
    );
    const edges: ShapeHandle[] = [];
    for (let index = 0; index < points.length; index += 1) {
      edges.push(
        addHandle(
          build,
          this.kernel.makeLineEdge(
            points[index]!,
            points[(index + 1) % points.length]!
          )
        )
      );
    }
    const wire = addHandle(build, this.kernel.makeWire(edges));
    return addHandle(build, this.kernel.makeFace(wire));
  }

  private buildPrimitive(
    data: Extract<FeatureNode['data'], { featureKind: 'primitive' }>,
    scope: Record<string, number>,
    build: ExactBuildResult
  ): ShapeHandle {
    const dimension = (key: string): number =>
      resolveParamValue(data.dimensions[key] ?? 0, scope, key);
    switch (data.primitiveKind) {
      case 'box':
        return addHandle(
          build,
          this.kernel.makeBox(
            dimension('width'),
            dimension('height'),
            dimension('depth')
          )
        );
      case 'cylinder':
        return addHandle(
          build,
          this.kernel.makeCylinder(dimension('radius'), dimension('height'))
        );
      case 'sphere':
        return addHandle(build, this.kernel.makeSphere(dimension('radius')));
      case 'cone':
        return addHandle(
          build,
          this.kernel.makeCone(
            dimension('bottomRadius'),
            dimension('topRadius'),
            dimension('height')
          )
        );
      case 'torus':
        return addHandle(
          build,
          this.kernel.makeTorus(
            dimension('majorRadius'),
            dimension('minorRadius')
          )
        );
    }
  }

  private buildSweep(
    document: ProjectDocument,
    feature: FeatureNode,
    scope: Record<string, number>,
    build: ExactBuildResult
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
    const face = this.makeProfileFace(object.data, basis, offset, scope, build);

    if (feature.data.featureKind === 'extrude') {
      const distance = resolveParamValue(
        feature.data.distance,
        scope,
        'distance'
      );
      return addHandle(
        build,
        this.kernel.extrude(
          face,
          basis.normal.x * distance,
          basis.normal.y * distance,
          basis.normal.z * distance
        )
      );
    }

    const axisDirection = feature.data.axis === 'vertical' ? basis.v : basis.u;
    const axisPoint = pointOnPlane(basis, { x: 0, y: 0 }, offset);
    return addHandle(
      build,
      this.kernel.revolve(
        face,
        { point: axisPoint, direction: axisDirection },
        Math.PI * 2
      )
    );
  }

  private build(document: ProjectDocument): ExactBuildResult {
    const { scope, errors } = getParameterScope(document);
    const result: ExactBuildResult = {
      shapes: new Map(),
      consumed: new Set(),
      warnings: [...errors],
      handles: new Set()
    };

    for (const feature of listFeaturesInOrder(document)) {
      try {
        switch (feature.data.featureKind) {
          case 'sketch':
            break;
          case 'imported-mesh':
            throw new Error('Legacy mesh bodies use the compatibility kernel.');
          case 'imported-step':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                addHandle(result, this.kernel.importStep(feature.data.stepText))
              );
            }
            break;
          case 'primitive':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildPrimitive(feature.data, scope, result)
              );
            }
            break;
          case 'extrude':
          case 'revolve':
            if (feature.bodyId) {
              result.shapes.set(
                feature.bodyId,
                this.buildSweep(document, feature, scope, result)
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
            let transformed = target;
            const rotations: Array<[Vec3, number]> = [
              [
                { x: 1, y: 0, z: 0 },
                resolveParamValue(rotation.x, scope, 'rotate X')
              ],
              [
                { x: 0, y: 1, z: 0 },
                resolveParamValue(rotation.y, scope, 'rotate Y')
              ],
              [
                { x: 0, y: 0, z: 1 },
                resolveParamValue(rotation.z, scope, 'rotate Z')
              ]
            ];
            for (const [direction, degrees] of rotations) {
              if (degrees !== 0) {
                transformed = addHandle(
                  result,
                  this.kernel.rotate(
                    transformed,
                    { point: { x: 0, y: 0, z: 0 }, direction },
                    (degrees * Math.PI) / 180
                  )
                );
              }
            }
            transformed = addHandle(
              result,
              this.kernel.translate(
                transformed,
                resolveParamValue(translation.x, scope, 'X'),
                resolveParamValue(translation.y, scope, 'Y'),
                resolveParamValue(translation.z, scope, 'Z')
              )
            );
            result.shapes.set(feature.data.targetBodyId, transformed);
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
            let shape = operands[0]!;
            for (const operand of operands.slice(1)) {
              shape = addHandle(
                result,
                feature.data.operation === 'union'
                  ? this.kernel.fuse(shape, operand)
                  : feature.data.operation === 'subtract'
                    ? this.kernel.cut(shape, operand)
                    : this.kernel.common(shape, operand)
              );
            }
            feature.data.targetBodyIds.forEach((bodyId) =>
              result.consumed.add(bodyId)
            );
            result.shapes.set(feature.bodyId, shape);
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
            const edges = this.kernel.getSubShapes(target, 'edge');
            edges.forEach((edge) => result.handles.add(edge));
            // OCCT HashCode values identify transient shape handles and change
            // whenever this adapter rebuilds the document. The one-based
            // sub-shape ordinal is deterministic for an unchanged upstream
            // feature and therefore survives rebuilds and command replay.
            const selected = edges.filter((_, index) =>
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
            if (size <= 0) {
              throw new Error('Edge modifier size must be greater than zero.');
            }
            let modifiedShape: ShapeHandle;
            try {
              modifiedShape =
                feature.data.featureKind === 'fillet'
                  ? this.kernel.fillet(target, selected, size)
                  : this.kernel.chamfer(target, selected, size);
            } catch {
              const label =
                feature.data.featureKind === 'fillet' ? 'Fillet' : 'Chamfer';
              const dimension =
                feature.data.featureKind === 'fillet' ? 'radius' : 'distance';
              throw new Error(
                `${label} could not be created on ${selected.length} selected edge${selected.length === 1 ? '' : 's'} with ${dimension} ${size}. Try a smaller ${dimension}; for a uniformly rounded box, select the original edges together in one ${label} feature.`
              );
            }
            const modified = addHandle(result, modifiedShape);
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
            const direction = axisDirection(feature.data.axis);
            const instances: ShapeHandle[] = [target];
            if (feature.data.patternKind === 'linear') {
              const spacing = resolveParamValue(
                feature.data.spacing,
                scope,
                'spacing'
              );
              if (spacing === 0) {
                throw new Error('Pattern spacing cannot be zero.');
              }
              for (let index = 1; index < count; index += 1) {
                instances.push(
                  addHandle(
                    result,
                    this.kernel.translate(
                      target,
                      direction.x * spacing * index,
                      direction.y * spacing * index,
                      direction.z * spacing * index
                    )
                  )
                );
              }
            } else {
              const angle = resolveParamValue(
                feature.data.angleDeg,
                scope,
                'pattern angle'
              );
              if (angle === 0) {
                throw new Error('Pattern angle cannot be zero.');
              }
              const angleStep =
                Math.abs(angle) === 360 ? angle / count : angle / (count - 1);
              for (let index = 1; index < count; index += 1) {
                instances.push(
                  addHandle(
                    result,
                    this.kernel.rotate(
                      target,
                      { point: { x: 0, y: 0, z: 0 }, direction },
                      (angleStep * index * Math.PI) / 180
                    )
                  )
                );
              }
            }
            result.consumed.add(feature.data.targetBodyId);
            result.shapes.set(
              feature.bodyId,
              addHandle(result, this.kernel.makeCompound(instances))
            );
            break;
          }
        }
      } catch (error) {
        const reason =
          error instanceof OcctError || error instanceof Error
            ? error.message
            : 'exact geometry failed';
        result.warnings.push(`Feature "${feature.name}": ${reason}`);
      }
    }
    return result;
  }

  private release(result: ExactBuildResult): void {
    for (const handle of result.handles) {
      try {
        this.kernel.release(handle);
      } catch {
        // A released parent can invalidate derived handles; cleanup remains best-effort.
      }
    }
  }

  async syncDocument(document: ProjectDocument): Promise<DerivedState> {
    if (
      listFeaturesInOrder(document).some(
        (feature) => feature.data.featureKind === 'imported-mesh'
      )
    ) {
      return this.legacy.syncDocument(document);
    }
    const build = this.build(document);
    try {
      const bodies = listNodesByKind(document, 'body');
      const features = new Map(
        listNodesByKind(document, 'feature').map((feature) => [
          feature.featureId,
          feature
        ])
      );
      const bodyRepresentations: Record<BodyId, BodyRepresentation> = {};
      const exportableBodyIds: BodyId[] = [];

      for (const bodyId of document.bodyOrder) {
        const body = bodies.find((candidate) => candidate.bodyId === bodyId);
        const shape = build.shapes.get(bodyId);
        if (!body || !shape) {
          continue;
        }
        const feature = features.get(body.featureId);
        const mesh = this.kernel.meshShape(shape, {
          linearDeflection: 0.08,
          angularDeflection: 0.35
        });
        const wireframe = this.kernel.wireframe(shape, 0.08);
        const bounds = this.kernel.getBoundingBox(shape, true);
        const subFaces = this.kernel.getSubShapes(shape, 'face');
        const faceCount = subFaces.length;
        subFaces.forEach((face) => this.kernel.release(face));
        const consumed = build.consumed.has(bodyId);
        if (!this.kernel.isValid(shape)) {
          build.warnings.push(
            `Body "${body.name}" failed exact B-rep validation.`
          );
        }
        bodyRepresentations[bodyId] = {
          bodyId,
          name: body.name,
          source: feature?.featureKind ?? 'primitive',
          mesh: {
            kind: 'mesh',
            vertices: Array.from(mesh.positions),
            indices: Array.from(mesh.indices)
          },
          faceCount,
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
          topology: {
            faces: Array.from(
              { length: (mesh.faceGroups?.length ?? 0) / 3 },
              (_, index) => {
                const triangleStart = mesh.faceGroups![index * 3]! / 3;
                const triangleCount = mesh.faceGroups![index * 3 + 1]! / 3;
                const hash = index + 1;
                return {
                  topologyId: `face:${hash}`,
                  hash,
                  triangleStart,
                  triangleCount
                };
              }
            ),
            edges: Array.from(
              { length: wireframe.edgeGroups.length / 3 },
              (_, index) => {
                const pointStart = wireframe.edgeGroups[index * 3]!;
                const pointCount = wireframe.edgeGroups[index * 3 + 1]!;
                const hash = index + 1;
                return {
                  topologyId: `edge:${hash}`,
                  hash,
                  points: Array.from(
                    wireframe.points.slice(pointStart, pointStart + pointCount)
                  )
                };
              }
            )
          }
        };
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
      this.release(build);
    }
  }

  async exportStep(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    const build = this.build(document);
    try {
      const shapes = bodyIds.map((bodyId) => {
        const shape = build.shapes.get(bodyId);
        if (!shape) {
          throw new Error(`Body ${bodyId} has no exact geometry.`);
        }
        return shape;
      });
      const exportShape =
        shapes.length === 1
          ? shapes[0]!
          : addHandle(build, this.kernel.makeCompound(shapes));
      return this.kernel.exportStep(exportShape);
    } finally {
      this.release(build);
    }
  }

  async exportStl(
    document: ProjectDocument,
    bodyIds: BodyId[]
  ): Promise<string> {
    const build = this.build(document);
    try {
      const shapes = bodyIds.map((bodyId) => {
        const shape = build.shapes.get(bodyId);
        if (!shape) {
          throw new Error(`Body ${bodyId} has no exact geometry.`);
        }
        return shape;
      });
      const exportShape =
        shapes.length === 1
          ? shapes[0]!
          : addHandle(build, this.kernel.makeCompound(shapes));
      return this.kernel.exportStl(exportShape, 0.08, true);
    } finally {
      this.release(build);
    }
  }

  async inspectStep(data: string | ArrayBuffer): Promise<{
    solid: boolean;
    valid: boolean;
    volume: number;
  }> {
    const shape = this.kernel.importStep(data);
    try {
      return {
        solid: this.kernel.isSolid(shape),
        valid: this.kernel.isValid(shape),
        volume: this.kernel.getVolume(shape)
      };
    } finally {
      this.kernel.release(shape);
    }
  }

  dispose(): void {
    this.kernel[Symbol.dispose]();
  }
}

export async function createExactKernelAdapter(): Promise<ExactKernelAdapter> {
  return OpenCascadeKernelAdapter.create();
}
