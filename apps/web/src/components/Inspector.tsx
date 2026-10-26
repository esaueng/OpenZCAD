import type { MassPropertiesRead } from '@openzcad/kernel-adapter/exact';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { unitLabel } from '../lib/measurements';
import {
  loadMassDensitySelection,
  saveMassDensitySelection
} from '../lib/massDensityPreference';
import { Trash2 } from 'lucide-react';
import { coerceParamValue } from '@openzcad/document-core';
import { findFontFace } from '@openzcad/geometry';
import {
  MATERIAL_DENSITY_PRESETS,
  MAX_CUSTOM_DENSITY_KG_PER_M3,
  UNIT_MASS_DENSITY_SELECTION,
  convertInertia,
  convertMass,
  describeMassDensitySelection,
  displayInertiaUnit,
  displayMassUnit,
  inertiaSiKgM2,
  massKg,
  normalizeMassDensitySelection,
  parseCustomDensityKgPerM3,
  resolveDensityKgPerM3
} from '@openzcad/shared';
import type {
  FaceRecognitionSummary,
  ProjectDocument,
  UnitSystem,
  BodyId,
  BodyMassProperties,
  BodyRepresentation,
  FaceGeometry,
  FeatureId,
  FeatureNode,
  MassDensitySelection,
  ParamValue,
  SketchNode,
  SketchObjectData,
  TopologySelection
} from '@openzcad/shared';
import {
  PrimitiveForm,
  SketchForm,
  TextSketchForm,
  TransformForm,
  type BodyOption,
  type SketchFormValue,
  type TextSketchFormValue,
  type TransformFormValue
} from './forms/FeatureForms';
import { TOOL_META, type ToolId } from '../lib/tools';
import {
  applyPrimitiveCommand,
  primitivePlacement
} from '../lib/primitivePlacement';
import type { AnyCommand } from '@openzcad/command-system';
import { inPlaceToolForFeature } from '../lib/inPlace/edit';
import {
  evalParamValue,
  FEATURE_KIND_LABELS,
  formatMeasuredQuantity,
  formatNumber,
  previewExpression
} from '../lib/model';
import { edgeLabel, edgeLength, faceLabel } from '../lib/topologyLabels';
import { datumAxisChoices } from '../lib/datumAxisChoices';
import type { CommandSession } from '../lib/interaction/machine';
import {
  inspectorHeadingForFeature,
  type FeatureSelectionSource
} from '../lib/inspectorHeading';
import { CARD_EYEBROWS } from '../lib/cardEyebrows';
import { ExprInput } from './ExprInput';
import { CardHeader } from './CardHeader';
import { PanelOverflow } from './PanelOverflow';
import { FieldAutoFocusProvider } from './forms/fieldAutoFocus';
import {
  canRemoveImportedBlendFace,
  importedBlendEditNotice
} from '../lib/interaction/filletFaceEdit';
import {
  useImportedFaceRecognition,
  type ImportedFaceRecognitionQuery,
  type RecognizeImportedFaceInput
} from '../hooks/useImportedFaceRecognition';

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
  /** Escape and the forms' Cancel: back to nothing selected. */
  onCancel(): void;
  /**
   * The header's close button: closes the panel and keeps the selection.
   * Falls back to `onCancel` when absent.
   */
  onClose?(): void;
  /** Verbatim reason the last exact rebuild refused this form's operation. */
  commitError?: string | null;
  /** The primitive card's Apply: its dimensions and, if moved, placement. */
  onApplyPrimitive(
    feature: FeatureNode,
    name: string,
    command: AnyCommand
  ): void;
  /** The committed document; a primitive card reads its placement from it. */
  document?: ProjectDocument | null;
  onApplySketch(feature: FeatureNode, value: SketchFormValue): void;
  onConvertSketchToFixedPlane(sketch: SketchNode): void;
  onApplyTextSketch(feature: FeatureNode, value: TextSketchFormValue): void;
  /** Re-enters viewport sketch mode for the feature's sketch. */
  onEditSketchInViewport(feature: FeatureNode): void;
  /**
   * Reopens a modeling feature in its creation form, or (U09) re-arms the
   * in-place command that made it.
   */
  onEditModelingFeature?(feature: FeatureNode): void;
  /** The feature an in-place command is editing now, if any. */
  inPlaceEditFeatureId?: FeatureId | null;
  onApplyTransform(feature: FeatureNode, value: TransformFormValue): void;
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
  /**
   * On-demand recognition of the selected imported STEP face (Phase D of the
   * imported STEP edit plan). The Inspector (already a lazy chunk) owns the
   * worker query effect, so nothing about recognition joins the entry chunk:
   * the host passes the document, the face query, the caller-owned cache,
   * and a bound worker call, and the panel queries lazily while it shows a
   * selected imported face. Absent in tests, where the panel falls back to
   * today's geometry-only display or to the explicit `recognition` override
   * below.
   */
  recognitionDocument?: ProjectDocument | null;
  recognitionQuery?: ImportedFaceRecognitionQuery | null;
  recognitionCache?: Map<string, FaceRecognitionSummary>;
  recognitionWorker?: {
    recognizeImportedFace: (
      input: RecognizeImportedFaceInput
    ) => Promise<FaceRecognitionSummary>;
  };
  /** The live document and worker used only when mass details are opened. */
  massPropertiesDocument?: ProjectDocument | null;
  massPropertiesWorker?: {
    massProperties: (
      document: ProjectDocument,
      bodyId: BodyId,
      options?: { signal?: AbortSignal }
    ) => Promise<MassPropertiesRead>;
  };
  /**
   * Explicit recognition outcome, for tests only. When present (even null)
   * the panel renders it directly and never queries; when absent the panel
   * queries through the props above.
   */
  recognition?: FaceRecognitionSummary | null;
  /** True while the recognition query is in flight. */
  recognitionPending?: boolean;
  /** Transport failure of the recognition query, if it errored. */
  recognitionError?: string | null;
  /** Include/exclude one declared solid of an imported-step feature. */
  onToggleImportedSolid(featureId: FeatureId, solidIndex: number): void;
}

interface InspectorProps extends InspectorCallbacks {
  tool: ToolId | null;
  selectedFeature: FeatureNode | null;
  documentVersion?: number;
  onValidateSelection?(): boolean;
  /** Sketch node backing the selected sketch feature, when applicable. */
  selectedSketch: SketchNode | null;
  selectedSketchObject: SketchObjectData | null;
  selectedBody: BodyRepresentation | null;
  selectedTopology: TopologySelection | null;
  selectedEdges: TopologySelection[];
  /**
   * The committed body projections, so a split's History card can read out
   * its second half as well as the body it names.
   */
  bodyRepresentations?: Readonly<Record<string, BodyRepresentation>>;
  scope: Record<string, number>;
  bodies: BodyOption[];
  units: UnitSystem;
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
  /**
   * Whether a direct viewport pick (a face, an edge or a body, with no tool
   * and no History row behind it) gets a card. Off by default: the pick is
   * answered on the model and in the Selection card, and the details open
   * from History. An imported face's Edit face verb turns it on, because
   * its hole and blend edits have no History step to open them from.
   */
  directPickDetails?: boolean;
}

/**
 * Whether the History form can edit this sketch: its whole geometry is one
 * closed parametric shape (rectangle, circle or polygon object).
 */
function editsAsOneClosedShape(
  sketch: SketchNode,
  object: SketchObjectData | null
): boolean {
  return (
    sketch.objectIds.length === 1 &&
    // I01: the form builds a fresh object on Apply, which would drop a
    // projection's link to its edge; projected geometry is edited in the
    // sketch, where Unlink and Re-pick are.
    !object?.projection &&
    (object?.objectKind === 'rectangle' ||
      object?.objectKind === 'circle' ||
      object?.objectKind === 'polygon')
  );
}

/** A canonical sketch the History form cannot edit as one shape. */
function SketchGeometrySummary({ sketch }: { sketch: SketchNode }) {
  const count = sketch.objectIds.length;
  return (
    <div className="sketch-attachment">
      <div className="kv-grid">
        <b>geometry</b>
        <span>
          {count} object{count === 1 ? '' : 's'}
        </span>
      </div>
      <p className="muted">
        Geometry for this sketch is edited in viewport sketch mode.
      </p>
    </div>
  );
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
    sketch.planeRef.type === 'datum'
      ? 'Datum plane'
      : sketch.planeRef.type === 'frame'
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

/**
 * What the picked face or edge measures. The panel used to answer a face
 * pick with the body's volume and face count, and left the face's own area
 * to the chip at the bottom of the viewport.
 */
function TopologyMeasurements({
  body,
  selection,
  units
}: {
  body: BodyRepresentation | undefined;
  selection: TopologySelection;
  units: UnitSystem;
}) {
  const rows: [string, string][] = [];
  if (selection.kind === 'edge') {
    const length = edgeLength(body, selection.hash, selection.topologyId);
    if (length !== null) {
      rows.push([
        'length',
        `${formatNumber(length)} ${unitLabel('length', units)}`
      ]);
    }
  } else if (selection.kind === 'face') {
    const face = body?.topology?.faces.find(
      (candidate) =>
        (selection.topologyId !== undefined &&
          candidate.topologyId === selection.topologyId) ||
        (selection.hash !== undefined && candidate.hash === selection.hash)
    );
    const geometry = face?.geometry;
    if (geometry) {
      rows.push([
        'area',
        `${formatMeasuredQuantity(geometry.area)} ${unitLabel('area', units)}`
      ]);
      rows.push(['surface', geometry.surfaceType]);
      if (geometry.diameter !== undefined) {
        rows.push([
          'diameter',
          `${formatNumber(geometry.diameter)} ${unitLabel('length', units)}`
        ]);
      }
      if (geometry.normal) {
        rows.push([
          'normal',
          `${formatNumber(geometry.normal.x)}, ${formatNumber(geometry.normal.y)}, ${formatNumber(geometry.normal.z)}`
        ]);
      }
    }
  }
  if (rows.length === 0) return null;
  return (
    <div className="kv-grid topology-measurements">
      {rows.map(([key, value]) => (
        <Fragment key={key}>
          <b>{key}</b>
          <span>{value}</span>
        </Fragment>
      ))}
    </div>
  );
}

export function BodyStats({
  body,
  units,
  document,
  worker,
  lastApplied = false
}: {
  body: BodyRepresentation;
  units: UnitSystem;
  document?: ProjectDocument | null;
  worker?: InspectorProps['massPropertiesWorker'];
  /** A form's draft is not the geometry these properties measure. */
  lastApplied?: boolean;
}) {
  const projectId = document?.projectId ?? null;
  const [massOpen, setMassOpen] = useState(false);
  const [query, setQuery] = useState<{
    document: ProjectDocument | null | undefined;
    body: BodyRepresentation;
    status: 'pending' | 'ready' | 'unavailable' | 'error';
    properties?: BodyMassProperties;
    message?: string;
  } | null>(null);
  const [densitySelection, setDensitySelection] =
    useState<MassDensitySelection>(() =>
      projectId
        ? loadMassDensitySelection(projectId)
        : UNIT_MASS_DENSITY_SELECTION
    );
  const [customDraft, setCustomDraft] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  // A different project brings its own remembered material; a panel without a
  // document (committed properties in tests) stays session-local.
  useEffect(() => {
    setDensitySelection(
      projectId
        ? loadMassDensitySelection(projectId)
        : UNIT_MASS_DENSITY_SELECTION
    );
    setCustomDraft('');
    setCustomError(null);
  }, [projectId]);
  const workerRef = useRef(worker);
  workerRef.current = worker;
  useEffect(() => {
    if (!massOpen || body.massProperties) return;
    let active = true;
    const controller = new AbortController();
    if (!document || !workerRef.current) {
      setQuery({
        document,
        body,
        status: 'unavailable',
        message: 'Mass properties are unavailable for this document.'
      });
      return;
    }
    setQuery({ document, body, status: 'pending' });
    void workerRef.current
      .massProperties(document, body.bodyId, { signal: controller.signal })
      .then((result) => {
        if (!active) return;
        setQuery(
          result.status === 'ready'
            ? {
                document,
                body,
                status: 'ready',
                properties: result.properties
              }
            : {
                document,
                body,
                status: 'unavailable',
                message: result.reason
              }
        );
      })
      .catch((error: unknown) => {
        if (!active) return;
        setQuery({
          document,
          body,
          status: 'error',
          message:
            error instanceof Error ? error.message : 'Mass measurement failed.'
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [massOpen, document, body]);
  const size = {
    x: body.bbox.max.x - body.bbox.min.x,
    y: body.bbox.max.y - body.bbox.min.y,
    z: body.bbox.max.z - body.bbox.min.z
  };
  const currentQuery =
    query?.document === document && query?.body === body ? query : null;
  const mass =
    body.massProperties ??
    (currentQuery?.status === 'ready' ? currentQuery.properties : undefined);
  const densityKgPerM3 = resolveDensityKgPerM3(densitySelection);
  // Physical mass comes from the published exact volume, not from the
  // kernel's own volume field, which the shared type deliberately withholds
  // as the less accurate of the two.
  const massKgValue =
    densityKgPerM3 === null ? null : massKg(body.volume, units, densityKgPerM3);
  const massUnit =
    massKgValue === null ? null : displayMassUnit(massKgValue, units);
  const inertiaUnit =
    massUnit === null ? null : displayInertiaUnit(massUnit, units);
  /** One kernel component in display units; only called with a material set. */
  function scaledInertia(value: number): number {
    return convertInertia(
      inertiaSiKgM2(value, units, densityKgPerM3!),
      massUnit!,
      units
    );
  }
  /** The symmetric tensor as three model-axis rows. */
  function inertiaRows(
    values: readonly [number, number, number, number, number, number]
  ): Array<[number, number, number]> {
    const [iXX, iYY, iZZ, iXY, iXZ, iYZ] = values;
    return [
      [iXX, iXY, iXZ],
      [iXY, iYY, iYZ],
      [iXZ, iYZ, iZZ]
    ];
  }
  function applyDensitySelection(next: MassDensitySelection): void {
    const normalized = normalizeMassDensitySelection(next);
    setDensitySelection(normalized);
    if (projectId) {
      saveMassDensitySelection(projectId, normalized);
    }
    if (normalized.kind === 'custom') {
      setCustomDraft(String(normalized.densityKgPerM3));
      setCustomError(null);
    }
  }
  const densityControlValue =
    densitySelection.kind === 'unit'
      ? 'unit'
      : densitySelection.kind === 'preset'
        ? `preset:${densitySelection.presetId}`
        : 'custom';
  function onDensityControlChange(value: string): void {
    if (value === 'unit') {
      applyDensitySelection({ kind: 'unit' });
      return;
    }
    if (value === 'custom') {
      const parsed = parseCustomDensityKgPerM3(Number(customDraft));
      applyDensitySelection({
        kind: 'custom',
        densityKgPerM3: parsed ?? 1000
      });
      return;
    }
    if (value.startsWith('preset:')) {
      applyDensitySelection({
        kind: 'preset',
        presetId: value.slice('preset:'.length)
      });
    }
  }
  function onCustomDraftChange(text: string): void {
    setCustomDraft(text);
    if (text.trim() === '') {
      // Clearing the field is editing, not a zero density: keep the last
      // valid material until a new number parses.
      setCustomError(null);
      return;
    }
    const parsed = parseCustomDensityKgPerM3(Number(text));
    if (parsed === null) {
      setCustomError(
        `Enter a positive density in kg/m³ (at most ${MAX_CUSTOM_DENSITY_KG_PER_M3.toLocaleString('en-US')}).`
      );
      return;
    }
    setCustomError(null);
    applyDensitySelection({ kind: 'custom', densityKgPerM3: parsed });
  }
  return (
    <>
      <CollapsibleSection
        title={lastApplied ? 'Measurements (last applied)' : 'Measurements'}
        defaultOpen
      >
        <div className="kv-grid">
          <b>volume</b>
          <span>
            {formatMeasuredQuantity(body.volume)} {unitLabel('volume', units)}
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
            {body.consumed
              ? 'combined into a later feature'
              : lastApplied
                ? 'last applied model'
                : 'live'}
          </span>
        </div>
      </CollapsibleSection>
      <CollapsibleSection
        title={
          densityKgPerM3 === null
            ? 'Mass properties (at unit density)'
            : `Mass properties (${describeMassDensitySelection(densitySelection)})`
        }
        onToggle={setMassOpen}
      >
        <div className="kv-grid">
          <b>material</b>
          <span>
            <select
              aria-label="Material density"
              value={densityControlValue}
              onChange={(event) => onDensityControlChange(event.target.value)}
            >
              <option value="unit">Unit density</option>
              {MATERIAL_DENSITY_PRESETS.map((preset) => (
                <option key={preset.id} value={`preset:${preset.id}`}>
                  {preset.label} · {preset.densityKgPerM3} kg/m³
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
          </span>
          {densitySelection.kind === 'custom' && (
            <>
              <b>custom density</b>
              <span>
                <input
                  aria-label="Custom density in kilograms per cubic metre"
                  inputMode="decimal"
                  value={customDraft}
                  onChange={(event) => onCustomDraftChange(event.target.value)}
                />{' '}
                kg/m³
              </span>
            </>
          )}
        </div>
        {customError && (
          <p className="form-error" role="alert">
            {customError}
          </p>
        )}
        {mass ? (
          <div className="kv-grid">
            {massKgValue !== null && massUnit !== null && (
              <>
                <b>mass</b>
                <span>
                  {formatNumber(convertMass(massKgValue, massUnit))} {massUnit}
                </span>
              </>
            )}
            <b>center of mass</b>
            <span>
              {formatNumber(mass.centerOfMass.x)},{' '}
              {formatNumber(mass.centerOfMass.y)},{' '}
              {formatNumber(mass.centerOfMass.z)} {unitLabel('length', units)}
            </span>
            <b>principal inertia</b>
            <span className="kv-multiline">
              {densityKgPerM3 === null || inertiaUnit === null ? (
                <>
                  {formatNumber(mass.principalMoments[0])} ·{' '}
                  {formatNumber(mass.principalMoments[1])} ·{' '}
                  {formatNumber(mass.principalMoments[2])}{' '}
                  {unitLabel('length', units)}⁵
                </>
              ) : (
                <>
                  {formatNumber(scaledInertia(mass.principalMoments[0]))} ·{' '}
                  {formatNumber(scaledInertia(mass.principalMoments[1]))} ·{' '}
                  {formatNumber(scaledInertia(mass.principalMoments[2]))}{' '}
                  {inertiaUnit}
                </>
              )}
            </span>
            <b>inertia tensor</b>
            <span
              className="kv-multiline"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {inertiaRows(mass.inertia).map((row, index, rows) => (
                <span key={index} style={{ display: 'block' }}>
                  {formatNumber(
                    densityKgPerM3 === null || inertiaUnit === null
                      ? row[0]
                      : scaledInertia(row[0])
                  )}{' '}
                  {formatNumber(
                    densityKgPerM3 === null || inertiaUnit === null
                      ? row[1]
                      : scaledInertia(row[1])
                  )}{' '}
                  {formatNumber(
                    densityKgPerM3 === null || inertiaUnit === null
                      ? row[2]
                      : scaledInertia(row[2])
                  )}
                  {index === rows.length - 1
                    ? ` ${densityKgPerM3 === null || inertiaUnit === null ? `${unitLabel('length', units)}⁵` : inertiaUnit}`
                    : null}
                </span>
              ))}
            </span>
            <b>principal axes</b>
            <span
              className="kv-multiline"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {mass.principalAxes.map((axis, index) => (
                <span key={index} style={{ display: 'block' }}>
                  {`${index + 1} · (${formatNumber(axis.x)}, ${formatNumber(axis.y)}, ${formatNumber(axis.z)})`}
                </span>
              ))}
            </span>
          </div>
        ) : (
          <p role="status" aria-live="polite">
            {currentQuery?.status === 'pending'
              ? 'Measuring mass properties…'
              : currentQuery?.status === 'error'
                ? `Mass measurement failed: ${currentQuery.message}`
                : currentQuery?.status === 'unavailable'
                  ? currentQuery.message
                  : 'Open this section to measure mass properties.'}
          </p>
        )}
        {mass && (densityKgPerM3 === null || inertiaUnit === null) ? (
          // Prose under the grid, not in a value cell, where it was cut off
          // after the third moment.
          <p className="muted">
            Inertia is at unit density: multiply it by the material density for
            physical values.
          </p>
        ) : null}
        <p className="muted">
          {densityKgPerM3 === null
            ? 'Kernel-integrated over face geometry — no tessellation. Trim outlines on curved faces are sampled.'
            : `${describeMassDensitySelection(densitySelection)} · kernel-integrated over face geometry — no tessellation. Trim outlines on curved faces are sampled.`}
        </p>
      </CollapsibleSection>
    </>
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
  onToggle,
  children
}: {
  title: string;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <details
      className="panel-section"
      open={defaultOpen}
      onToggle={(event) => onToggle?.(event.currentTarget.open)}
    >
      <summary className="section-title">{title}</summary>
      {children}
    </details>
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

const RECOGNIZED_FEATURE_LABELS: Record<string, string> = {
  'blind-cylindrical-hole': 'Blind hole',
  counterbore: 'Counterbore',
  countersink: 'Countersink',
  'cylindrical-boss': 'Boss',
  'prismatic-pocket': 'Pocket',
  'conical-taper': 'Taper'
};

const RECOGNIZED_DIMENSION_LABELS: Record<string, string> = {
  diameter: 'diameter',
  depth: 'depth',
  outerDiameter: 'outer diameter',
  innerDiameter: 'inner diameter',
  counterboreDepth: 'counterbore depth',
  totalDepth: 'total depth',
  openingDiameter: 'opening diameter',
  holeDiameter: 'hole diameter',
  angleRadians: 'included angle',
  countersinkDepth: 'countersink depth',
  height: 'height',
  referenceRadius: 'reference radius',
  oppositeRadius: 'end radius',
  length: 'length'
};

function formatRecognitionDimension(
  key: string,
  value: number,
  units: UnitSystem
): string {
  if (key === 'angleRadians') {
    return `${formatNumber((value * 180) / Math.PI)}°`;
  }
  return `${formatNumber(value)} ${unitLabel('length', units)}`;
}

/**
 * A stored direct-edit length as a reader writes it: rounded, in the
 * document's unit, with its expression when it has one. `String()` printed
 * raw floats with no unit at all.
 */
function formatStoredLength(
  value: ParamValue,
  scope: Record<string, number>,
  units: UnitSystem
): string {
  const resolved = evalParamValue(value, scope);
  const shown =
    resolved === null
      ? '—'
      : `${formatNumber(resolved)} ${unitLabel('length', units)}`;
  return typeof value === 'string' && !Number.isFinite(Number(value))
    ? `${value} = ${shown}`
    : shown;
}

/** A stored angle in radians, shown in degrees as the recognition panel does. */
function formatStoredAngle(
  radians: ParamValue,
  scope: Record<string, number>
): string {
  const resolved = evalParamValue(radians, scope);
  return resolved === null
    ? String(radians)
    : `${formatNumber((resolved * 180) / Math.PI)}°`;
}

/**
 * On-demand recognition of the selected imported STEP face (Phase D of the
 * imported STEP edit plan). Display-only: recognized kind + dimensions, or
 * the typed refusal reason when the proof declines. The through-hole
 * diameter form above stays the sole edit committed through recognition;
 * every other recognized kind renders its dimensions read-only with no
 * commit path.
 */
function ImportedFaceRecognition({
  recognition,
  pending,
  error,
  units
}: {
  recognition?: FaceRecognitionSummary | null;
  pending?: boolean;
  error?: string | null;
  units: UnitSystem;
}) {
  if (pending) {
    return <p className="muted direct-edit-note">Recognizing feature…</p>;
  }
  if (error) {
    return (
      <p className="muted direct-edit-note">
        Feature recognition is unavailable: {error}
      </p>
    );
  }
  if (!recognition) {
    return null;
  }
  if (recognition.kind === 'recognized') {
    const label =
      (recognition.featureKind !== undefined
        ? RECOGNIZED_FEATURE_LABELS[recognition.featureKind]
        : undefined) ?? 'Recognized feature';
    const dimensions = Object.entries(recognition.dimensions ?? {});
    // Proof families other than the shipped through-hole/blend edits are
    // read-only: the recognizer publishes their shape but no coordinated
    // direct-edit replays them. Say so beside the dimensions, or a measured
    // boss reads as an editable one with its edit button missing.
    const readOnlyNote =
      recognition.featureKind !== undefined &&
      ![
        'blind-cylindrical-hole',
        'counterbore',
        'countersink',
        'fillet-band'
      ].includes(recognition.featureKind)
        ? 'Recognized — read-only: no direct edit replays this family yet.'
        : null;
    return (
      <>
        <div className="kv-grid">
          <b>recognized</b>
          <span>{label}</span>
          {dimensions.map(([key, value]) => (
            <Fragment key={key}>
              <b>{RECOGNIZED_DIMENSION_LABELS[key] ?? key}</b>
              <span>{formatRecognitionDimension(key, value, units)}</span>
            </Fragment>
          ))}
        </div>
        {readOnlyNote ? (
          // A sentence, so it wraps under the grid; a value cell cut it off.
          <p className="muted direct-edit-note">{readOnlyNote}</p>
        ) : null}
      </>
    );
  }
  return (
    <p className="muted direct-edit-note">
      {recognition.refusalReason !== undefined
        ? `Not a recognized feature (${recognition.refusalReason}): ${recognition.message}`
        : recognition.message}
    </p>
  );
}

function FaceDirectEdit({
  body,
  selection,
  scope,
  units,
  onResizeThroughHole,
  onRemoveFaceFeature,
  recognition,
  recognitionPending,
  recognitionError,
  recognitionDocument,
  recognitionQuery,
  recognitionCache,
  recognitionWorker
}: {
  body: BodyRepresentation;
  selection: TopologySelection;
  scope: Record<string, number>;
  units: UnitSystem;
  onResizeThroughHole: InspectorCallbacks['onResizeThroughHole'];
  onRemoveFaceFeature: InspectorCallbacks['onRemoveFaceFeature'];
  recognition?: FaceRecognitionSummary | null;
  recognitionPending?: boolean;
  recognitionError?: string | null;
  recognitionDocument?: ProjectDocument | null;
  recognitionQuery?: ImportedFaceRecognitionQuery | null;
  recognitionCache?: Map<string, FaceRecognitionSummary>;
  recognitionWorker?: {
    recognizeImportedFace: (
      input: RecognizeImportedFaceInput
    ) => Promise<FaceRecognitionSummary>;
  };
}) {
  // On-demand per-face recognition (Phase D): the query effect lives here in
  // the lazy Inspector chunk, firing only while this panel shows a selected
  // imported face. An explicit `recognition` prop (tests) renders directly
  // and never queries.
  const hasRecognitionOverride = recognition !== undefined;
  const liveRecognition = useImportedFaceRecognition(
    hasRecognitionOverride ? null : (recognitionWorker ?? null),
    hasRecognitionOverride ? null : (recognitionDocument ?? null),
    hasRecognitionOverride ? null : (recognitionQuery ?? null),
    hasRecognitionOverride ? null : recognitionCache
  );
  const shownRecognition = hasRecognitionOverride
    ? recognition
    : liveRecognition.summary;
  const shownPending = hasRecognitionOverride
    ? (recognitionPending ?? false)
    : liveRecognition.pending;
  const shownError = hasRecognitionOverride
    ? (recognitionError ?? null)
    : liveRecognition.error;
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
          {formatMeasuredQuantity(geometry.area)} {unitLabel('area', units)}
        </span>
        {geometry.axialLength !== undefined && (
          <>
            <b>length</b>
            <span>
              {formatNumber(geometry.axialLength)} {unitLabel('length', units)}
            </span>
          </>
        )}
        {geometry.featureType === 'blend' &&
          geometry.blendRadius !== undefined && (
            <>
              <b>fillet radius</b>
              <span>
                R {formatNumber(geometry.blendRadius)}{' '}
                {unitLabel('length', units)}
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
              label={`Diameter (${unitLabel('length', units)})`}
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
      <ImportedFaceRecognition
        recognition={shownRecognition}
        pending={shownPending}
        error={shownError}
        units={units}
      />
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
    scope,
    bodies,
    units,
    commandSession,
    featureSelectionSource
  } = props;
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
  }, [editPanelKey, featureSelectionSource]);

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
    eyebrow = CARD_EYEBROWS.create;
    title = TOOL_META[tool].label;
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
      directEdit: selectedFeature.featureKind === 'direct-edit',
      ...(selectionLabel ? { selectionLabel } : {}),
      ...(selectedBody ? { selectionBodyName: selectedBody.name } : {}),
      featureSelectionSource,
      commandSession
    });
    objectReadout = heading.demoted;
    eyebrow = heading.eyebrow;
    title = heading.title;
    const editKey = `edit-${selectedFeature.id}-${props.documentVersion ?? 0}`;
    const data = selectedFeature.data;
    let form: ReactNode = null;

    if (data.featureKind === 'primitive') {
      const placement = primitivePlacement(props.document, selectedFeature);
      form = (
        <PrimitiveForm
          key={editKey}
          kind={data.primitiveKind}
          scope={scope}
          documentUnits={units}
          initialName={selectedFeature.name}
          initialDimensions={data.dimensions}
          initialPosition={placement.position}
          submitLabel="Apply"
          onSubmit={(name, dimensions, position) =>
            props.onApplyPrimitive(
              selectedFeature,
              name,
              applyPrimitiveCommand(
                props.document,
                selectedFeature,
                name,
                dimensions,
                position
              )
            )
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
            units={units}
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
      selectedSketch.planeRef.type === 'canonical' &&
      !editsAsOneClosedShape(selectedSketch, selectedSketchObject)
    ) {
      // The closed-shape form edits one object: on a sketch of lines (a
      // rectangle or polygon drawn as held sides), or of several shapes,
      // Apply would replace its first object and orphan the rest.
      form = <SketchGeometrySummary sketch={selectedSketch} />;
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
          units={units}
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
    } else if (data.featureKind === 'transform') {
      form = (
        <TransformForm
          key={editKey}
          scope={scope}
          bodies={bodies}
          units={units}
          initial={{
            name: selectedFeature.name,
            targetBodyId: data.targetBodyId,
            translation: data.transform.translation,
            rotationDeg: data.transform.rotationDeg,
            ...(data.transform.scale !== undefined
              ? { scale: data.transform.scale }
              : {}),
            ...(data.transform.pivot !== undefined
              ? { pivot: data.transform.pivot }
              : {}),
            ...(data.copy ? { copy: true } : {}),
            ...(data.axisRotation ? { axisRotation: data.axisRotation } : {})
          }}
          datumAxes={datumAxisChoices(
            props.document,
            selectedFeature.featureId
          )}
          submitLabel="Apply"
          onSubmit={(value) => props.onApplyTransform(selectedFeature, value)}
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
              <span>
                {formatStoredLength(data.operation.distance, scope, units)}
              </span>
              <b>move mode</b>
              <span>{data.operation.moveMode.replaceAll('-', ' ')}</span>
            </>
          )}
          {data.operation.kind === 'resize-through-hole' && (
            <>
              <b>diameter</b>
              <span>
                {formatStoredLength(data.operation.diameter, scope, units)}
              </span>
            </>
          )}
          {data.operation.kind === 'resize-imported-blind-hole' && (
            <>
              <b>diameter</b>
              <span>
                {formatStoredLength(data.operation.diameter, scope, units)}
              </span>
              <b>depth</b>
              <span>
                {formatStoredLength(data.operation.depth, scope, units)}
              </span>
            </>
          )}
          {data.operation.kind === 'resize-imported-counterbore' && (
            <>
              <b>bore diameter</b>
              <span>
                {formatStoredLength(data.operation.boreDiameter, scope, units)}
              </span>
              <b>counterbore diameter</b>
              <span>
                {formatStoredLength(
                  data.operation.counterboreDiameter,
                  scope,
                  units
                )}
              </span>
              <b>counterbore depth</b>
              <span>
                {formatStoredLength(
                  data.operation.counterboreDepth,
                  scope,
                  units
                )}
              </span>
            </>
          )}
          {data.operation.kind === 'resize-imported-countersink' && (
            <>
              <b>bore diameter</b>
              <span>
                {formatStoredLength(data.operation.boreDiameter, scope, units)}
              </span>
              <b>sink diameter</b>
              <span>
                {formatStoredLength(data.operation.sinkDiameter, scope, units)}
              </span>
              <b>included angle</b>
              <span>
                {formatStoredAngle(data.operation.angleRadians, scope)}
              </span>
            </>
          )}
          {data.operation.kind === 'resize-cylindrical-face' && (
            <>
              <b>radius</b>
              <span>
                {formatStoredLength(data.operation.radius, scope, units)}
              </span>
            </>
          )}
          {data.operation.kind === 'resize-blend' && (
            <>
              <b>radius</b>
              <span>
                {formatStoredLength(data.operation.newRadius, scope, units)}
              </span>
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

    // U09 phase 7: a feature an in-place command made is edited by that
    // command, on the model, never by a form here; the panel keeps its
    // readout. Its Edit button re-arms the command if it was not armed.
    // An extrude too: History re-arms the in-place Extrude on it.
    const inPlaceTool =
      inPlaceToolForFeature(data) ??
      (data.featureKind === 'extrude' ? ('extrude' as const) : null);
    if (inPlaceTool) form = null;
    const editingInPlace =
      inPlaceTool !== null &&
      props.inPlaceEditFeatureId === selectedFeature.featureId;
    // As the first half is: from the document on screen, so an edit's
    // preview (a moved split plane) shows both halves as they will be.
    const splitHalf =
      data.featureKind === 'split'
        ? (props.massPropertiesDocument?.derived.bodyRepresentations[
            data.secondBodyId
          ] ?? props.bodyRepresentations?.[data.secondBodyId])
        : undefined;
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
        {data.featureKind === 'sketch' &&
          selectedSketch &&
          selectedSketchObject?.objectKind !== 'text' && (
            <button
              type="button"
              className="secondary feature-edit-launch"
              onClick={() => props.onEditSketchInViewport(selectedFeature)}
            >
              Edit sketch in viewport
            </button>
          )}
        {/* Selecting a modeling feature opens its form directly (F19), so
            this only shows when that was refused — exact geometry still
            loading, say — and is the way to retry once it is ready. */}
        {inPlaceTool
          ? !editingInPlace &&
            props.onEditModelingFeature && (
              <button
                type="button"
                className="secondary feature-edit-launch"
                onClick={() => props.onEditModelingFeature?.(selectedFeature)}
              >
                Edit {TOOL_META[inPlaceTool].label.toLowerCase()}
              </button>
            )
          : (data.featureKind === 'datum-plane' ||
              data.featureKind === 'datum-axis') &&
            props.onEditModelingFeature && (
              <button
                type="button"
                className="secondary feature-edit-launch"
                onClick={() => props.onEditModelingFeature?.(selectedFeature)}
              >
                Edit {TOOL_META[data.featureKind].label.toLowerCase()}
              </button>
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
              recognition={props.recognition}
              recognitionPending={props.recognitionPending}
              recognitionError={props.recognitionError}
              recognitionDocument={props.recognitionDocument}
              recognitionQuery={props.recognitionQuery}
              recognitionCache={props.recognitionCache}
              recognitionWorker={props.recognitionWorker}
            />
          )}
        {selectedBody && (
          <>
            {splitHalf && (
              <h3 className="section-title">{selectedBody.name}</h3>
            )}
            <BodyStats
              body={selectedBody}
              units={units}
              document={props.massPropertiesDocument}
              worker={props.massPropertiesWorker}
              lastApplied={Boolean(form) || editingInPlace}
            />
          </>
        )}
        {/* A split leaves two halves, and its row is where both are read. */}
        {selectedBody && splitHalf && (
          <>
            <h3 className="section-title">{splitHalf.name}</h3>
            <BodyStats
              body={splitHalf}
              units={units}
              document={props.massPropertiesDocument}
              worker={props.massPropertiesWorker}
              lastApplied={Boolean(form) || editingInPlace}
            />
          </>
        )}
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
            <TopologyMeasurements
              body={selectedBody ?? undefined}
              selection={selectedTopology}
              units={units}
            />
          </div>
        )}
      </>
    );
    body = objectReadout ? (
      <>
        {selectedTopology && selectedTopology.kind !== 'body' ? (
          // The heading names the face or edge; this is what it measures.
          <TopologyMeasurements
            body={selectedBody ?? undefined}
            selection={selectedTopology}
            units={units}
          />
        ) : null}
        {/* Opened by the Selection card's Edit face: the imported face's own
            edits are what was asked for, not just its provenance. */}
        {props.directPickDetails &&
          !commandSession &&
          selectedTopology?.kind === 'face' &&
          selectedBody?.source === 'imported-step' && (
            <FaceDirectEdit
              key={`${selectedBody.bodyId}:${selectedTopology.hash ?? selectedTopology.topologyId}`}
              body={selectedBody}
              selection={selectedTopology}
              scope={scope}
              units={units}
              onResizeThroughHole={props.onResizeThroughHole}
              onRemoveFaceFeature={props.onRemoveFaceFeature}
              recognition={props.recognition}
              recognitionPending={props.recognitionPending}
              recognitionError={props.recognitionError}
              recognitionDocument={props.recognitionDocument}
              recognitionQuery={props.recognitionQuery}
              recognitionCache={props.recognitionCache}
              recognitionWorker={props.recognitionWorker}
            />
          )}
        {selectedBody && (
          <BodyStats
            body={selectedBody}
            units={units}
            document={props.massPropertiesDocument}
            worker={props.massPropertiesWorker}
            lastApplied={editingInPlace}
          />
        )}
        <div className="object-definition-row">
          <span>
            <b>Defined by</b> {selectedFeature.name}
          </span>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              if (props.onValidateSelection?.() !== false)
                props.onPinFeature(selectedFeature);
            }}
          >
            Edit
          </button>
        </div>
      </>
    ) : (
      featurePanel
    );
    if (!objectReadout) {
      deleteAction = {
        label:
          selectedFeature.data.featureKind === 'imported-step'
            ? 'Delete imported body'
            : 'Delete feature',
        run: () => {
          if (props.onValidateSelection?.() !== false)
            props.onDeleteFeature(selectedFeature);
        }
      };
    }
  }

  let directPick = objectReadout;
  if (!body && selectedTopology && selectedBody) {
    directPick = true;
    eyebrow = selectedBody.name;
    title =
      selectedTopology.kind === 'face'
        ? faceLabel(
            selectedBody,
            selectedTopology.hash,
            selectedTopology.topologyId
          )
        : selectedTopology.kind === 'edge'
          ? edgeLabel(
              selectedBody,
              selectedTopology.hash,
              selectedTopology.topologyId
            )
          : 'Body';
    // Information, not an error: the geometry is inspectable here, and its
    // shape belongs to whichever history feature made it.
    const selectionNoun =
      selectedTopology.kind === 'face'
        ? 'face'
        : selectedTopology.kind === 'edge'
          ? 'edge'
          : 'body';
    body = (
      <>
        <p>
          {selectedTopology.kind === 'face'
            ? 'Selected face. Drag an available face handle to adjust its shape, or edit the feature that made it in History.'
            : `Selected ${selectionNoun}. To change its shape, edit the feature that made it in History.`}
        </p>
        {!commandSession &&
          selectedTopology.kind === 'face' &&
          selectedBody.source === 'imported-step' && (
            <FaceDirectEdit
              body={selectedBody}
              selection={selectedTopology}
              scope={scope}
              units={units}
              onResizeThroughHole={props.onResizeThroughHole}
              onRemoveFaceFeature={props.onRemoveFaceFeature}
              recognition={props.recognition}
              recognitionPending={props.recognitionPending}
              recognitionError={props.recognitionError}
              recognitionDocument={props.recognitionDocument}
              recognitionQuery={props.recognitionQuery}
              recognitionCache={props.recognitionCache}
              recognitionWorker={props.recognitionWorker}
            />
          )}
        <BodyStats
          body={selectedBody}
          units={units}
          document={props.massPropertiesDocument}
          worker={props.massPropertiesWorker}
        />
      </>
    );
  }
  if (!body || (directPick && !tool && !props.directPickDetails)) {
    return null;
  }

  return (
    <section
      className={`inspector${objectReadout ? ' object-readout' : ''}`}
      aria-label="Feature inspector"
      onSubmitCapture={(event) => {
        if (!tool && props.onValidateSelection?.() === false) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
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
      <CardHeader
        title={title}
        eyebrow={eyebrow}
        actions={
          deleteAction ? (
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
          ) : null
        }
        closeTitle="Close"
        closeLabel="Close panel"
        onClose={props.onClose ?? props.onCancel}
      />
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
