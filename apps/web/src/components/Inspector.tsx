import {
  useEffect,
  useState,
  type MutableRefObject,
  type ReactNode
} from 'react';
import { Trash2, X } from 'lucide-react';
import { coerceParamValue } from '@openzcad/document-core';
import type {
  BodyId,
  BodyRepresentation,
  BooleanOperation,
  FaceGeometry,
  FeatureNode,
  ParamValue,
  PrimitiveKind,
  RevolveAxis,
  SketchId,
  SketchNode,
  SketchObjectData,
  TopologySelection
} from '@openzcad/shared';
import {
  BooleanForm,
  EdgeModifierForm,
  ExtrudeForm,
  PatternForm,
  PrimitiveForm,
  RevolveForm,
  SketchForm,
  TextSketchForm,
  TransformForm,
  type BodyOption,
  type EdgeModifierFormValue,
  type PatternFormValue,
  type SketchFormValue,
  type TextSketchFormValue,
  type SketchOption,
  type TransformFormValue
} from './forms/FeatureForms';
import { PRIMITIVE_TOOLS, TOOL_META, type ToolId } from '../lib/tools';
import {
  evalParamValue,
  FEATURE_KIND_LABELS,
  formatNumber,
  previewExpression
} from '../lib/model';
import { edgeLabel, faceLabel } from '../lib/topologyLabels';
import { ExprInput } from './ExprInput';

export interface InspectorCallbacks {
  onLaunchTool(tool: ToolId): void;
  onCancel(): void;
  onCreatePrimitive(
    kind: PrimitiveKind,
    name: string,
    dimensions: Record<string, ParamValue>
  ): void;
  onCreateSketch(value: SketchFormValue): void;
  onCreateExtrude(value: {
    name: string;
    sketchId: SketchId;
    distance: ParamValue;
  }): void;
  onCreateRevolve(value: {
    name: string;
    sketchId: SketchId;
    axis: RevolveAxis;
    angleDeg: ParamValue;
  }): void;
  onCreateBoolean(value: {
    name: string;
    operation: BooleanOperation;
    targetBodyIds: BodyOption['bodyId'][];
  }): void;
  onCreateTransform(value: TransformFormValue): void;
  onCreateEdgeModifier(
    kind: 'fillet' | 'chamfer',
    value: EdgeModifierFormValue
  ): void;
  onSelectAllEdges(body: BodyRepresentation): void;
  onClearSelectedEdges(): void;
  onCreatePattern(value: PatternFormValue): void;
  onApplyPrimitive(
    feature: FeatureNode,
    name: string,
    dimensions: Record<string, ParamValue>
  ): void;
  onApplySketch(feature: FeatureNode, value: SketchFormValue): void;
  onConvertSketchToFixedPlane(sketch: SketchNode): void;
  onApplyTextSketch(feature: FeatureNode, value: TextSketchFormValue): void;
  /** Re-enters viewport sketch mode for the feature's sketch. */
  onEditSketchInViewport(feature: FeatureNode): void;
  onApplyExtrude(
    feature: FeatureNode,
    value: { name: string; sketchId: SketchId; distance: ParamValue }
  ): void;
  onApplyRevolve(
    feature: FeatureNode,
    value: {
      name: string;
      sketchId: SketchId;
      axis: RevolveAxis;
      angleDeg: ParamValue;
    }
  ): void;
  onApplyBoolean(
    feature: FeatureNode,
    value: {
      name: string;
      operation: BooleanOperation;
      targetBodyIds: BodyOption['bodyId'][];
    }
  ): void;
  onApplyTransform(feature: FeatureNode, value: TransformFormValue): void;
  onApplyEdgeModifier(
    feature: FeatureNode,
    kind: 'fillet' | 'chamfer',
    value: EdgeModifierFormValue
  ): void;
  onApplyPattern(feature: FeatureNode, value: PatternFormValue): void;
  onResizeThroughHole(
    selection: TopologySelection,
    geometry: FaceGeometry,
    diameter: ParamValue
  ): void;
  onRemoveFaceFeature(
    selection: TopologySelection,
    geometry: FaceGeometry
  ): void;
  onDeleteFeature(feature: FeatureNode): void;
}

interface InspectorProps extends InspectorCallbacks {
  tool: ToolId | null;
  selectedFeature: FeatureNode | null;
  /** Sketch node backing the selected sketch feature, when applicable. */
  selectedSketch: SketchNode | null;
  selectedSketchObject: SketchObjectData | null;
  selectedBody: BodyRepresentation | null;
  selectedTopology: TopologySelection | null;
  selectedEdges: TopologySelection[];
  edgeModifierBody: BodyRepresentation | null;
  scope: Record<string, number>;
  sketches: SketchOption[];
  bodies: BodyOption[];
  units: string;
  /** Viewport selection, in pick order — pre-fills boolean/move targets. */
  selectedBodyIds: BodyId[];
  /** Sketch to pre-select in extrude/revolve, e.g. the one picked in the tree. */
  preferredSketchId: SketchId | null;
  /** Active cylindrical-wall gesture, localized to the inspector subtree. */
  cylinderRadiusEdit: { initialRadius: number } | null;
  cylinderRadiusSetterRef: MutableRefObject<
    ((radius: number | null) => void) | null
  >;
}

function SketchAttachmentSummary({
  sketch,
  onConvert
}: {
  sketch: SketchNode;
  onConvert(sketch: SketchNode): void;
}) {
  if (sketch.planeRef.type === 'canonical') {
    return null;
  }
  const legacyFaceAttachment =
    sketch.planeRef.type === 'face' && !sketch.planeRef.faceReference;
  const attachmentLabel =
    sketch.planeRef.type === 'frame'
      ? 'Fixed plane'
      : legacyFaceAttachment
        ? 'Legacy stored face frame'
        : 'Associative face';
  return (
    <div className="sketch-attachment">
      <div className="kv-grid">
        <b>attachment</b>
        <span>{attachmentLabel}</span>
      </div>
      <p className="muted">
        Geometry for this sketch is edited in viewport sketch mode.
      </p>
      {legacyFaceAttachment ? (
        <>
          <p className="muted error">
            This legacy sketch uses its stored migration frame and does not
            follow later changes to the source face.
          </p>
          <div className="form-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => onConvert(sketch)}
            >
              Convert to fixed plane
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function BodyStats({
  body,
  units
}: {
  body: BodyRepresentation;
  units: string;
}) {
  const size = {
    x: body.bbox.max.x - body.bbox.min.x,
    y: body.bbox.max.y - body.bbox.min.y,
    z: body.bbox.max.z - body.bbox.min.z
  };
  return (
    <>
      <h3 className="section-title">Measurements</h3>
      <div className="kv-grid">
        <b>volume</b>
        <span>
          {formatNumber(body.volume)} {units}³
        </span>
        <b>size</b>
        <span>
          {formatNumber(size.x)} × {formatNumber(size.y)} ×{' '}
          {formatNumber(size.z)} {units}
        </span>
        <b>faces</b>
        <span>{body.faceCount}</span>
        <b>status</b>
        <span>{body.consumed ? 'consumed by boolean' : 'live'}</span>
      </div>
    </>
  );
}

const SURFACE_LABELS: Record<string, string> = {
  plane: 'Planar face',
  cylinder: 'Cylindrical face',
  cone: 'Conical face',
  sphere: 'Spherical face',
  torus: 'Toroidal face',
  bspline: 'B-spline face',
  bezier: 'Bezier face'
};

function FaceDirectEdit({
  body,
  selection,
  scope,
  units,
  onResizeThroughHole,
  onRemoveFaceFeature
}: {
  body: BodyRepresentation;
  selection: TopologySelection;
  scope: Record<string, number>;
  units: string;
  onResizeThroughHole: InspectorCallbacks['onResizeThroughHole'];
  onRemoveFaceFeature: InspectorCallbacks['onRemoveFaceFeature'];
}) {
  const face = body.topology?.faces.find(
    (candidate) => candidate.hash === selection.hash
  );
  const geometry = face?.geometry;
  const [diameter, setDiameter] = useState(() =>
    geometry?.diameter === undefined ? '' : formatNumber(geometry.diameter)
  );
  if (!geometry) {
    return (
      <p className="muted">
        Exact surface measurements are unavailable for this face.
      </p>
    );
  }

  const diameterValue = coerceParamValue(diameter);
  const evaluatedDiameter = evalParamValue(diameterValue, scope);
  const diameterPreview = previewExpression(diameter, scope);
  const canResize =
    geometry.featureType === 'through-hole' &&
    geometry.diameter !== undefined &&
    diameterPreview.ok &&
    evaluatedDiameter !== null &&
    evaluatedDiameter > 1e-6 &&
    Math.abs(evaluatedDiameter - geometry.diameter) >
      Math.max(1e-6, geometry.diameter * 1e-6);
  const surfaceLabel =
    geometry.featureType === 'through-hole'
      ? 'Through hole'
      : (SURFACE_LABELS[geometry.surfaceType] ??
        `${geometry.surfaceType} face`);

  return (
    <section
      className="direct-face-editor"
      aria-label="Selected face properties"
    >
      <h3 className="section-title">Selected feature</h3>
      <div className="selection-summary direct-face-summary">
        <strong>{surfaceLabel}</strong>
        <span className="mono">
          {faceLabel(body, selection.hash, selection.topologyId)}
        </span>
      </div>
      <div className="kv-grid">
        <b>surface</b>
        <span>{geometry.surfaceType}</span>
        <b>area</b>
        <span>
          {formatNumber(geometry.area)} {units}²
        </span>
        {geometry.axialLength !== undefined && (
          <>
            <b>length</b>
            <span>
              {formatNumber(geometry.axialLength)} {units}
            </span>
          </>
        )}
      </div>

      {geometry.featureType === 'through-hole' &&
        geometry.diameter !== undefined && (
          <form
            className="feature-form direct-diameter-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (canResize) {
                onResizeThroughHole(selection, geometry, diameterValue);
              }
            }}
          >
            <ExprInput
              label={`Diameter (${units})`}
              value={diameter}
              scope={scope}
              onChange={setDiameter}
            />
            <div className="form-actions">
              <button type="submit" className="primary" disabled={!canResize}>
                Apply diameter
              </button>
            </div>
          </form>
        )}

      <button
        type="button"
        className="secondary remove-face-feature"
        onClick={() => onRemoveFaceFeature(selection, geometry)}
      >
        <Trash2 size={13} aria-hidden="true" />
        Remove selected feature
      </button>
      <p className="muted direct-edit-note">
        STEP stores faces, not the original feature history. OpenZCAD only
        applies edits the exact kernel can validate; unsupported face
        combinations remain unchanged.
      </p>
    </section>
  );
}

/**
 * Contextual properties panel. Renders the active tool's creation form or the
 * selected feature's edit form (plus edge/face context); the parent hides it
 * entirely when idle.
 */
export function Inspector(props: InspectorProps) {
  const {
    tool,
    selectedFeature,
    selectedSketch,
    selectedSketchObject,
    selectedBody,
    selectedTopology,
    selectedEdges,
    edgeModifierBody,
    scope,
    sketches,
    bodies,
    units,
    selectedBodyIds,
    preferredSketchId,
    cylinderRadiusEdit,
    cylinderRadiusSetterRef
  } = props;
  const [liveCylinderRadius, setLiveCylinderRadius] = useState<number | null>(
    cylinderRadiusEdit?.initialRadius ?? null
  );

  useEffect(() => {
    if (!cylinderRadiusEdit) {
      setLiveCylinderRadius(null);
      cylinderRadiusSetterRef.current = null;
      return;
    }
    setLiveCylinderRadius(cylinderRadiusEdit.initialRadius);
    cylinderRadiusSetterRef.current = (radius) =>
      setLiveCylinderRadius(radius ?? cylinderRadiusEdit.initialRadius);
    return () => {
      cylinderRadiusSetterRef.current = null;
    };
  }, [cylinderRadiusEdit, cylinderRadiusSetterRef]);

  let eyebrow = '';
  let title = '';
  let body: ReactNode = null;

  if (tool) {
    eyebrow = 'New feature';
    title = TOOL_META[tool].label;
    if (PRIMITIVE_TOOLS.includes(tool)) {
      const kind = tool as PrimitiveKind;
      body = (
        <PrimitiveForm
          key={`create-${tool}`}
          kind={kind}
          scope={scope}
          initialName={TOOL_META[tool].label}
          submitLabel="Create"
          onSubmit={(name, dimensions) =>
            props.onCreatePrimitive(kind, name, dimensions)
          }
          onCancel={props.onCancel}
        />
      );
    } else if (tool === 'sketch') {
      body = (
        <SketchForm
          key="create-sketch"
          scope={scope}
          submitLabel="Create"
          onSubmit={props.onCreateSketch}
          onCancel={props.onCancel}
        />
      );
    } else if (tool === 'extrude') {
      body = (
        <ExtrudeForm
          key="create-extrude"
          scope={scope}
          sketches={sketches}
          initialSketchId={preferredSketchId ?? undefined}
          submitLabel="Create"
          onSubmit={props.onCreateExtrude}
          onCancel={props.onCancel}
        />
      );
    } else if (tool === 'revolve') {
      body = (
        <RevolveForm
          key="create-revolve"
          scope={scope}
          sketches={sketches}
          initialSketchId={preferredSketchId ?? undefined}
          submitLabel="Create"
          onSubmit={props.onCreateRevolve}
          onCancel={props.onCancel}
        />
      );
    } else if (
      tool === 'union' ||
      tool === 'subtract' ||
      tool === 'intersect'
    ) {
      body = (
        <BooleanForm
          key={`create-${tool}`}
          bodies={bodies}
          presetOperation={tool}
          initialSelection={selectedBodyIds}
          submitLabel="Create"
          onSubmit={props.onCreateBoolean}
          onCancel={props.onCancel}
        />
      );
    } else if (tool === 'transform') {
      body = (
        <TransformForm
          key="create-transform"
          scope={scope}
          bodies={bodies}
          initialTarget={selectedBodyIds.at(-1)}
          submitLabel="Create"
          onSubmit={props.onCreateTransform}
          onCancel={props.onCancel}
        />
      );
    } else if (tool === 'fillet' || tool === 'chamfer') {
      body = (
        <EdgeModifierForm
          key={`create-${tool}-${edgeModifierBody?.bodyId ?? 'none'}`}
          kind={tool}
          scope={scope}
          targetBodyId={edgeModifierBody?.bodyId ?? null}
          edgeHashes={selectedEdges.flatMap((edge) =>
            edge.hash === undefined ? [] : [edge.hash]
          )}
          availableEdgeCount={
            edgeModifierBody?.topology?.edges.filter(
              (edge) => edge.displayRole !== 'seam'
            ).length
          }
          onSelectAllEdges={
            edgeModifierBody
              ? () => props.onSelectAllEdges(edgeModifierBody)
              : undefined
          }
          onClearEdges={props.onClearSelectedEdges}
          submitLabel="Create"
          onSubmit={(value) => props.onCreateEdgeModifier(tool, value)}
          onCancel={props.onCancel}
        />
      );
    } else {
      const patternKind = tool === 'linear-pattern' ? 'linear' : 'circular';
      body = (
        <PatternForm
          key={`create-${patternKind}`}
          kind={patternKind}
          scope={scope}
          bodies={bodies}
          selectedBodyId={
            selectedTopology?.bodyId ??
            selectedBodyIds.at(-1) ??
            selectedBody?.bodyId
          }
          submitLabel="Create"
          onSubmit={props.onCreatePattern}
          onCancel={props.onCancel}
        />
      );
    }
  } else if (selectedFeature) {
    eyebrow = FEATURE_KIND_LABELS[selectedFeature.featureKind];
    title = selectedFeature.name;
    const editKey = `edit-${selectedFeature.id}`;
    const data = selectedFeature.data;
    let form: ReactNode = null;

    if (data.featureKind === 'primitive') {
      form = (
        <PrimitiveForm
          key={editKey}
          kind={data.primitiveKind}
          scope={scope}
          initialName={selectedFeature.name}
          initialDimensions={data.dimensions}
          liveRadius={
            data.primitiveKind === 'cylinder'
              ? liveCylinderRadius
              : undefined
          }
          submitLabel="Apply"
          onSubmit={(name, dimensions) =>
            props.onApplyPrimitive(selectedFeature, name, dimensions)
          }
          onCancel={props.onCancel}
        />
      );
    } else if (
      data.featureKind === 'sketch' &&
      selectedSketch &&
      selectedSketchObject &&
      selectedSketchObject.objectKind === 'text'
    ) {
      // Text sketches get their own form: the closed-shape form below would
      // present them as a rectangle, and applying it would replace the text.
      form = (
        <>
          <TextSketchForm
            key={editKey}
            scope={scope}
            initial={{
              name: selectedFeature.name,
              object: selectedSketchObject
            }}
            onSubmit={(value) =>
              props.onApplyTextSketch(selectedFeature, value)
            }
            onCancel={props.onCancel}
            onEditInViewport={() =>
              props.onEditSketchInViewport(selectedFeature)
            }
          />
          <SketchAttachmentSummary
            sketch={selectedSketch}
            onConvert={props.onConvertSketchToFixedPlane}
          />
        </>
      );
    } else if (
      data.featureKind === 'sketch' &&
      selectedSketch &&
      selectedSketchObject &&
      selectedSketch.planeRef.type === 'canonical'
    ) {
      form = (
        <SketchForm
          key={editKey}
          scope={scope}
          initial={{
            name: selectedFeature.name,
            plane: selectedSketch.planeRef.plane,
            offset: selectedSketch.planeRef.offset,
            object: selectedSketchObject
          }}
          submitLabel="Apply"
          onSubmit={(value) => props.onApplySketch(selectedFeature, value)}
          onCancel={props.onCancel}
        />
      );
    } else if (
      data.featureKind === 'sketch' &&
      selectedSketch &&
      selectedSketch.planeRef.type !== 'canonical'
    ) {
      form = (
        <SketchAttachmentSummary
          sketch={selectedSketch}
          onConvert={props.onConvertSketchToFixedPlane}
        />
      );
    } else if (data.featureKind === 'extrude') {
      form = (
        <ExtrudeForm
          key={editKey}
          scope={scope}
          sketches={sketches}
          initial={{
            name: selectedFeature.name,
            sketchId: data.sketchId,
            distance: data.distance
          }}
          submitLabel="Apply"
          onSubmit={(value) => props.onApplyExtrude(selectedFeature, value)}
          onCancel={props.onCancel}
        />
      );
    } else if (data.featureKind === 'revolve') {
      form = (
        <RevolveForm
          key={editKey}
          scope={scope}
          sketches={sketches}
          initial={{
            name: selectedFeature.name,
            sketchId: data.sketchId,
            axis: data.axis,
            angleDeg: data.angleDeg
          }}
          submitLabel="Apply"
          onSubmit={(value) => props.onApplyRevolve(selectedFeature, value)}
          onCancel={props.onCancel}
        />
      );
    } else if (data.featureKind === 'boolean') {
      form = (
        <BooleanForm
          key={editKey}
          bodies={bodies}
          initial={{
            name: selectedFeature.name,
            operation: data.operation,
            targetBodyIds: data.targetBodyIds
          }}
          submitLabel="Apply"
          onSubmit={(value) => props.onApplyBoolean(selectedFeature, value)}
          onCancel={props.onCancel}
        />
      );
    } else if (data.featureKind === 'transform') {
      form = (
        <TransformForm
          key={editKey}
          scope={scope}
          bodies={bodies}
          initial={{
            name: selectedFeature.name,
            targetBodyId: data.targetBodyId,
            translation: data.transform.translation,
            rotationDeg: data.transform.rotationDeg
          }}
          submitLabel="Apply"
          onSubmit={(value) => props.onApplyTransform(selectedFeature, value)}
          onCancel={props.onCancel}
        />
      );
    } else if (
      data.featureKind === 'fillet' ||
      data.featureKind === 'chamfer'
    ) {
      form = (
        <EdgeModifierForm
          key={editKey}
          kind={data.featureKind}
          scope={scope}
          targetBodyId={data.targetBodyId}
          edgeHashes={data.edgeHashes}
          initial={{
            name: selectedFeature.name,
            size: data.featureKind === 'fillet' ? data.radius : data.distance
          }}
          submitLabel="Apply"
          onSubmit={(value) =>
            props.onApplyEdgeModifier(selectedFeature, data.featureKind, value)
          }
          onCancel={props.onCancel}
        />
      );
    } else if (data.featureKind === 'pattern') {
      form = (
        <PatternForm
          key={editKey}
          kind={data.patternKind}
          scope={scope}
          bodies={bodies}
          initial={{
            name: selectedFeature.name,
            targetBodyId: data.targetBodyId,
            patternKind: data.patternKind,
            count: data.count,
            axis: data.axis,
            spacing: data.spacing,
            angleDeg: data.angleDeg
          }}
          submitLabel="Apply"
          onSubmit={(value) => props.onApplyPattern(selectedFeature, value)}
          onCancel={props.onCancel}
        />
      );
    } else if (data.featureKind === 'direct-edit') {
      form = (
        <div className="kv-grid">
          <b>operation</b>
          <span>
            {data.operation.kind === 'resize-through-hole'
              ? 'resize through hole'
              : data.operation.kind === 'resize-cylindrical-face'
                ? 'resize cylinder radius'
                : data.operation.kind === 'offset-face'
                  ? 'offset face'
                  : 'remove face feature'}
          </span>
          <b>source face</b>
          <span>
            {props.selectedBody
              ? faceLabel(props.selectedBody, data.operation.faceHash)
              : `face ${String(data.operation.faceHash).slice(-6)}`}
          </span>
          {data.operation.kind === 'resize-through-hole' && (
            <>
              <b>diameter</b>
              <span>{String(data.operation.diameter)}</span>
            </>
          )}
          {data.operation.kind === 'resize-cylindrical-face' && (
            <>
              <b>radius</b>
              <span>{String(data.operation.radius)}</span>
            </>
          )}
        </div>
      );
    } else if (data.featureKind === 'imported-mesh') {
      form = (
        <div className="kv-grid">
          <b>source</b>
          <span>{data.sourceName}</span>
          <b>triangles</b>
          <span>{data.triangleCount}</span>
        </div>
      );
    } else if (data.featureKind === 'imported-step') {
      form = (
        <div className="kv-grid">
          <b>source</b>
          <span>{data.sourceName}</span>
          <b>mode</b>
          <span>editable exact B-rep</span>
        </div>
      );
    }

    body = (
      <>
        {cylinderRadiusEdit && liveCylinderRadius !== null && (
          <section
            className="direct-face-editor"
            aria-label="Cylinder radius properties"
          >
            <h3 className="section-title">Direct edit</h3>
            <div className="kv-grid">
              <b>Radius</b>
              <span data-testid="live-cylinder-radius">
                {formatNumber(liveCylinderRadius)} {units}
              </span>
            </div>
          </section>
        )}
        {selectedTopology?.kind === 'edge' && (
          <>
            <h3 className="section-title">
              {selectedEdges.length > 1
                ? `${selectedEdges.length} selected edges`
                : 'Selected edge'}
            </h3>
            <div className="tool-grid">
              {(['fillet', 'chamfer'] as const).map((edgeTool) => (
                <button
                  key={edgeTool}
                  type="button"
                  className="tool-button"
                  onClick={() => props.onLaunchTool(edgeTool)}
                >
                  {TOOL_META[edgeTool].icon}
                  {TOOL_META[edgeTool].label}
                </button>
              ))}
            </div>
          </>
        )}
        {form}
        {selectedTopology?.kind === 'face' &&
          selectedBody?.source === 'imported-step' && (
            <FaceDirectEdit
              key={`${selectedBody.bodyId}:${selectedTopology.hash ?? selectedTopology.topologyId}`}
              body={selectedBody}
              selection={selectedTopology}
              scope={scope}
              units={units}
              onResizeThroughHole={props.onResizeThroughHole}
              onRemoveFaceFeature={props.onRemoveFaceFeature}
            />
          )}
        {selectedBody && <BodyStats body={selectedBody} units={units} />}
        {selectedTopology?.kind !== 'body' && selectedTopology && (
          <div className="topology-selection">
            <b>{selectedTopology.kind}</b>
            <span className="mono">
              {selectedTopology.kind === 'edge'
                ? edgeLabel(
                    selectedBody ?? undefined,
                    selectedTopology.hash,
                    selectedTopology.topologyId
                  )
                : faceLabel(
                    selectedBody ?? undefined,
                    selectedTopology.hash,
                    selectedTopology.topologyId
                  )}
            </span>
          </div>
        )}
        <div className="form-actions danger-zone">
          <button
            type="button"
            className="secondary danger"
            title="Delete feature (Del)"
            onClick={() => props.onDeleteFeature(selectedFeature)}
          >
            <Trash2 size={13} aria-hidden="true" />
            {selectedFeature.data.featureKind === 'imported-step'
              ? 'Delete imported body'
              : 'Delete feature'}
          </button>
        </div>
      </>
    );
  }

  if (!body) {
    return null;
  }

  return (
    <section className="inspector" aria-label="Feature inspector">
      <div className="panel-header">
        <div className="panel-title-row">
          <h2>{title}</h2>
          <span className="panel-eyebrow">{eyebrow}</span>
          <button
            type="button"
            className="icon-button panel-close"
            title="Close (Esc)"
            aria-label="Close panel"
            onClick={props.onCancel}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="panel-body">{body}</div>
    </section>
  );
}
