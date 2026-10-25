import { useEffect, useRef, useState, type ReactNode } from 'react';
import { coerceParamValue, type FieldQuantity } from '@openzcad/document-core';
import {
  MAX_SKETCH_POLYGON_SIDES,
  type BodyId,
  type DatumAxisRef,
  type FeatureId,
  type ParamValue,
  type ParametricVector3,
  type PlaneId,
  type PrimitiveKind,
  type SketchId,
  type SketchObjectData,
  type SketchObjectKind,
  type UnitSystem
} from '@openzcad/shared';
import { ExprInput } from '../ExprInput';
import { isPickListRow } from './pickListRow';
import { PRIMITIVE_ANCHORS } from '../../lib/primitivePlacement';
import {
  primitiveGhostFor,
  type PrimitiveGhost
} from '../../lib/primitiveGhost';
import { TextObjectFields, type TextAttributes } from '../TextObjectFields';
import {
  PLANE_LABELS,
  paramValueText,
  previewExpression
} from '../../lib/model';

export interface BodyOption {
  bodyId: BodyId;
  name: string;
  consumed: boolean;
}

/** R01: a datum axis a revolve, circular pattern or Move can turn about. */
export interface DatumAxisChoice {
  featureId: FeatureId;
  name: string;
}

const DATUM_AXIS_VALUE = 'datum-axis:';

const axisRefOf = (value: string): DatumAxisRef | undefined =>
  value.startsWith(DATUM_AXIS_VALUE)
    ? {
        type: 'datum-axis',
        datumFeatureId: value.slice(DATUM_AXIS_VALUE.length) as FeatureId
      }
    : undefined;

/**
 * The datum axes a select offers, plus an axis the feature already turns
 * about but that is no longer offered (suppressed, say), so the select can
 * still show what is stored.
 */
function datumAxisOptions(
  axes: readonly DatumAxisChoice[],
  stored: DatumAxisRef | undefined
): ReactNode[] {
  const shown =
    stored && !axes.some((axis) => axis.featureId === stored.datumFeatureId)
      ? [...axes, { featureId: stored.datumFeatureId, name: 'Stored axis' }]
      : axes;
  return shown.map((axis) => (
    <option key={axis.featureId} value={`${DATUM_AXIS_VALUE}${axis.featureId}`}>
      {axis.name}
    </option>
  ));
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
        // Enter submits from any field, including selects, and from a pick
        // list row (see `isPickListRow`).
        if (
          event.key === 'Enter' &&
          (!(event.target instanceof HTMLButtonElement) ||
            isPickListRow(event.target))
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
          aria-keyshortcuts="Enter"
        >
          {submitLabel}
          {/*
            Decoration, not part of the name. Without this the button announced
            itself as "Create ↵". The key is `aria-keyshortcuts`, not a `title`:
            a title of "Enter" was what assistive tech read in place of the
            verb, so every Create and Apply was announced as "Enter".
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

function fieldsValid(
  scope: Record<string, number>,
  values: string[],
  quantity?: FieldQuantity
): boolean {
  return values.every((value) => previewExpression(value, scope, quantity).ok);
}

/**
 * A size that evaluates but cannot build, in PrimitiveForm's words. Without
 * it a plain "0" showed nothing at all — a plain number has no preview — and
 * the primary button was simply off.
 */
function positiveError(
  value: string,
  scope: Record<string, number>,
  quantity?: FieldQuantity
): string | undefined {
  const preview = previewExpression(value, scope, quantity);
  return preview.ok && preview.value !== undefined && !(preview.value > 0)
    ? 'Must be greater than zero.'
    : undefined;
}

/**
 * A count the geometry takes only within its range, refused unless
 * integral: polygon sides and pattern instances are whole numbers.
 */
function countError(
  value: string,
  scope: Record<string, number>,
  min: number,
  max: number,
  quantity?: FieldQuantity
): string | undefined {
  const preview = previewExpression(value, scope, quantity);
  if (!preview.ok || preview.value === undefined) return undefined;
  const count = preview.value;
  if (Number.isInteger(count) && count >= min && count <= max) return undefined;
  return `Must be a whole number from ${min} to ${max}.`;
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
  /**
   * The document's units. Every primitive field — each size and the anchor
   * position — is a length, so a suffixed value such as `1 in + 25.4 mm`
   * previews, validates and builds in these units, and an angle is refused.
   */
  documentUnits: UnitSystem;
  initialName: string;
  initialDimensions?: Record<string, ParamValue>;
  /** Where the anchor point sits now; absent means the origin. */
  initialPosition?: ParametricVector3;
  submitLabel: string;
  onSubmit(
    name: string,
    dimensions: Record<string, ParamValue>,
    position: ParametricVector3
  ): void;
  onCancel?: () => void;
  /**
   * The card's values as a ghost, on every change that moves it, so the
   * viewport can draw the primitive before Create; null while a field does
   * not resolve to a size that builds, and when the card closes.
   */
  onGhostChange?: (ghost: PrimitiveGhost | null) => void;
}

const POSITION_AXES = ['x', 'y', 'z'] as const;

export function PrimitiveForm({
  kind,
  scope,
  documentUnits,
  initialName,
  initialDimensions,
  initialPosition,
  submitLabel,
  onSubmit,
  onCancel,
  onGhostChange
}: PrimitiveFormProps) {
  const fields = PRIMITIVE_FIELDS[kind];
  const anchor = PRIMITIVE_ANCHORS[kind];
  const length = { documentUnits, dimension: 'length' } as const;
  const [name, setName] = useState(initialName);
  const documentValues = Object.fromEntries(
    fields.map((field) => [
      field.key,
      initialDimensions
        ? paramValueText(initialDimensions[field.key])
        : field.initial
    ])
  );
  const documentPosition = Object.fromEntries(
    POSITION_AXES.map((axis) => [
      axis,
      paramValueText(initialPosition?.[axis] ?? 0)
    ])
  ) as Record<(typeof POSITION_AXES)[number], string>;
  const [values, setValues] = useState<Record<string, string>>(
    () => documentValues
  );
  const [position, setPosition] = useState(() => documentPosition);

  /**
   * Follow the document when it moves underneath the open form.
   *
   * A viewport drag can commit a new size while this panel is showing the old
   * one, and the panel is not re-keyed by the edit, so nothing else would
   * refresh these fields. Comparing the document's own text means typing is
   * never clobbered: local edits do not change what the document says.
   */
  const documentSignature = [
    ...fields.map((field) => documentValues[field.key]),
    ...POSITION_AXES.map((axis) => documentPosition[axis])
  ].join('\u0000');
  const lastDocumentSignature = useRef(documentSignature);
  if (lastDocumentSignature.current !== documentSignature) {
    lastDocumentSignature.current = documentSignature;
    setValues(documentValues);
    setPosition(documentPosition);
  }

  const dimensionErrors = Object.fromEntries(
    fields.map((field) => {
      const preview = previewExpression(values[field.key] ?? '', scope, length);
      const allowsZero = kind === 'cone' && field.key !== 'height';
      const invalid =
        preview.ok &&
        (preview.value === undefined ||
          !Number.isFinite(preview.value) ||
          (allowsZero ? preview.value < 0 : preview.value <= 0));
      return [
        field.key,
        invalid
          ? allowsZero
            ? 'Must be zero or greater.'
            : 'Must be greater than zero.'
          : undefined
      ];
    })
  );
  if (
    kind === 'cone' &&
    previewExpression(values.bottomRadius ?? '', scope, length).value === 0 &&
    previewExpression(values.topRadius ?? '', scope, length).value === 0
  ) {
    dimensionErrors.bottomRadius =
      'At least one radius must be greater than zero.';
  }
  // Editing an existing feature: Apply stays off until something differs
  // from the document, so the primary action never re-runs a no-op.
  const unchanged =
    initialDimensions !== undefined &&
    name.trim() === initialName.trim() &&
    fields.every(
      (field) => (values[field.key] ?? '').trim() === documentValues[field.key]
    ) &&
    POSITION_AXES.every(
      (axis) => position[axis].trim() === documentPosition[axis]
    );
  // Keyed on the resolved numbers, so a keystroke that leaves the value the
  // same (`30` → `30.`, `w` while w = 30) does not rebuild the ghost.
  const ghost = onGhostChange
    ? primitiveGhostFor(kind, values, position, scope, documentUnits)
    : null;
  const ghostKey = ghost ? JSON.stringify(ghost) : null;
  const ghostCallback = useRef(onGhostChange);
  ghostCallback.current = onGhostChange;
  useEffect(() => {
    ghostCallback.current?.(
      ghostKey ? (JSON.parse(ghostKey) as PrimitiveGhost) : null
    );
  }, [ghostKey]);
  // Create, Cancel and Escape all close the card: the ghost goes with it.
  useEffect(() => () => ghostCallback.current?.(null), []);

  const canSubmit =
    !unchanged &&
    name.trim().length > 0 &&
    fieldsValid(
      scope,
      [...Object.values(values), ...Object.values(position)],
      length
    ) &&
    Object.values(dimensionErrors).every((error) => !error);

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
          ),
          {
            x: coerceParamValue(position.x),
            y: coerceParamValue(position.y),
            z: coerceParamValue(position.z)
          }
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
          quantity={length}
          autoFocus={index === 0}
          error={dimensionErrors[field.key]}
          onChange={(value) =>
            setValues((current) => ({ ...current, [field.key]: value }))
          }
        />
      ))}
      {/*
        Which point the numbers place differs by primitive (a box from its
        corner, a cylinder from its base center), so the row names it rather
        than leaving two primitives at 0, 0, 0 to land on different points.
      */}
      <fieldset className="primitive-position">
        <legend>Position</legend>
        <div className="field-triple">
          {POSITION_AXES.map((axis) => (
            <ExprInput
              key={axis}
              label={`${anchor.label} ${axis.toUpperCase()}`}
              value={position[axis]}
              scope={scope}
              quantity={length}
              onChange={(value) =>
                setPosition((current) => ({ ...current, [axis]: value }))
              }
            />
          ))}
        </div>
        <p className="field-hint">{anchor.hint}</p>
      </fieldset>
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
  units?: UnitSystem;
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
  units?: UnitSystem;
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
  units = 'mm',
  initial,
  onSubmit,
  onCancel,
  onEditInViewport
}: TextSketchFormProps) {
  const [name, setName] = useState(initial.name);
  const [text, setText] = useState<TextAttributes>({
    text: initial.object.text,
    fontFamily: initial.object.fontFamily,
    fontStyle: initial.object.fontStyle,
    ...(initial.object.align ? { align: initial.object.align } : {})
  });
  const [values, setValues] = useState<Record<string, string>>(() => ({
    size: paramValueText(initial.object.size),
    rotation: paramValueText(initial.object.rotation ?? 0),
    x: paramValueText(initial.object.x),
    y: paramValueText(initial.object.y)
  }));
  const length = { documentUnits: units, dimension: 'length' } as const;
  const angle = { documentUnits: units, dimension: 'angle' } as const;
  const sizeError = positiveError(values.size ?? '', scope, length);
  const canSubmit =
    name.trim().length > 0 &&
    text.text.length > 0 &&
    fieldsValid(
      scope,
      ['size', 'x', 'y'].map((key) => values[key] ?? ''),
      length
    ) &&
    fieldsValid(scope, [values.rotation ?? '0'], angle) &&
    !sizeError;

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
            // Spread first so fields this form does not own — construction
            // — survive the edit; alignment rides in `text` once picked.
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
          label="Size (em)"
          value={values.size ?? ''}
          scope={scope}
          quantity={length}
          error={sizeError}
          onChange={setValue('size')}
        />
        <ExprInput
          label="Rotation"
          value={values.rotation ?? ''}
          scope={scope}
          quantity={angle}
          onChange={setValue('rotation')}
        />
      </div>
      <div className="field-pair">
        <ExprInput
          label="X"
          value={values.x ?? ''}
          scope={scope}
          quantity={length}
          onChange={setValue('x')}
        />
        <ExprInput
          label="Y"
          value={values.y ?? ''}
          scope={scope}
          quantity={length}
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
  units = 'mm',
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
  const length = { documentUnits: units, dimension: 'length' } as const;
  const number = { documentUnits: units, dimension: 'number' } as const;
  const shapeErrors: Record<string, string | undefined> = {
    width: positiveError(values.width ?? '', scope, length),
    height: positiveError(values.height ?? '', scope, length),
    radius: positiveError(values.radius ?? '', scope, length),
    sides: countError(
      values.sides ?? '',
      scope,
      3,
      MAX_SKETCH_POLYGON_SIDES,
      number
    )
  };
  const canSubmit =
    name.trim().length > 0 &&
    fieldsValid(scope, [offset], length) &&
    activeKeys.every(
      (key) =>
        previewExpression(
          values[key] ?? '',
          scope,
          key === 'sides' ? number : length
        ).ok
    ) &&
    shapeKeys.every((key) => !shapeErrors[key]);

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
            quantity={length}
            autoFocus
            onChange={setValue('width')}
            error={shapeErrors.width}
          />
          <ExprInput
            label="Height"
            value={values.height ?? ''}
            scope={scope}
            quantity={length}
            onChange={setValue('height')}
            error={shapeErrors.height}
          />
        </>
      )}
      {shape !== 'rectangle' && (
        <ExprInput
          label="Radius"
          value={values.radius ?? ''}
          scope={scope}
          quantity={length}
          autoFocus
          onChange={setValue('radius')}
          error={shapeErrors.radius}
        />
      )}
      {shape === 'polygon' && (
        <ExprInput
          label="Sides"
          value={values.sides ?? ''}
          scope={scope}
          quantity={number}
          onChange={setValue('sides')}
          error={shapeErrors.sides}
        />
      )}
      <div className="field-pair">
        <ExprInput
          label="Center X"
          value={values.centerX ?? ''}
          scope={scope}
          quantity={length}
          onChange={setValue('centerX')}
        />
        <ExprInput
          label="Center Y"
          value={values.centerY ?? ''}
          scope={scope}
          quantity={length}
          onChange={setValue('centerY')}
        />
      </div>
      <ExprInput
        label="Plane offset"
        value={offset}
        scope={scope}
        quantity={length}
        onChange={setOffset}
      />
    </FormShell>
  );
}

export { ExtrudeForm } from './ExtrudeForm';

// ---------------------------------------------------------------------------
// Transform
// ---------------------------------------------------------------------------

export interface TransformFormValue {
  name: string;
  targetBodyId: BodyId;
  translation: { x: ParamValue; y: ParamValue; z: ParamValue };
  rotationDeg: { x: ParamValue; y: ParamValue; z: ParamValue };
  /** Uniform scale about the pivot; 1 means unscaled. */
  scale?: ParamValue;
  /**
   * M10: the point rotation and scale turn about. Absent is the world
   * origin; the Move gizmo writes the body's centre.
   */
  pivot?: { x: ParamValue; y: ParamValue; z: ParamValue };
  /**
   * M10: add a moved copy as a new body and leave the source in place. Set
   * only when creating; a stored Move cannot become a copy or stop being one.
   */
  copy?: boolean;
  /**
   * R01: first turn the body about a datum axis. Absent turns about none;
   * an edit that clears it removes the stored turn.
   */
  axisRotation?: { axis: DatumAxisRef; angleDeg: ParamValue };
}

interface TransformFormProps {
  scope: Record<string, number>;
  bodies: BodyOption[];
  /** The Move being edited: the gizmo creates one, this card edits it. */
  initial: TransformFormValue;
  /**
   * Document length units: named in the move and pivot labels, and the unit
   * those fields are typed in (F05), so `10 mm` converts and an angle is
   * refused there.
   */
  units?: UnitSystem;
  /** R01: earlier datum axes the body may turn about. */
  datumAxes?: readonly DatumAxisChoice[];
  submitLabel: string;
  onSubmit(value: TransformFormValue): void;
  onCancel?: () => void;
}

const TRANSFORM_AXES = ['x', 'y', 'z'] as const;

export function TransformForm({
  scope,
  bodies,
  initial,
  units,
  datumAxes = [],
  submitLabel,
  onSubmit,
  onCancel
}: TransformFormProps) {
  const live = bodies.filter((body) => !body.consumed);
  const [name, setName] = useState(initial.name);
  const [target, setTarget] = useState<BodyId | ''>(initial.targetBodyId);
  const [values, setValues] = useState<Record<string, string>>(() => ({
    tx: paramValueText(initial.translation.x),
    ty: paramValueText(initial.translation.y),
    tz: paramValueText(initial.translation.z),
    rx: paramValueText(initial.rotationDeg.x),
    ry: paramValueText(initial.rotationDeg.y),
    rz: paramValueText(initial.rotationDeg.z),
    scale: paramValueText(initial.scale ?? 1),
    px: paramValueText(initial.pivot?.x ?? 0),
    py: paramValueText(initial.pivot?.y ?? 0),
    pz: paramValueText(initial.pivot?.z ?? 0)
  }));
  // M10: a copy is fixed when the Move is made — it owns a body of its own.
  const copy = initial.copy ?? false;
  const [turnAxis, setTurnAxis] = useState<string>(
    initial.axisRotation
      ? `${DATUM_AXIS_VALUE}${initial.axisRotation.axis.datumFeatureId}`
      : ''
  );
  const [turnAngle, setTurnAngle] = useState(
    paramValueText(initial.axisRotation?.angleDeg ?? 90)
  );
  const turnRef = axisRefOf(turnAxis);
  const showTurn = datumAxes.length > 0 || initial.axisRotation !== undefined;
  const setValue = (key: string) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  // Moves and the pivot are lengths, turns are angles and scale is a plain
  // factor, as the exact build reads them.
  const length = units
    ? ({ documentUnits: units, dimension: 'length' } as const)
    : undefined;
  const angle = units
    ? ({ documentUnits: units, dimension: 'angle' } as const)
    : undefined;
  const number = units
    ? ({ documentUnits: units, dimension: 'number' } as const)
    : undefined;
  const pick = (prefix: string) =>
    TRANSFORM_AXES.map((axis) => values[`${prefix}${axis}`] ?? '');
  const scaleError = positiveError(values.scale ?? '', scope, number);
  const canSubmit =
    name.trim().length > 0 &&
    target !== '' &&
    fieldsValid(scope, [...pick('t'), ...pick('p')], length) &&
    fieldsValid(scope, pick('r'), angle) &&
    fieldsValid(scope, [values.scale ?? ''], number) &&
    !scaleError &&
    (turnRef ? fieldsValid(scope, [turnAngle], angle) : true);

  return (
    <FormShell
      name={name}
      onName={setName}
      submitLabel={submitLabel}
      canSubmit={canSubmit}
      onSubmit={() => {
        // A literal 1 is "no scaling" and stays out of the stored feature, so
        // older documents and unscaled moves keep byte-identical data.
        const scale = coerceParamValue(values.scale ?? '1');
        const pivot = {
          x: coerceParamValue(values.px ?? '0'),
          y: coerceParamValue(values.py ?? '0'),
          z: coerceParamValue(values.pz ?? '0')
        };
        // A pivot at the origin is the absent pivot: stored only when it is
        // somewhere else, so origin moves keep byte-identical data.
        const atOrigin = pivot.x === 0 && pivot.y === 0 && pivot.z === 0;
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
          },
          ...(scale === 1 ? {} : { scale }),
          ...(atOrigin ? {} : { pivot }),
          ...(copy ? { copy: true } : {}),
          ...(turnRef
            ? {
                axisRotation: {
                  axis: turnRef,
                  angleDeg: coerceParamValue(turnAngle)
                }
              }
            : {})
        });
      }}
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
      {/* M10: a copy is fixed when the Move is made — it owns a body of its
          own — so an edit names what it is instead of offering a toggle. */}
      {copy && (
        <p className="field-hint">Copy: the source body stays in place.</p>
      )}
      {showTurn ? (
        <>
          <label className="field">
            <span>About axis</span>
            <select
              value={turnAxis}
              aria-label="Rotate about axis"
              onChange={(event) => setTurnAxis(event.target.value)}
            >
              <option value="">None</option>
              {datumAxes.length === 0 && !initial.axisRotation ? (
                <option value="">Create an axis first</option>
              ) : null}
              {datumAxisOptions(datumAxes, initial.axisRotation?.axis)}
            </select>
          </label>
          {turnRef ? (
            <ExprInput
              label="Angle (°)"
              ariaLabel="Angle about axis in degrees"
              value={turnAngle}
              scope={scope}
              quantity={angle}
              onChange={setTurnAngle}
            />
          ) : null}
          {turnRef ? (
            <p className="field-hint">
              Turns about the axis first; the move below then applies.
            </p>
          ) : null}
        </>
      ) : null}
      {/* The labels the Move gizmo's card uses (F19): a Move is created
      there and edited here, and the two named the same fields
      "dX" and "Move X". */}
      <div className="field-triple">
        {TRANSFORM_AXES.map((axis, index) => (
          <ExprInput
            key={`t${axis}`}
            label={`d${axis.toUpperCase()}`}
            ariaLabel={`Move ${axis.toUpperCase()}${units ? ` in ${units}` : ''}`}
            value={values[`t${axis}`] ?? ''}
            scope={scope}
            quantity={length}
            autoFocus={index === 0}
            onChange={setValue(`t${axis}`)}
          />
        ))}
      </div>
      <div className="field-triple">
        {TRANSFORM_AXES.map((axis) => (
          <ExprInput
            key={`r${axis}`}
            label={`r${axis.toUpperCase()}`}
            ariaLabel={`Rotate ${axis.toUpperCase()} in degrees`}
            value={values[`r${axis}`] ?? ''}
            scope={scope}
            quantity={angle}
            onChange={setValue(`r${axis}`)}
          />
        ))}
      </div>
      <ExprInput
        label="Scale ×"
        value={values.scale ?? ''}
        scope={scope}
        quantity={number}
        onChange={setValue('scale')}
        error={scaleError}
      />
      {/* Rotation and scale turn about this point; the gizmo fills it with
      the body's centre, and 0, 0, 0 is the world origin. */}
      <div className="field-triple">
        {TRANSFORM_AXES.map((axis) => (
          <ExprInput
            key={`p${axis}`}
            label={`p${axis.toUpperCase()}`}
            ariaLabel={`Pivot ${axis.toUpperCase()}${units ? ` in ${units}` : ''}`}
            value={values[`p${axis}`] ?? ''}
            scope={scope}
            quantity={length}
            onChange={setValue(`p${axis}`)}
          />
        ))}
      </div>
    </FormShell>
  );
}
