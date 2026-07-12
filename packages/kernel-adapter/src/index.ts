import {
  findSketch,
  getParameterScope,
  listFeaturesInOrder,
  listNodesByKind,
  resolveParamValue
} from '@openzcad/document-core';
import {
  GeometryError,
  PLANE_BASES,
  booleanSolids,
  circleProfile,
  extrudeProfile,
  makeBox,
  makeCone,
  makeCylinder,
  makeSphere,
  makeTorus,
  polygonProfile,
  rectangleProfile,
  revolveProfile,
  solidBounds,
  solidFromTriangles,
  solidVolume,
  transformSolid,
  triangulateSolid,
  validateSolid,
  type Solid,
  type Vec2
} from '@openzcad/geometry';
import { writeStepFile, type StepExportResult } from '@openzcad/io-step';
import { writeAsciiStl } from '@openzcad/io-stl';
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

/**
 * The OpenZCAD browser kernel. It rebuilds every body from its parametric
 * feature definition on each sync: parameters are evaluated, profiles are
 * swept, booleans run real CSG, and transforms are baked into world-space
 * vertices. The same build path also feeds STEP/STL export, so what you see
 * is exactly what you export.
 */
export interface KernelAdapter {
  syncDocument(document: ProjectDocument): DerivedState;
  buildSolids(document: ProjectDocument): BuildResult;
  exportStep(document: ProjectDocument, bodyIds: BodyId[]): StepExportResult;
  exportStl(document: ProjectDocument, bodyIds: BodyId[]): string;
}

export interface BuildResult {
  solids: Map<BodyId, Solid>;
  consumed: Set<BodyId>;
  warnings: string[];
}

function profileFromSketchObject(
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

function buildPrimitive(
  feature: Extract<FeatureNode['data'], { featureKind: 'primitive' }>,
  scope: Record<string, number>
): Solid {
  const dim = (key: string): number =>
    resolveParamValue(feature.dimensions[key] ?? 0, scope, key);
  switch (feature.primitiveKind) {
    case 'box':
      return makeBox(dim('width'), dim('height'), dim('depth'));
    case 'cylinder':
      return makeCylinder(dim('radius'), dim('height'));
    case 'sphere':
      return makeSphere(dim('radius'));
    case 'cone':
      return makeCone(dim('bottomRadius'), dim('topRadius'), dim('height'));
    case 'torus':
      return makeTorus(dim('majorRadius'), dim('minorRadius'));
  }
}

function buildSketchSolid(
  document: ProjectDocument,
  feature: FeatureNode,
  scope: Record<string, number>
): Solid {
  if (
    feature.data.featureKind !== 'extrude' &&
    feature.data.featureKind !== 'revolve'
  ) {
    throw new GeometryError('Not a sweep feature.');
  }
  const sketch = findSketch(document, feature.data.sketchId);
  if (!sketch) {
    throw new GeometryError('references a sketch that no longer exists.');
  }
  const objectId = sketch.objectIds[0];
  const objectNode = objectId ? document.nodes[objectId] : undefined;
  if (!objectNode || objectNode.kind !== 'sketch-object') {
    throw new GeometryError(`sketch "${sketch.name}" has no profile.`);
  }
  const profile = profileFromSketchObject(objectNode.data, scope);
  const basis = PLANE_BASES[sketch.plane];
  const offset = resolveParamValue(sketch.offset, scope, 'sketch offset');

  if (feature.data.featureKind === 'extrude') {
    const distance = resolveParamValue(
      feature.data.distance,
      scope,
      'distance'
    );
    return extrudeProfile(profile, basis, distance, offset);
  }
  return revolveProfile(profile, basis, feature.data.axis, offset);
}

export class OpenZCADKernel implements KernelAdapter {
  buildSolids(document: ProjectDocument): BuildResult {
    const { scope, errors } = getParameterScope(document);
    const warnings: string[] = [...errors];
    const solids = new Map<BodyId, Solid>();
    const consumed = new Set<BodyId>();

    for (const feature of listFeaturesInOrder(document)) {
      try {
        switch (feature.data.featureKind) {
          case 'sketch':
            break;
          case 'primitive': {
            if (feature.bodyId) {
              solids.set(feature.bodyId, buildPrimitive(feature.data, scope));
            }
            break;
          }
          case 'extrude':
          case 'revolve': {
            if (feature.bodyId) {
              solids.set(
                feature.bodyId,
                buildSketchSolid(document, feature, scope)
              );
            }
            break;
          }
          case 'imported-mesh': {
            if (feature.bodyId) {
              const solid = solidFromTriangles(
                feature.data.vertices,
                feature.data.indices
              );
              if (solid.faces.length === 0) {
                throw new GeometryError('imported mesh has no triangles.');
              }
              solids.set(feature.bodyId, solid);
            }
            break;
          }
          case 'imported-step':
            throw new GeometryError(
              'editable STEP solids require the exact OpenCascade kernel.'
            );
          case 'fillet':
          case 'chamfer':
          case 'pattern':
            throw new GeometryError(
              `${feature.data.featureKind} requires the exact OpenCascade kernel.`
            );
          case 'transform': {
            const targetBodyId = feature.data.targetBodyId;
            if (consumed.has(targetBodyId)) {
              warnings.push(
                `Transform "${feature.name}" targets a body already consumed by a boolean; skipped.`
              );
              break;
            }
            const target = solids.get(targetBodyId);
            if (!target) {
              warnings.push(
                `Transform "${feature.name}" targets a missing body.`
              );
              break;
            }
            const transform = {
              translation: {
                x: resolveParamValue(
                  feature.data.transform.translation.x,
                  scope,
                  'X'
                ),
                y: resolveParamValue(
                  feature.data.transform.translation.y,
                  scope,
                  'Y'
                ),
                z: resolveParamValue(
                  feature.data.transform.translation.z,
                  scope,
                  'Z'
                )
              },
              rotationDeg: {
                x: resolveParamValue(
                  feature.data.transform.rotationDeg.x,
                  scope,
                  'rotate X'
                ),
                y: resolveParamValue(
                  feature.data.transform.rotationDeg.y,
                  scope,
                  'rotate Y'
                ),
                z: resolveParamValue(
                  feature.data.transform.rotationDeg.z,
                  scope,
                  'rotate Z'
                )
              }
            };
            solids.set(targetBodyId, transformSolid(target, transform));
            break;
          }
          case 'boolean': {
            if (!feature.bodyId) {
              break;
            }
            const operands: Solid[] = [];
            for (const targetBodyId of feature.data.targetBodyIds) {
              const operand = solids.get(targetBodyId);
              if (!operand) {
                throw new GeometryError(
                  `target body is missing (was it deleted or reordered?).`
                );
              }
              if (consumed.has(targetBodyId)) {
                warnings.push(
                  `Boolean "${feature.name}" reuses a body already consumed by an earlier boolean.`
                );
              }
              operands.push(operand);
            }
            if (operands.length < 2) {
              throw new GeometryError('needs at least two target bodies.');
            }
            let result = operands[0]!;
            for (let i = 1; i < operands.length; i++) {
              result = booleanSolids(
                feature.data.operation,
                result,
                operands[i]!
              );
            }
            if (result.faces.length === 0) {
              warnings.push(
                `Boolean "${feature.name}" produced an empty solid (no overlap?).`
              );
            }
            for (const targetBodyId of feature.data.targetBodyIds) {
              consumed.add(targetBodyId);
            }
            solids.set(feature.bodyId, result);
            break;
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'geometry build failed.';
        warnings.push(`Feature "${feature.name}": ${message}`);
      }
    }

    return { solids, consumed, warnings };
  }

  syncDocument(document: ProjectDocument): DerivedState {
    const { solids, consumed, warnings } = this.buildSolids(document);
    const bodies = listNodesByKind(document, 'body');
    const representations: Record<BodyId, BodyRepresentation> = {};
    const exportableBodyIds: BodyId[] = [];

    const featuresById = new Map(
      listNodesByKind(document, 'feature').map((feature) => [
        feature.featureId,
        feature
      ])
    );

    for (const bodyId of document.bodyOrder) {
      const body = bodies.find((candidate) => candidate.bodyId === bodyId);
      if (!body) {
        continue;
      }
      const solid = solids.get(bodyId);
      if (!solid) {
        const feature = featuresById.get(body.featureId);
        if (feature) {
          // Build failures already produced a specific warning.
          if (
            !warnings.some((warning) => warning.includes(`"${feature.name}"`))
          ) {
            warnings.push(
              `No geometry produced for feature "${feature.name}".`
            );
          }
        }
        continue;
      }
      const feature = featuresById.get(body.featureId);
      const isConsumed = consumed.has(bodyId);
      const validation = validateSolid(solid);
      if (!validation.closed && body.representationSource !== 'mesh-import') {
        warnings.push(
          `Body "${body.name}" is not perfectly closed (${validation.openEdgeCount} open edges).`
        );
      }
      const mesh = triangulateSolid(solid);
      representations[bodyId] = {
        bodyId,
        name: body.name,
        source: feature?.featureKind ?? 'primitive',
        mesh: { kind: 'mesh', vertices: mesh.vertices, indices: mesh.indices },
        faceCount: solid.faces.length,
        color:
          String(
            body.metadata?.color ??
              featureColor(feature?.featureKind ?? 'primitive')
          ) || DEFAULT_BODY_COLOR,
        exportableStep: body.exportableStep,
        consumed: isConsumed,
        volume: solidVolume(solid),
        bbox: solidBounds(solid)
      };
      if (body.exportableStep && !isConsumed) {
        exportableBodyIds.push(bodyId);
      }
    }

    return {
      bodyRepresentations: representations,
      exportableBodyIds,
      warnings,
      updatedAt: nowIso()
    };
  }

  exportStep(document: ProjectDocument, bodyIds: BodyId[]): StepExportResult {
    const { solids, warnings } = this.buildSolids(document);
    const bodies = listNodesByKind(document, 'body');
    const exportSolids = bodyIds.map((bodyId) => {
      const solid = solids.get(bodyId);
      if (!solid) {
        throw new Error(`Body ${bodyId} has no geometry to export.`);
      }
      const body = bodies.find((candidate) => candidate.bodyId === bodyId);
      return { name: body?.name ?? 'Body', solid };
    });
    const result = writeStepFile(exportSolids, {
      name: document.name,
      units: document.units
    });
    return { text: result.text, warnings: [...warnings, ...result.warnings] };
  }

  exportStl(document: ProjectDocument, bodyIds: BodyId[]): string {
    const { solids } = this.buildSolids(document);
    const bodies = listNodesByKind(document, 'body');
    const meshes = bodyIds.map((bodyId) => {
      const solid = solids.get(bodyId);
      if (!solid) {
        throw new Error(`Body ${bodyId} has no geometry to export.`);
      }
      const body = bodies.find((candidate) => candidate.bodyId === bodyId);
      const mesh = triangulateSolid(solid);
      return {
        name: body?.name ?? 'Body',
        vertices: mesh.vertices,
        indices: mesh.indices
      };
    });
    return writeAsciiStl(document.name, meshes);
  }
}

export function createKernelAdapter(): KernelAdapter {
  return new OpenZCADKernel();
}
