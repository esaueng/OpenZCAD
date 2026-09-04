import { useEffect, useRef, useState, type ReactNode } from 'react';
import { unitLabel } from '../lib/measurements';
import { MoreHorizontal, Trash2, X } from 'lucide-react';
import { coerceParamValue } from '@openzcad/document-core';
import { findFontFace } from '@openzcad/geometry';
import { FEATURE_COLORS, featureColor } from '@openzcad/shared';
import type {
  UnitSystem,
  BodyId,
  BodyRepresentation,
  BooleanOperation,
  FaceGeometry,
  FeatureId,
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
import type { CommandSession } from '../lib/interaction/machine';
import {
  inspectorHeadingForFeature,
  type FeatureSelectionSource
} from '../lib/inspectorHeading';
import { ExprInput } from './ExprInput';
import { ColorPicker } from './ColorPicker';
import { FieldAutoFocusProvider } from './forms/fieldAutoFocus';
import type { BodyAppearancePreview } from './ModelViewer';
import {
  canRemoveImportedBlendFace,
  importedBlendEditNotice
} from '../lib/interaction/filletFaceEdit';

function isValidTextSketchObject(
  value: Extract<SketchObjectData, { objectKind: 'text' }>
): boolean {
  return (
    typeof value.text === 'string' &&
    typeof value.fontFamily === 'string' &&
    findFontFace(value.fontFamily, value.fontStyle) !== undefined
  );
}

export interface InspectorCallbacks {
  onLaunchTool(tool: ToolId): void;
  onCancel(): void;
  /** Verbatim reason the last exact rebuild refused this form's operation. */
  commitError?: string | null;
  onCreatePrimitive(
    kind: PrimitiveKind,
    name: string,
    dimensions: Record<string, ParamValue>
  ): void;
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
    value: {
      name: string;
      sketchId: SketchId;
      distance: ParamValue;
      symmetric?: boolean;
      backDistance?: ParamValue;
    }
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
  /** Pins an inferred feature so its editable form becomes the panel subject. */
  onPinFeature(feature: FeatureNode): void;
  onDeleteFeature(feature: FeatureNode): void;
  /** Include/exclude one declared solid of an imported-step feature. */
  onToggleImportedSolid(featureId: FeatureId, solidIndex: number): void;
  /** Drag-phase body appearance patch; null restores the committed look. */
  onPreviewBodyAppearance(preview: BodyAppearancePreview | null): void;
  /** Commits body appearance through node metadata; null opacity resets. */
  onCommitBodyAppearance(
    bodyId: BodyId,
    appearance: { color?: string; opacity?: number | null }
  ): void;
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
  units: UnitSystem;
  /** Viewport selection, in pick order — pre-fills boolean/move targets. */
  selectedBodyIds: BodyId[];
  /** Sketch to pre-select in extrude/revolve, e.g. the one picked in the tree. */
  preferredSketchId: SketchId | null;
  /**
   * The command the viewport selection has armed, read straight from the
   * interaction machine. The panel names it but never edits its value: the
   * handle and its chip own that, and a second editable copy here is how the
   * two used to disagree.
   */
  commandSession: CommandSession | null;
  /**
   * Whether the selected feature was pinned by a click in the history tree or
   * inferred from the body under a viewport pick. Only a pinned feature may
   * title this panel.
   */
  featureSelectionSource: FeatureSelectionSource | null;
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
  units: UnitSystem;
}) {
  const size = {
    x: body.bbox.max.x - body.bbox.min.x,
    y: body.bbox.max.y - body.bbox.min.y,
    z: body.bbox.max.z - body.bbox.min.z
  };
  const mass = body.massProperties;
  return (
    <>
      <CollapsibleSection title="Measurements" defaultOpen>
        <div className="kv-grid">
          <b>volume</b>
          <span>
            {formatNumber(body.volume)} {unitLabel('volume', units)}
          </span>
          <b>size</b>
          <span>
            {formatNumber(size.x)} × {formatNumber(size.y)} ×{' '}
            {formatNumber(size.z)} {unitLabel('length', units)}
          </span>
          <b>faces</b>
          <span>{body.faceCount}</span>
          <b>status</b>
          <span>
            {body.consumed ? 'combined into a later feature' : 'live'}
          </span>
        </div>
      </CollapsibleSection>
      {mass ? (
        // Unit density: multiply by a material density for physical values.
        // Rendered only when the kernel integrated this solid — the absence
        // of the section is the honest reading of a failed integration.
        <CollapsibleSection title="Mass properties">
          <div className="kv-grid">
            <b>center of mass</b>
            <span>
              {formatNumber(mass.centerOfMass.x)},{' '}
              {formatNumber(mass.centerOfMass.y)},{' '}
              {formatNumber(mass.centerOfMass.z)} {unitLabel('length', units)}
            </span>
            <b>principal inertia</b>
            <span>
              {formatNumber(mass.principalMoments[0])} ·{' '}
              {formatNumber(mass.principalMoments[1])} ·{' '}
              {formatNumber(mass.principalMoments[2])}{' '}
              {unitLabel('length', units)}⁵
            </span>
          </div>
        </CollapsibleSection>
      ) : null}
    </>
  );
}

/**
 * The header's overflow menu.
 *
 * A native disclosure does not close when you click away from it, which for a
 * menu means it sits open over the panel until you click it again. The colour
 * picker in this file already solved that; this uses the same listener rather
 * than inventing a second behaviour for the same gesture.
 */
function PanelOverflow({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const close = (event: Event) => {
      const menu = ref.current;
      if (
        menu?.open &&
        event.target instanceof Node &&
        !menu.contains(event.target)
      ) {
        menu.open = false;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && ref.current?.open) {
        // Stop here: the panel's own Escape handler closes the whole panel,
        // and dismissing a menu should not also dismiss what it belongs to.
        event.stopPropagation();
        ref.current.open = false;
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
  return (
    <details className="panel-overflow" ref={ref}>
      <summary
        className="icon-button"
        title="More actions"
        aria-label="More actions"
      >
        <MoreHorizontal size={14} aria-hidden="true" />
      </summary>
      <div className="panel-overflow-menu">{children}</div>
    </details>
  );
}

/**
 * A panel section that can be folded away.
 *
 * Everything here used to be laid out flat, so a body's principal inertia had
 * the same claim on the panel as the thing the user had just selected. The
 * sections stay one keystroke away rather than being moved somewhere else —
 * an engineer who wants inertia should not have to go looking for it.
 */
function CollapsibleSection({
  title,
  defaultOpen = false,
  children
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="panel-section" open={defaultOpen}>
      <summary className="section-title">{title}</summary>
      {children}
    </details>
  );
}

/** Preset swatches: the feature palette, deduped, in the picker's grid. */
const BODY_COLOR_PRESETS = [...new Set(Object.values(FEATURE_COLORS))];

/**
 * Per-body display color and opacity. Edits stream to the viewport as a
 * material-level preview on every change and commit through node metadata on
 * release/blur, so a picker drag never waits on a kernel rebuild.
 */
function BodyAppearance({
  body,
  onPreview,
  onCommit
}: {
  body: BodyRepresentation;
  onPreview: InspectorCallbacks['onPreviewBodyAppearance'];
  onCommit: (appearance: { color?: string; opacity?: number | null }) => void;
}) {
  const defaultColor = featureColor(body.source);
  const [draftColor, setDraftColor] = useState(body.color);
  const [draftOpacity, setDraftOpacity] = useState(body.opacity ?? 1);
  const [pickerOpen, setPickerOpen] = useState(false);
  const committedRef = useRef({
    color: body.color,
    opacity: body.opacity ?? 1
  });
  const controlsRef = useRef<HTMLDivElement | null>(null);

  // Resync drafts when the committed representation changes: another body
  // selected, an undo, or this commit's rebuild landing.
  useEffect(() => {
    const committed = { color: body.color, opacity: body.opacity ?? 1 };
    committedRef.current = committed;
    setDraftColor(committed.color);
    setDraftOpacity(committed.opacity);
  }, [body.bodyId, body.color, body.opacity]);

  function commitDraft(overrideColor?: string) {
    onPreview(null);
    const committed = committedRef.current;
    const color = overrideColor ?? draftColor;
    const patch: { color?: string; opacity?: number | null } = {};
    if (color.toLowerCase() !== committed.color.toLowerCase()) {
      patch.color = color;
    }
    if (draftOpacity !== committed.opacity) {
      patch.opacity = draftOpacity >= 1 ? null : draftOpacity;
    }
    if (patch.color === undefined && patch.opacity === undefined) {
      return;
    }
    committedRef.current = {
      color: patch.color ?? committed.color,
      opacity: draftOpacity
    };
    onCommit(patch);
  }

  const commitDraftRef = useRef(commitDraft);
  commitDraftRef.current = commitDraft;

  // Clicking outside or pressing Escape closes the picker and commits the
  // last previewed value (a no-op when the picker already committed it).
  useEffect(() => {
    if (!pickerOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (
        controlsRef.current &&
        event.target instanceof Node &&
        !controlsRef.current.contains(event.target)
      ) {
        setPickerOpen(false);
        commitDraftRef.current();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPickerOpen(false);
        commitDraftRef.current();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [pickerOpen]);

  const isDefault =
    draftColor.toLowerCase() === defaultColor.toLowerCase() &&
    draftOpacity >= 1;

  return (
    <CollapsibleSection title="Appearance">
      <div className="appearance-controls" ref={controlsRef}>
        <div className="appearance-field">
          <span>Color</span>
          <span className="appearance-inputs">
            <button
              type="button"
              className="appearance-swatch"
              aria-label="Pick body color"
              aria-expanded={pickerOpen}
              style={{ background: draftColor }}
              onClick={() => {
                if (pickerOpen) {
                  commitDraft();
                }
                setPickerOpen((open) => !open);
              }}
            />
            <span className="appearance-value">{draftColor}</span>
          </span>
        </div>
        {pickerOpen && (
          <ColorPicker
            color={draftColor}
            presets={BODY_COLOR_PRESETS}
            onChange={(color) => {
              setDraftColor(color);
              onPreview({ bodyId: body.bodyId, color });
            }}
            onCommit={(color) => {
              setDraftColor(color);
              commitDraft(color);
            }}
          />
        )}
        <label className="appearance-field">
          <span>Opacity</span>
          <span className="appearance-inputs">
            <input
              type="range"
              aria-label="Body opacity"
              min={0.05}
              max={1}
              step={0.05}
              value={draftOpacity}
              onChange={(event) => {
                const opacity = Number(event.target.value);
                setDraftOpacity(opacity);
                onPreview({ bodyId: body.bodyId, opacity });
              }}
              onPointerUp={() => commitDraft()}
              onKeyUp={() => commitDraft()}
              onBlur={() => commitDraft()}
            />
            <span className="appearance-value">
              {Math.round(draftOpacity * 100)}%
            </span>
          </span>
        </label>
        {!isDefault && (
          <button
            type="button"
            className="appearance-reset"
            onClick={() => {
              onPreview(null);
              committedRef.current = { color: defaultColor, opacity: 1 };
              setDraftColor(defaultColor);
              setDraftOpacity(1);
              onCommit({ color: defaultColor, opacity: null });
            }}
          >
            Reset to feature default
          </button>
        )}
      </div>
    </CollapsibleSection>
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
  units: UnitSystem;
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
  const canRemove =
    geometry.featureType !== 'blend' ||
    (face ? canRemoveImportedBlendFace(body, face) : false);
  const editNotice = face ? importedBlendEditNotice(body, face) : null;
  const surfaceLabel =
    geometry.featureType === 'blend'
      ? 'Imported blend'
      : geometry.featureType === 'through-hole'
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
        {geometry.featureType === 'blend' &&
          geometry.blendRadius !== undefined && (
            <>
              <b>fillet radius</b>
              <span>
                R {formatNumber(geometry.blendRadius)} {units}
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

      {canRemove && (
        <button
          type="button"
          className="secondary remove-face-feature"
          onClick={() => onRemoveFaceFeature(selection, geometry)}
        >
          <Trash2 size={13} aria-hidden="true" />
          Remove selected feature
        </button>
      )}
      <p className="muted direct-edit-note">
        {editNotice ??
          'STEP stores faces, not the original feature history. OpenZCAD only applies edits the exact kernel can validate; unsupported face combinations remain unchanged.'}
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
    commandSession,
    featureSelectionSource
  } = props;
  const selectedEdgeReferences = selectedEdges.flatMap((edge) =>
    edge.reference?.kind === 'edge' ? [edge.reference] : []
  );

  /**
   * Hand an edit panel the keyboard without handing it a field.
   *
   * Create dialogs are left alone: a child field autofocuses there, and moving
   * focus to the section afterwards would take it straight back off again.
   */
  const panelRef = useRef<HTMLElement | null>(null);
  const editPanelKey =
    tool === null
      ? (selectedFeature?.featureId ??
        selectedBody?.bodyId ??
        (selectedTopology ? 'topology' : null))
      : null;
  useEffect(() => {
    if (editPanelKey === null) {
      return;
    }
    const panel = panelRef.current;
    // Never pull focus out of something the user is already using — a viewport
    // pick can re-render this panel while a field is being typed into.
    if (panel && !panel.contains(document.activeElement)) {
      panel.focus({ preventScroll: true });
    }
  }, [editPanelKey]);

  let eyebrow = '';
  let title = '';
  let body: ReactNode = null;
  let objectReadout = false;
  /**
   * The panel's destructive action, when it has one.
   *
   * It used to sit at the foot of every edit panel as a permanent full-width
   * red button — the most prominent control in the panel was the one that
   * throws the feature away. It lives in the header menu now; the command
   * history makes it recoverable, which is what earns it a quiet place.
   */
  let deleteAction: { label: string; run: () => void } | null = null;

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
      // No create branch for 'transform': the move gizmo is the only way to
      // make a Move now that it carries the Name field and body picker this
      // form existed for (WF-07). Editing an existing Move still uses
      // TransformForm, below.
    } else if (tool === 'scale') {
      // Scale has no gizmo: the factor is parametric, so the form is the
      // right UI. It creates the same transform feature a Move does.
      body = (
        <TransformForm
          key="create-scale"
          scope={scope}
          bodies={bodies}
          initialTarget={
            selectedTopology?.bodyId ??
            selectedBodyIds.at(-1) ??
            selectedBody?.bodyId
          }
          defaultName="Scale"
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
          edgeReferences={
            selectedEdges.length > 0 &&
            selectedEdgeReferences.length === selectedEdges.length
              ? selectedEdgeReferences
              : undefined
          }
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
      const patternKind =
        tool === 'linear-pattern'
          ? 'linear'
          : tool === 'grid-pattern'
            ? 'grid'
            : 'circular';
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
    const selectionLabel =
      selectedTopology?.kind === 'edge'
        ? edgeLabel(
            selectedBody ?? undefined,
            selectedTopology.hash,
            selectedTopology.topologyId
          )
        : selectedTopology?.kind === 'face'
          ? faceLabel(
              selectedBody ?? undefined,
              selectedTopology.hash,
              selectedTopology.topologyId
            )
          : selectedBody?.name;
    const heading = inspectorHeadingForFeature({
      featureName: selectedFeature.name,
      featureKindLabel: FEATURE_KIND_LABELS[selectedFeature.featureKind],
      ...(selectionLabel ? { selectionLabel } : {}),
      ...(selectedBody ? { selectionBodyName: selectedBody.name } : {}),
      featureSelectionSource,
      commandSession
    });
    const inferredUnderCommand = heading.demoted;
    objectReadout = inferredUnderCommand;
    eyebrow = heading.eyebrow;
    title = heading.title;
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
      form = isValidTextSketchObject(selectedSketchObject) ? (
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
      ) : (
        <p className="form-error" role="alert">
          This text sketch is malformed and cannot be edited safely.
        </p>
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
            distance: data.distance,
            ...(data.symmetric ? { symmetric: true } : {}),
            ...(data.backDistance !== undefined
              ? { backDistance: data.backDistance }
              : {}),
            operation: data.operation
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
            rotationDeg: data.transform.rotationDeg,
            ...(data.transform.scale !== undefined
              ? { scale: data.transform.scale }
              : {})
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
          edgeReferences={data.edgeReferences}
          initial={{
            name: selectedFeature.name,
            size: data.featureKind === 'fillet' ? data.radius : data.distance,
            ...(data.featureKind === 'chamfer' && data.angleDeg !== undefined
              ? { angleDeg: data.angleDeg }
              : {})
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
            angleDeg: data.angleDeg,
            ...(data.direction ? { direction: data.direction } : {}),
            ...(data.axis2 ? { axis2: data.axis2 } : {}),
            ...(data.spacing2 !== undefined ? { spacing2: data.spacing2 } : {}),
            ...(data.count2 !== undefined ? { count2: data.count2 } : {})
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
              : data.operation.kind === 'resize-imported-blind-hole'
                ? 'parameterize imported blind hole'
                : data.operation.kind === 'resize-imported-counterbore'
                  ? 'parameterize imported counterbore'
                  : data.operation.kind === 'resize-imported-countersink'
                    ? 'parameterize imported countersink'
                    : data.operation.kind === 'set-face-distance'
                      ? 'set face distance'
                      : data.operation.kind === 'resize-cylindrical-face'
                        ? 'resize cylinder radius'
                        : data.operation.kind === 'resize-blend'
                          ? 'resize imported blend'
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
          {data.operation.kind === 'set-face-distance' && (
            <>
              <b>opposite face</b>
              <span>
                {props.selectedBody
                  ? faceLabel(
                      props.selectedBody,
                      data.operation.oppositeFaceHash
                    )
                  : `face ${String(data.operation.oppositeFaceHash).slice(-6)}`}
              </span>
              <b>distance</b>
              <span>{String(data.operation.distance)}</span>
              <b>move mode</b>
              <span>{data.operation.moveMode.replaceAll('-', ' ')}</span>
            </>
          )}
          {data.operation.kind === 'resize-through-hole' && (
            <>
              <b>diameter</b>
              <span>{String(data.operation.diameter)}</span>
            </>
          )}
          {data.operation.kind === 'resize-imported-blind-hole' && (
            <>
              <b>diameter</b>
              <span>{String(data.operation.diameter)}</span>
              <b>depth</b>
              <span>{String(data.operation.depth)}</span>
            </>
          )}
          {data.operation.kind === 'resize-imported-counterbore' && (
            <>
              <b>bore diameter</b>
              <span>{String(data.operation.boreDiameter)}</span>
              <b>counterbore diameter</b>
              <span>{String(data.operation.counterboreDiameter)}</span>
              <b>counterbore depth</b>
              <span>{String(data.operation.counterboreDepth)}</span>
            </>
          )}
          {data.operation.kind === 'resize-imported-countersink' && (
            <>
              <b>bore diameter</b>
              <span>{String(data.operation.boreDiameter)}</span>
              <b>sink diameter</b>
              <span>{String(data.operation.sinkDiameter)}</span>
              <b>included angle (rad)</b>
              <span>{String(data.operation.angleRadians)}</span>
            </>
          )}
          {data.operation.kind === 'resize-cylindrical-face' && (
            <>
              <b>radius</b>
              <span>{String(data.operation.radius)}</span>
            </>
          )}
          {data.operation.kind === 'resize-blend' && (
            <>
              <b>radius</b>
              <span>{String(data.operation.newRadius)}</span>
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
      const declaredCount = selectedBody?.importedStepDeclaredSolidCount ?? 0;
      const included = (index: number) =>
        data.solidIndices === undefined || data.solidIndices.includes(index);
      const includedCount = Array.from(
        { length: declaredCount },
        (_, index) => index
      ).filter(included).length;
      form = (
        <>
          <div className="kv-grid">
            <b>source</b>
            <span>{data.sourceName}</span>
            <b>mode</b>
            <span>editable exact B-rep</span>
          </div>
          {declaredCount > 1 && (
            <fieldset className="import-solid-selection">
              <legend>Imported solids</legend>
              {Array.from({ length: declaredCount }, (_, index) => (
                <label key={index}>
                  <input
                    type="checkbox"
                    checked={included(index)}
                    // The last included solid cannot be removed: an import
                    // of nothing is a build failure, not a lighter body.
                    disabled={included(index) && includedCount === 1}
                    onChange={() =>
                      props.onToggleImportedSolid(
                        selectedFeature.featureId,
                        index
                      )
                    }
                  />
                  <span>Solid {index + 1}</span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      );
    }

    const featurePanel = (
      <>
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
        {selectedBody && !selectedBody.consumed && (
          <BodyAppearance
            body={selectedBody}
            onPreview={props.onPreviewBodyAppearance}
            onCommit={(appearance) =>
              props.onCommitBodyAppearance(selectedBody.bodyId, appearance)
            }
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
      </>
    );
    body = inferredUnderCommand ? (
      <>
        {selectedBody && <BodyStats body={selectedBody} units={units} />}
        <div className="object-definition-row">
          <span>
            <b>Defined by</b> {selectedFeature.name}
          </span>
          <button
            type="button"
            className="secondary"
            onClick={() => props.onPinFeature(selectedFeature)}
          >
            Edit
          </button>
        </div>
      </>
    ) : (
      featurePanel
    );
    if (!inferredUnderCommand) {
      deleteAction = {
        label:
          selectedFeature.data.featureKind === 'imported-step'
            ? 'Delete imported body'
            : 'Delete feature',
        run: () => props.onDeleteFeature(selectedFeature)
      };
    }
  }

  if (!body) {
    return null;
  }

  return (
    <section
      className={`inspector${objectReadout ? ' object-readout' : ''}`}
      aria-label="Feature inspector"
      ref={panelRef}
      // An edit panel no longer holds the keyboard through a focused field, so
      // it holds it here instead. A section is not an input, so the workspace
      // still counts this as "not typing" and B/M/W keep working — but Escape
      // now reaches the panel that the status bar says it closes, and one Tab
      // still steps into the first field.
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <div className="panel-header">
        <div className="panel-title-row">
          <h2>{title}</h2>
          <span className="panel-eyebrow">{eyebrow}</span>
          {deleteAction ? (
            <PanelOverflow>
              <button
                type="button"
                className="panel-overflow-item danger"
                title={`${deleteAction.label} (Del)`}
                onClick={deleteAction.run}
              >
                <Trash2 size={13} aria-hidden="true" />
                {deleteAction.label}
              </button>
            </PanelOverflow>
          ) : null}
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
      {/*
        A create dialog is here because a tool was invoked, so it may take the
        keyboard; an edit panel is here because something was selected, and
        must not — the workspace's single-letter shortcuts belong to the user
        until they ask for a field.
      */}
      <FieldAutoFocusProvider allowed={tool !== null}>
        <div className="panel-body">
          {props.commitError && (
            // A refused exact rebuild leaves this panel open and otherwise
            // unchanged, so without the reason here the click reads as having
            // done nothing at all. Rendered in full: the status bar clips it.
            <p className="field-error inspector-commit-error" role="alert">
              {props.commitError}
            </p>
          )}
          {body}
        </div>
      </FieldAutoFocusProvider>
    </section>
  );
}
