import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { coerceParamValue } from '@openzcad/document-core';
import {
  FULL_REVOLVE_ANGLE_DEG,
  type AxisId,
  type BodyId,
  type BooleanOperation,
  type ParamValue,
  type PatternKind,
  type PlaneId,
  type PrimitiveKind,
  type RevolveAxis,
  type SketchId,
  type SketchObjectData,
  type SketchObjectKind
} from '@openzcad/shared';
import { ExprInput } from '../ExprInput';
import {
  PLANE_LABELS,
  REVOLVE_AXIS_LABELS,
  paramValueText,
  previewExpression
} from '../../lib/model';

export interface BodyOption {
  bodyId: BodyId;
  name: string;
  consumed: boolean;
}

export interface SketchOption {
  sketchId: SketchId;
  name: string;
}

interface FormShellProps {
  name: string;
  onName(value: string): void;
  submitLabel: string;
  canSubmit: boolean;
  onSubmit(): void;
  onCancel?: () => void;
  children: ReactNode;
}

function FormShell({
  name,
  onName,
  submitLabel,
  canSubmit,
  onSubmit,
  onCancel,
  children
}: FormShellProps) {
  return (
    <form
      className="feature-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) {
          onSubmit();
        }
      }}
      onKeyDown={(event) => {
        // Escape anywhere in the form dismisses it, even from a focused input.
        if (event.key === 'Escape' && onCancel) {
          event.stopPropagation();
          onCancel();
        }
        // Enter submits from any field, including selects.
        if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
          event.preventDefault();
          if (canSubmit) {
            onSubmit();
          }
        }
      }}
    >
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(event) => onName(event.target.value)} />
      </label>
      {children}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!canSubmit} title="Enter">
          {submitLabel}
          <kbd className="kbd-inline">↵</kbd>
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function fieldsValid(scope: Record<string, number>, values: string[]): boolean {
  return values.every((value) => previewExpression(value, scope).ok);
}

// ---------------------------------------------------------------------------
// Primitive
// ---------------------------------------------------------------------------

const PRIMITIVE_FIELDS: Record<
  PrimitiveKind,
  { key: string; label: string; initial: string }[]
> = {
  box: [
    { key: 'width', label: 'Width (X)', initial: '30' },
    { key: 'height', label: 'Height (Y)', initial: '18' },
    { key: 'depth', label: 'Depth (Z)', initial: '24' }
  ],
  cylinder: [
    { key: 'radius', label: 'Radius', initial: '14' },
    { key: 'height', label: 'Height', initial: '28' }
  ],
  sphere: [{ key: 'radius', label: 'Radius', initial: '16' }],
  cone: [
    { key: 'bottomRadius', label: 'Bottom radius', initial: '16' },
    { key: 'topRadius', label: 'Top radius', initial: '6' },
    { key: 'height', label: 'Height', initial: '24' }
  ],
  torus: [
    { key: 'majorRadius', label: 'Ring radius', initial: '24' },
    { key: 'minorRadius', label: 'Tube radius', initial: '6' }
  ]
};

interface PrimitiveFormProps {
  kind: PrimitiveKind;
  scope: Record<string, number>;
  initialName: string;
  initialDimensions?: Record<string, ParamValue>;
  /** Transient direct-manipulation value; never writes document history. */
  liveRadius?: number | null;
  submitLabel: string;
  onSubmit(name: string, dimensions: Record<string, ParamValue>): void;
  onCancel?: () => void;
}

export function PrimitiveForm({
  kind,
  scope,
  initialName,
  initialDimensions,
  liveRadius,
  submitLabel,
  onSubmit,
  onCancel
}: PrimitiveFormProps) {
  const fields = PRIMITIVE_FIELDS[kind];
  const [name, setName] = useState(initialName);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((field) => [
        field.key,
        initialDimensions
          ? paramValueText(initialDimensions[field.key])
          : field.initial
      ])
    )
  );

  const canSubmit =
    name.trim().length > 0 && fieldsValid(scope, Object.values(values));

  useEffect(() => {
    if (kind !== 'cylinder' || liveRadius === undefined || liveRadius === null) {
      return;
    }
    const text = String(Math.round(liveRadius * 1000) / 1000);
    setValues((current) =>
      current.radius === text ? current : { ...current, radius: text }
    );
  }, [kind, liveRadius]);

  return (
    <FormShell
      name={name}
      onName={setName}
      submitLabel={submitLabel}
      canSubmit={canSubmit}
      onSubmit={() =>
        onSubmit(
          name.trim(),
          Object.fromEntries(
            fields.map((field) => [
              field.key,
              coerceParamValue(values[field.key] ?? '')
            ])
          )
        )
      }
      onCancel={onCancel}
    >
      {fields.map((field, index) => (
        <ExprInput
          key={field.key}
          label={field.label}
          value={values[field.key] ?? ''}
          scope={scope}
          autoFocus={index === 0}
          onChange={(value) =>
            setValues((current) => ({ ...current, [field.key]: value }))
          }
        />
      ))}
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// Sketch
// ---------------------------------------------------------------------------

export interface SketchFormValue {
  name: string;
  plane: PlaneId;
  offset: ParamValue;
  object: SketchObjectData;
}

interface SketchFormProps {
  scope: Record<string, number>;
  initial?: SketchFormValue;
  submitLabel: string;
  onSubmit(value: SketchFormValue): void;
  onCancel?: () => void;
}

/** The form only offers closed one-object profiles; open curves (line/arc) are drawn in the viewport sketch mode. */
type ClosedShapeKind = Extract<
  SketchObjectKind,
  'rectangle' | 'circle' | 'polygon'
>;

const SHAPE_LABELS: Record<ClosedShapeKind, string> = {
  rectangle: 'Rectangle',
  circle: 'Circle',
  polygon: 'Polygon'
};

export function SketchForm({
  scope,
  initial,
  submitLabel,
  onSubmit,
  onCancel
}: SketchFormProps) {
  const [name, setName] = useState(initial?.name ?? 'Sketch');
  const [plane, setPlane] = useState<PlaneId>(initial?.plane ?? 'XZ');
  const [offset, setOffset] = useState(paramValueText(initial?.offset ?? 0));
  const initialObject =
    initial &&
    initial.object.objectKind !== 'line' &&
    initial.object.objectKind !== 'arc'
      ? initial.object
      : undefined;
  const [shape, setShape] = useState<ClosedShapeKind>(
    initialObject?.objectKind ?? 'rectangle'
  );
  const [values, setValues] = useState<Record<string, string>>(() => ({
    width:
      initialObject?.objectKind === 'rectangle'
        ? paramValueText(initialObject.width)
        : '32',
    height:
      initialObject?.objectKind === 'rectangle'
        ? paramValueText(initialObject.height)
        : '18',
    radius:
      initialObject && initialObject.objectKind !== 'rectangle'
        ? paramValueText(initialObject.radius)
        : '14',
    sides:
      initialObject?.objectKind === 'polygon'
        ? paramValueText(initialObject.sides)
        : '6',
    centerX: paramValueText(initialObject?.centerX ?? 0),
    centerY: paramValueText(initialObject?.centerY ?? 0)
  }));

  const shapeKeys =
    shape === 'rectangle'
      ? ['width', 'height']
      : shape === 'circle'
        ? ['radius']
        : ['sides', 'radius'];
  const activeKeys = [...shapeKeys, 'centerX', 'centerY'];
  const canSubmit =
    name.trim().length > 0 &&
    fieldsValid(scope, [offset, ...activeKeys.map((key) => values[key] ?? '')]);

  const setValue = (key: string) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  function buildObject(): SketchObjectData {
    const centerX = coerceParamValue(values.centerX ?? '0');
    const centerY = coerceParamValue(values.centerY ?? '0');
    if (shape === 'rectangle') {
      return {
        objectKind: 'rectangle',
        width: coerceParamValue(values.width ?? ''),
        height: coerceParamValue(values.height ?? ''),
        centerX,
        centerY
      };
    }
    if (shape === 'circle') {
      return {
        objectKind: 'circle',
        radius: coerceParamValue(values.radius ?? ''),
        centerX,
        centerY
      };
    }
    return {
      objectKind: 'polygon',
      sides: coerceParamValue(values.sides ?? ''),
      radius: coerceParamValue(values.radius ?? ''),
      centerX,
      centerY
    };
  }

  return (
    <FormShell
      name={name}
      onName={setName}
      submitLabel={submitLabel}
      canSubmit={canSubmit}
      onSubmit={() =>
        onSubmit({
          name: name.trim(),
          plane,
          offset: coerceParamValue(offset.trim() === '' ? '0' : offset),
          object: buildObject()
        })
      }
      onCancel={onCancel}
    >
      <div className="field-pair">
        <label className="field">
          <span>Plane</span>
          <select
            value={plane}
            onChange={(event) => setPlane(event.target.value as PlaneId)}
          >
            {(Object.keys(PLANE_LABELS) as PlaneId[]).map((id) => (
              <option key={id} value={id}>
                {PLANE_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Shape</span>
          <select
            value={shape}
            onChange={(event) =>
              setShape(event.target.value as ClosedShapeKind)
            }
          >
            {(Object.keys(SHAPE_LABELS) as ClosedShapeKind[]).map((id) => (
              <option key={id} value={id}>
                {SHAPE_LABELS[id]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {shape === 'rectangle' && (
        <>
          <ExprInput
            label="Width"
            value={values.width ?? ''}
            scope={scope}
            autoFocus
            onChange={setValue('width')}
          />
          <ExprInput
            label="Height"
            value={values.height ?? ''}
            scope={scope}
            onChange={setValue('height')}
          />
        </>
      )}
      {shape !== 'rectangle' && (
        <ExprInput
          label="Radius"
          value={values.radius ?? ''}
          scope={scope}
          autoFocus
          onChange={setValue('radius')}
        />
      )}
      {shape === 'polygon' && (
        <ExprInput
          label="Sides"
          value={values.sides ?? ''}
          scope={scope}
          onChange={setValue('sides')}
        />
      )}
      <div className="field-pair">
        <ExprInput
          label="Center X"
          value={values.centerX ?? ''}
          scope={scope}
          onChange={setValue('centerX')}
        />
        <ExprInput
          label="Center Y"
          value={values.centerY ?? ''}
          scope={scope}
          onChange={setValue('centerY')}
        />
      </div>
      <ExprInput
        label="Plane offset"
        value={offset}
        scope={scope}
        onChange={setOffset}
      />
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// Extrude / Revolve
// ---------------------------------------------------------------------------

interface SketchPickerProps {
  sketches: SketchOption[];
  value: SketchId | '';
  onChange(value: SketchId): void;
  /** Focus on mount so Enter can confirm immediately. */
  autoFocus?: boolean;
}

function SketchPicker({ sketches, value, onChange, autoFocus }: SketchPickerProps) {
  return (
    <label className="field">
      <span>Sketch</span>
      <select
        value={value}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value as SketchId)}
      >
        {sketches.length === 0 && <option value="">No sketches yet</option>}
        {sketches.map((sketch) => (
          <option key={sketch.sketchId} value={sketch.sketchId}>
            {sketch.name}
          </option>
        ))}
      </select>
    </label>
  );
}

interface ExtrudeFormProps {
  scope: Record<string, number>;
  sketches: SketchOption[];
  initial?: { name: string; sketchId: SketchId; distance: ParamValue };
  /** Pre-selected sketch for new features, e.g. the one picked in the tree. */
  initialSketchId?: SketchId;
  submitLabel: string;
  onSubmit(value: {
    name: string;
    sketchId: SketchId;
    distance: ParamValue;
  }): void;
  onCancel?: () => void;
}

export function ExtrudeForm({
  scope,
  sketches,
  initial,
  initialSketchId,
  submitLabel,
  onSubmit,
  onCancel
}: ExtrudeFormProps) {
  const [name, setName] = useState(initial?.name ?? 'Extrude');
  const [sketchId, setSketchId] = useState<SketchId | ''>(
    initial?.sketchId ?? initialSketchId ?? sketches.at(-1)?.sketchId ?? ''
  );
  const [distance, setDistance] = useState(
    paramValueText(initial?.distance ?? 24)
  );
  const canSubmit =
    name.trim().length > 0 && sketchId !== '' && fieldsValid(scope, [distance]);

  return (
    <FormShell
      name={name}
      onName={setName}
      submitLabel={submitLabel}
      canSubmit={canSubmit}
      onSubmit={() =>
        onSubmit({
          name: name.trim(),
          sketchId: sketchId as SketchId,
          distance: coerceParamValue(distance)
        })
      }
      onCancel={onCancel}
    >
      <SketchPicker
        sketches={sketches}
        value={sketchId}
        onChange={setSketchId}
      />
      <ExprInput
        label="Distance"
        value={distance}
        scope={scope}
        autoFocus
        onChange={setDistance}
      />
      <p className="muted">
        Negative distances extrude below the sketch plane.
      </p>
    </FormShell>
  );
}

interface RevolveFormProps {
  scope: Record<string, number>;
  sketches: SketchOption[];
  initial?: {
    name: string;
    sketchId: SketchId;
    axis: RevolveAxis;
    angleDeg?: ParamValue;
  };
  /** Pre-selected sketch for new features, e.g. the one picked in the tree. */
  initialSketchId?: SketchId;
  submitLabel: string;
  onSubmit(value: {
    name: string;
    sketchId: SketchId;
    axis: RevolveAxis;
    angleDeg: ParamValue;
  }): void;
  onCancel?: () => void;
}

export function RevolveForm({
  scope,
  sketches,
  initial,
  initialSketchId,
  submitLabel,
  onSubmit,
  onCancel
}: RevolveFormProps) {
  const [name, setName] = useState(initial?.name ?? 'Revolve');
  const [sketchId, setSketchId] = useState<SketchId | ''>(
    initial?.sketchId ?? initialSketchId ?? sketches.at(-1)?.sketchId ?? ''
  );
  const [axis, setAxis] = useState<RevolveAxis>(initial?.axis ?? 'vertical');
  const [angleDeg, setAngleDeg] = useState(
    paramValueText(initial?.angleDeg ?? FULL_REVOLVE_ANGLE_DEG)
  );
  const anglePreview = previewExpression(angleDeg, scope);
  const angleInRange =
    anglePreview.ok &&
    anglePreview.value !== undefined &&
    anglePreview.value > 0 &&
    anglePreview.value <= FULL_REVOLVE_ANGLE_DEG;
  const canSubmit =
    name.trim().length > 0 &&
    sketchId !== '' &&
    fieldsValid(scope, [angleDeg]) &&
    angleInRange;
  // Kept in sync with the kernel's own gate: a partial revolve is a
  // hash-only body and none of its edges can be filleted or chamfered.
  const isPartial =
    anglePreview.ok &&
    anglePreview.value !== undefined &&
    anglePreview.value < FULL_REVOLVE_ANGLE_DEG;

  return (
    <FormShell
      name={name}
      onName={setName}
      submitLabel={submitLabel}
      canSubmit={canSubmit}
      onSubmit={() =>
        onSubmit({
          name: name.trim(),
          sketchId: sketchId as SketchId,
          axis,
          angleDeg: coerceParamValue(angleDeg)
        })
      }
      onCancel={onCancel}
    >
      <SketchPicker
        sketches={sketches}
        value={sketchId}
        onChange={setSketchId}
        autoFocus
      />
      <label className="field">
        <span>Revolve around</span>
        <select
          value={axis}
          onChange={(event) => setAxis(event.target.value as RevolveAxis)}
        >
          {(Object.keys(REVOLVE_AXIS_LABELS) as RevolveAxis[]).map((id) => (
            <option key={id} value={id}>
              {REVOLVE_AXIS_LABELS[id]}
            </option>
          ))}
        </select>
      </label>
      <ExprInput
        label="Angle (deg)"
        value={angleDeg}
        scope={scope}
        onChange={setAngleDeg}
      />
      <p className="muted">
        Sweeps the profile through the angle, greater than 0 and up to 360.
        Offset the profile center so it clears the axis.
      </p>
      {isPartial && (
        <p className="muted">
          A partial revolve keeps hash-only face and edge references rather than
          named ones, and its edges cannot be filleted or chamfered. Round the
          full revolve first if the result needs blends.
        </p>
      )}
      {!angleInRange && anglePreview.ok && (
        <p className="muted error">
          Angle must be greater than 0 and at most 360 degrees.
        </p>
      )}
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// Boolean
// ---------------------------------------------------------------------------

const OPERATION_LABELS: Record<BooleanOperation, string> = {
  union: 'Union',
  subtract: 'Subtract',
  intersect: 'Intersect'
};

interface BooleanFormProps {
  bodies: BodyOption[];
  initial?: {
    name: string;
    operation: BooleanOperation;
    targetBodyIds: BodyId[];
  };
  presetOperation?: BooleanOperation;
  /** Bodies already picked in the viewport, in click order. */
  initialSelection?: BodyId[];
  submitLabel: string;
  onSubmit(value: {
    name: string;
    operation: BooleanOperation;
    targetBodyIds: BodyId[];
  }): void;
  onCancel?: () => void;
}

export function BooleanForm({
  bodies,
  initial,
  presetOperation,
  initialSelection,
  submitLabel,
  onSubmit,
  onCancel
}: BooleanFormProps) {
  const [operation, setOperation] = useState<BooleanOperation>(
    initial?.operation ?? presetOperation ?? 'union'
  );
  const [name, setName] = useState(
    initial?.name ?? OPERATION_LABELS[operation]
  );
  // Selection order matters: the first body is the base a subtract cuts from.
  const [selected, setSelected] = useState<BodyId[]>(
    initial?.targetBodyIds ?? initialSelection ?? []
  );

  const selectable = useMemo(
    () =>
      bodies.filter((body) => !body.consumed || selected.includes(body.bodyId)),
    [bodies, selected]
  );

  function toggle(bodyId: BodyId) {
    setSelected((current) =>
      current.includes(bodyId)
        ? current.filter((id) => id !== bodyId)
        : [...current, bodyId]
    );
  }

  const canSubmit = name.trim().length > 0 && selected.length >= 2;

  return (
    <FormShell
      name={name}
      onName={setName}
      submitLabel={submitLabel}
      canSubmit={canSubmit}
      onSubmit={() =>
        onSubmit({ name: name.trim(), operation, targetBodyIds: selected })
      }
      onCancel={onCancel}
    >
      <label className="field">
        <span>Operation</span>
        <select
          value={operation}
          autoFocus
          onChange={(event) =>
            setOperation(event.target.value as BooleanOperation)
          }
        >
          {(Object.keys(OPERATION_LABELS) as BooleanOperation[]).map((id) => (
            <option key={id} value={id}>
              {OPERATION_LABELS[id]}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>Bodies (pick order sets the base)</span>
        <div className="pick-list">
          {selectable.length === 0 && (
            <p className="muted">No bodies available.</p>
          )}
          {selectable.map((body) => {
            const index = selected.indexOf(body.bodyId);
            return (
              <button
                key={body.bodyId}
                type="button"
                className={`pick-row ${index >= 0 ? 'selected' : ''}`}
                onClick={() => toggle(body.bodyId)}
              >
                <span className="pick-order mono">
                  {index >= 0 ? index + 1 : ''}
                </span>
                <span className="body-name">{body.name}</span>
                {index === 0 && operation === 'subtract' && <small>base</small>}
              </button>
            );
          })}
        </div>
      </div>
      {operation === 'subtract' && (
        <p className="muted">Bodies 2+ are subtracted from body 1.</p>
      )}
      {operation === 'union' && (
        <p className="muted">
          Union joins solids that touch or overlap. It does not fill empty gaps.
        </p>
      )}
      <p className="muted">
        Input bodies are consumed; deleting the boolean restores them.
      </p>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

export interface TransformFormValue {
  name: string;
  targetBodyId: BodyId;
  translation: { x: ParamValue; y: ParamValue; z: ParamValue };
  rotationDeg: { x: ParamValue; y: ParamValue; z: ParamValue };
}

interface TransformFormProps {
  scope: Record<string, number>;
  bodies: BodyOption[];
  initial?: TransformFormValue;
  /** Body already picked in the viewport. */
  initialTarget?: BodyId;
  submitLabel: string;
  onSubmit(value: TransformFormValue): void;
  onCancel?: () => void;
}

export function TransformForm({
  scope,
  bodies,
  initial,
  initialTarget,
  submitLabel,
  onSubmit,
  onCancel
}: TransformFormProps) {
  const live = bodies.filter((body) => !body.consumed);
  const [name, setName] = useState(initial?.name ?? 'Move');
  const [target, setTarget] = useState<BodyId | ''>(
    initial?.targetBodyId ?? initialTarget ?? live.at(-1)?.bodyId ?? ''
  );
  const [values, setValues] = useState<Record<string, string>>(() => ({
    tx: paramValueText(initial?.translation.x ?? 0),
    ty: paramValueText(initial?.translation.y ?? 0),
    tz: paramValueText(initial?.translation.z ?? 0),
    rx: paramValueText(initial?.rotationDeg.x ?? 0),
    ry: paramValueText(initial?.rotationDeg.y ?? 0),
    rz: paramValueText(initial?.rotationDeg.z ?? 0)
  }));
  const setValue = (key: string) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  const canSubmit =
    name.trim().length > 0 &&
    target !== '' &&
    fieldsValid(scope, Object.values(values));

  return (
    <FormShell
      name={name}
      onName={setName}
      submitLabel={submitLabel}
      canSubmit={canSubmit}
      onSubmit={() =>
        onSubmit({
          name: name.trim(),
          targetBodyId: target as BodyId,
          translation: {
            x: coerceParamValue(values.tx ?? '0'),
            y: coerceParamValue(values.ty ?? '0'),
            z: coerceParamValue(values.tz ?? '0')
          },
          rotationDeg: {
            x: coerceParamValue(values.rx ?? '0'),
            y: coerceParamValue(values.ry ?? '0'),
            z: coerceParamValue(values.rz ?? '0')
          }
        })
      }
      onCancel={onCancel}
    >
      <label className="field">
        <span>Body</span>
        <select
          value={target}
          onChange={(event) => setTarget(event.target.value as BodyId)}
        >
          {live.length === 0 && <option value="">No bodies yet</option>}
          {live.map((body) => (
            <option key={body.bodyId} value={body.bodyId}>
              {body.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field-triple">
        <ExprInput
          label="Move X"
          value={values.tx ?? ''}
          scope={scope}
          autoFocus
          onChange={setValue('tx')}
        />
        <ExprInput
          label="Move Y"
          value={values.ty ?? ''}
          scope={scope}
          onChange={setValue('ty')}
        />
        <ExprInput
          label="Move Z"
          value={values.tz ?? ''}
          scope={scope}
          onChange={setValue('tz')}
        />
      </div>
      <div className="field-triple">
        <ExprInput
          label="Rotate X°"
          value={values.rx ?? ''}
          scope={scope}
          onChange={setValue('rx')}
        />
        <ExprInput
          label="Rotate Y°"
          value={values.ry ?? ''}
          scope={scope}
          onChange={setValue('ry')}
        />
        <ExprInput
          label="Rotate Z°"
          value={values.rz ?? ''}
          scope={scope}
          onChange={setValue('rz')}
        />
      </div>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// Exact edge modifiers and patterns
// ---------------------------------------------------------------------------

export interface EdgeModifierFormValue {
  name: string;
  targetBodyId: BodyId;
  edgeHashes: number[];
  size: ParamValue;
}

interface EdgeModifierFormProps {
  kind: 'fillet' | 'chamfer';
  scope: Record<string, number>;
  targetBodyId: BodyId | null;
  edgeHashes: number[];
  availableEdgeCount?: number;
  onSelectAllEdges?: () => void;
  onClearEdges?: () => void;
  initial?: { name: string; size: ParamValue };
  submitLabel: string;
  onSubmit(value: EdgeModifierFormValue): void;
  onCancel?: () => void;
}

export function EdgeModifierForm({
  kind,
  scope,
  targetBodyId,
  edgeHashes,
  availableEdgeCount,
  onSelectAllEdges,
  onClearEdges,
  initial,
  submitLabel,
  onSubmit,
  onCancel
}: EdgeModifierFormProps) {
  const [name, setName] = useState(
    initial?.name ?? (kind === 'fillet' ? 'Fillet' : 'Chamfer')
  );
  const [size, setSize] = useState(paramValueText(initial?.size ?? 2));
  const canSubmit =
    name.trim().length > 0 &&
    Boolean(targetBodyId) &&
    edgeHashes.length > 0 &&
    fieldsValid(scope, [size]);

  return (
    <FormShell
      name={name}
      onName={setName}
      submitLabel={submitLabel}
      canSubmit={canSubmit}
      onSubmit={() =>
        onSubmit({
          name: name.trim(),
          targetBodyId: targetBodyId!,
          edgeHashes,
          size: coerceParamValue(size)
        })
      }
      onCancel={onCancel}
    >
      <div className="selection-summary">
        {edgeHashes.length > 0
          ? `${edgeHashes.length} exact edge${edgeHashes.length === 1 ? '' : 's'} selected`
          : targetBodyId
            ? 'Select edges in the viewport or select every edge below.'
            : 'Select a body or edge in the viewport first.'}
      </div>
      {targetBodyId &&
        availableEdgeCount &&
        availableEdgeCount > 0 &&
        onSelectAllEdges && (
          <button
            type="button"
            className="secondary edge-selection-action"
            onClick={
              edgeHashes.length === availableEdgeCount && onClearEdges
                ? onClearEdges
                : onSelectAllEdges
            }
          >
            {edgeHashes.length === availableEdgeCount
              ? 'Clear edge selection'
              : `Select all ${availableEdgeCount} edges`}
          </button>
        )}
      <p className="muted edge-selection-hint">
        Shift+Click adds or removes individual edges.
      </p>
      <ExprInput
        label={kind === 'fillet' ? 'Radius' : 'Distance'}
        value={size}
        scope={scope}
        autoFocus
        onChange={setSize}
      />
    </FormShell>
  );
}

export interface PatternFormValue {
  name: string;
  targetBodyId: BodyId;
  patternKind: PatternKind;
  count: ParamValue;
  axis: AxisId;
  spacing: ParamValue;
  angleDeg: ParamValue;
}

interface PatternFormProps {
  kind: PatternKind;
  scope: Record<string, number>;
  bodies: BodyOption[];
  selectedBodyId?: BodyId | null;
  initial?: PatternFormValue;
  submitLabel: string;
  onSubmit(value: PatternFormValue): void;
  onCancel?: () => void;
}

export function PatternForm({
  kind,
  scope,
  bodies,
  selectedBodyId,
  initial,
  submitLabel,
  onSubmit,
  onCancel
}: PatternFormProps) {
  const available = bodies.filter(
    (body) => !body.consumed || body.bodyId === initial?.targetBodyId
  );
  const [name, setName] = useState(
    initial?.name ?? (kind === 'linear' ? 'Linear pattern' : 'Circular pattern')
  );
  const [targetBodyId, setTargetBodyId] = useState<BodyId | ''>(
    initial?.targetBodyId ?? selectedBodyId ?? available[0]?.bodyId ?? ''
  );
  const [count, setCount] = useState(paramValueText(initial?.count ?? 3));
  const [axis, setAxis] = useState<AxisId>(initial?.axis ?? 'x');
  const [spacing, setSpacing] = useState(
    paramValueText(initial?.spacing ?? 20)
  );
  const [angleDeg, setAngleDeg] = useState(
    paramValueText(initial?.angleDeg ?? 360)
  );
  const canSubmit =
    name.trim().length > 0 &&
    targetBodyId !== '' &&
    fieldsValid(scope, [count, kind === 'linear' ? spacing : angleDeg]);

  return (
    <FormShell
      name={name}
      onName={setName}
      submitLabel={submitLabel}
      canSubmit={canSubmit}
      onSubmit={() =>
        onSubmit({
          name: name.trim(),
          targetBodyId: targetBodyId as BodyId,
          patternKind: kind,
          count: coerceParamValue(count),
          axis,
          spacing: coerceParamValue(spacing),
          angleDeg: coerceParamValue(angleDeg)
        })
      }
      onCancel={onCancel}
    >
      <label className="field">
        <span>Body</span>
        <select
          value={targetBodyId}
          onChange={(event) => setTargetBodyId(event.target.value as BodyId)}
        >
          {available.length === 0 && <option value="">No bodies yet</option>}
          {available.map((body) => (
            <option key={body.bodyId} value={body.bodyId}>
              {body.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field-pair">
        <ExprInput
          label="Count"
          value={count}
          scope={scope}
          autoFocus
          onChange={setCount}
        />
        <label className="field">
          <span>Axis</span>
          <select
            value={axis}
            onChange={(event) => setAxis(event.target.value as AxisId)}
          >
            <option value="x">X</option>
            <option value="y">Y</option>
            <option value="z">Z</option>
          </select>
        </label>
      </div>
      {kind === 'linear' ? (
        <ExprInput
          label="Spacing"
          value={spacing}
          scope={scope}
          onChange={setSpacing}
        />
      ) : (
        <ExprInput
          label="Total angle°"
          value={angleDeg}
          scope={scope}
          onChange={setAngleDeg}
        />
      )}
    </FormShell>
  );
}
