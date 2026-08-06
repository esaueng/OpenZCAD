import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { coerceParamValue } from '@openzcad/document-core';
import {
  FULL_REVOLVE_ANGLE_DEG,
  type AxisId,
  type BodyId,
  type BooleanOperation,
  type EdgeTopologyReferenceV5,
  type ExtrudeOperation,
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
import { useFieldAutoFocus } from './fieldAutoFocus';
import { TextObjectFields, type TextAttributes } from '../TextObjectFields';
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
        if (
          event.key === 'Enter' &&
          !(event.target instanceof HTMLButtonElement)
        ) {
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
        <button
          type="submit"
          className="primary"
          disabled={!canSubmit}
          title="Enter"
        >
          {submitLabel}
          {/*
            Decoration, not part of the name. Without this the button announced
            itself as "Create ↵"; the hint stays visible and `title` already
            carries it for anyone reading the tooltip.
          */}
          <kbd className="kbd-inline" aria-hidden="true">
            ↵
          </kbd>
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

/**
 * Starting sizes for a new primitive.
 *
 * The box is the part; everything round is a feature you add to it, and the
 * defaults have to be able to say that. A round primitive is therefore sized
 * to fit inside the box's smallest footprint dimension (18) with clearance on
 * both sides, which is also the condition its booleans need: measured against
 * this box, a cylinder unions exactly up to radius 8 and facets from 9, where
 * its diameter reaches the box's depth and goes tangent to both faces. The
 * old radius 14 was a diameter of 28 against a depth of 18, so the first union
 * a new user attempted could not succeed at ANY position — the two shapes were
 * simply the wrong sizes for each other.
 *
 * Heights run past the box's 24 so a new solid protrudes rather than hiding
 * inside it: a boolean between two bodies you cannot both see is not a first
 * thing to meet.
 */
const PRIMITIVE_FIELDS: Record<
  PrimitiveKind,
  { key: string; label: string; initial: string }[]
> = {
  // Labelled by what the dimension IS, not by the document key that carries
  // it. The keys are OCCT's makeBox(dx, dy, dz), so `depth` lands on Z — and Z
  // is up here, which made "Depth (Z)" the upright size and "Height (Y)" a
  // horizontal one, while the cylinder next door called its vertical extent
  // Height. Keys are untouched; only the human contract changes.
  box: [
    { key: 'width', label: 'Width (X)', initial: '30' },
    { key: 'height', label: 'Depth (Y)', initial: '18' },
    { key: 'depth', label: 'Height (Z)', initial: '24' }
  ],
  cylinder: [
    { key: 'radius', label: 'Radius', initial: '6' },
    { key: 'height', label: 'Height', initial: '28' }
  ],
  sphere: [{ key: 'radius', label: 'Radius', initial: '6' }],
  cone: [
    { key: 'bottomRadius', label: 'Bottom radius', initial: '6' },
    { key: 'topRadius', label: 'Top radius', initial: '2' },
    { key: 'height', label: 'Height', initial: '28' }
  ],
  torus: [
    { key: 'majorRadius', label: 'Ring radius', initial: '6' },
    { key: 'minorRadius', label: 'Tube radius', initial: '2' }
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
    if (
      kind !== 'cylinder' ||
      liveRadius === undefined ||
      liveRadius === null
    ) {
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

/**
 * The form only offers closed one-object profiles. Open curves (line/arc) are
 * drawn in the viewport sketch mode, and text is placed with the text tool.
 */
type ClosedShapeKind = Extract<
  SketchObjectKind,
  'rectangle' | 'circle' | 'polygon'
>;

const CLOSED_SHAPE_KINDS: readonly ClosedShapeKind[] = [
  'rectangle',
  'circle',
  'polygon'
];

function isClosedShape(
  data: SketchObjectData
): data is Extract<SketchObjectData, { objectKind: ClosedShapeKind }> {
  return CLOSED_SHAPE_KINDS.includes(data.objectKind as ClosedShapeKind);
}

const SHAPE_LABELS: Record<ClosedShapeKind, string> = {
  rectangle: 'Rectangle',
  circle: 'Circle',
  polygon: 'Polygon'
};

export interface TextSketchFormValue {
  name: string;
  data: Extract<SketchObjectData, { objectKind: 'text' }>;
}

interface TextSketchFormProps {
  scope: Record<string, number>;
  initial: {
    name: string;
    object: Extract<SketchObjectData, { objectKind: 'text' }>;
  };
  onSubmit(value: TextSketchFormValue): void;
  onCancel?: () => void;
  /** Opens the sketch in the viewport for spatial edits. */
  onEditInViewport?: () => void;
}

/**
 * The edit form for a sketch whose object is text.
 *
 * `SketchForm` below only understands closed one-object profiles, and its
 * fallback for anything else was a rectangle — so selecting a finished text
 * sketch in the history presented it as "Rectangle 32×18", and Apply would
 * have replaced the text with that rectangle and re-planed a face-attached
 * sketch onto a canonical plane. This form owns the text case instead: the
 * same fields as the in-sketch entity editor, applied through
 * `updateSketchObject`, which never touches the sketch's plane.
 */
export function TextSketchForm({
  scope,
  initial,
  onSubmit,
  onCancel,
  onEditInViewport
}: TextSketchFormProps) {
  const [name, setName] = useState(initial.name);
  const [text, setText] = useState<TextAttributes>({
    text: initial.object.text,
    fontFamily: initial.object.fontFamily,
    fontStyle: initial.object.fontStyle
  });
  const [values, setValues] = useState<Record<string, string>>(() => ({
    size: paramValueText(initial.object.size),
    rotation: paramValueText(initial.object.rotation ?? 0),
    x: paramValueText(initial.object.x),
    y: paramValueText(initial.object.y)
  }));
  const canSubmit =
    name.trim().length > 0 &&
    text.text.length > 0 &&
    fieldsValid(scope, Object.values(values));

  const setValue = (key: string) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  return (
    <FormShell
      name={name}
      onName={setName}
      submitLabel="Apply"
      canSubmit={canSubmit}
      onSubmit={() =>
        onSubmit({
          name,
          data: {
            // Spread first so fields this form does not own — alignment,
            // construction — survive the edit.
            ...initial.object,
            ...text,
            size: coerceParamValue(values.size ?? ''),
            rotation: coerceParamValue(values.rotation ?? '0'),
            x: coerceParamValue(values.x ?? '0'),
            y: coerceParamValue(values.y ?? '0')
          }
        })
      }
      {...(onCancel ? { onCancel } : {})}
    >
      <TextObjectFields value={text} onChange={setText} />
      <div className="field-pair">
        <ExprInput
          label="Size"
          value={values.size ?? ''}
          scope={scope}
          onChange={setValue('size')}
        />
        <ExprInput
          label="Rotation"
          value={values.rotation ?? ''}
          scope={scope}
          onChange={setValue('rotation')}
        />
      </div>
      <div className="field-pair">
        <ExprInput
          label="X"
          value={values.x ?? ''}
          scope={scope}
          onChange={setValue('x')}
        />
        <ExprInput
          label="Y"
          value={values.y ?? ''}
          scope={scope}
          onChange={setValue('y')}
        />
      </div>
      {onEditInViewport && (
        <button type="button" className="secondary" onClick={onEditInViewport}>
          Edit sketch in viewport
        </button>
      )}
    </FormShell>
  );
}

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
    initial && isClosedShape(initial.object) ? initial.object : undefined;
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

function SketchPicker({
  sketches,
  value,
  onChange,
  autoFocus
}: SketchPickerProps) {
  const mayAutoFocus = useFieldAutoFocus(autoFocus);
  return (
    <label className="field">
      <span>Sketch</span>
      <select
        value={value}
        autoFocus={mayAutoFocus}
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
  initial?: {
    name: string;
    sketchId: SketchId;
    distance: ParamValue;
    operation?: ExtrudeOperation;
  };
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
  // A zero-distance extrude builds nothing, and the kernel says so only after
  // the edit has committed and taken the body with it — the panel showed no
  // error, Apply stayed enabled, and the solid simply vanished, leaving a
  // sidebar diagnostic as the only account of it. Caught here instead, the
  // same way RevolveForm catches an out-of-range angle. Expressions are
  // covered too, since the preview evaluates against the parameter scope.
  const distancePreview = previewExpression(distance, scope);
  const distanceIsZero =
    distancePreview.ok &&
    distancePreview.value !== undefined &&
    distancePreview.value === 0;
  const canSubmit =
    name.trim().length > 0 &&
    sketchId !== '' &&
    fieldsValid(scope, [distance]) &&
    !distanceIsZero;

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
      <label className="field">
        <span>Operation</span>
        <select
          aria-label="Stored extrude operation"
          value={initial ? (initial.operation ?? 'new-body') : 'automatic'}
          disabled
        >
          <option value="automatic">Automatic from exact overlap</option>
          <option value="new-body">New Body</option>
          <option value="add">Add</option>
          <option value="cut">Cut</option>
        </select>
      </label>
      <ExprInput
        label="Distance"
        value={distance}
        scope={scope}
        autoFocus
        onChange={setDistance}
      />
      {distanceIsZero && (
        <p className="muted error">
          Distance cannot be zero — a zero-distance extrude builds no solid.
        </p>
      )}
      <p className="muted">
        Negative distances extrude below the sketch plane. The operation is
        resolved when the feature is created and is not re-inferred by edits.
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
  const operationAutoFocus = useFieldAutoFocus(true);

  /**
   * Keep an untouched name honest about what the feature does.
   *
   * Switching Union to Subtract left the name reading "Union", so the history
   * row, the body and the panel heading all claimed an operation the feature
   * did not perform. Only a name the user has not written is re-derived —
   * comparing against the CURRENT operation's label is what distinguishes
   * "still the default" from "deliberately called Union".
   */
  function changeOperation(next: BooleanOperation) {
    setName((current) =>
      current === OPERATION_LABELS[operation] ? OPERATION_LABELS[next] : current
    );
    setOperation(next);
  }

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
          // A select is the worst field to hand the keyboard to unasked: a
          // stray letter jumps to a matching option, so the operation changes
          // silently rather than producing a visible bad value.
          autoFocus={operationAutoFocus}
          onChange={(event) =>
            changeOperation(event.target.value as BooleanOperation)
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
  edgeReferences?: EdgeTopologyReferenceV5[];
  size: ParamValue;
}

interface EdgeModifierFormProps {
  kind: 'fillet' | 'chamfer';
  scope: Record<string, number>;
  targetBodyId: BodyId | null;
  edgeHashes: number[];
  edgeReferences?: EdgeTopologyReferenceV5[];
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
  edgeReferences,
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
          ...(edgeReferences ? { edgeReferences } : {}),
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
            : // Not "select a body or edge": arming this tool narrows picking
              // to edges, so a click on a body face resolves to nothing — and
              // a click that resolves to nothing clears the selection. Name
              // the routes that work rather than the one the tool forbids.
              'Click an edge in the viewport, or pick the body in the model tree.'}
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
