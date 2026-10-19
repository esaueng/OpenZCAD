import { useState, type FormEvent } from 'react';
import {
  coerceParamValue,
  evaluateFieldExpression,
  type ExpressionDimension
} from '@openzcad/document-core';
import {
  MAX_SKETCH_ARC_SWEEP_DEGREES,
  MAX_SKETCH_POLYGON_SIDES,
  type SketchObjectData,
  type UnitSystem
} from '@openzcad/shared';
import type { SketchConstraintToolKind } from '../lib/interaction/machine';
import { CONSTRAINT_ICONS } from './constraintIcons';
import { Trash2, X } from 'lucide-react';
import { ExprInput } from './ExprInput';
import { previewExpression } from '../lib/model';
import { TextObjectFields, type TextAttributes } from './TextObjectFields';

/** One constraint the selected entity takes part in. */
export interface EntityConstraintItem {
  constraintId: string;
  kind: SketchConstraintToolKind;
  label: string;
  /** Driving dimensions open the keypad; the rest only delete. */
  editable: boolean;
}

/**
 * The composite the selected line is a side of (S04): what it is, which
 * side this is, and its size as one object, which its card resizes.
 */
export interface SketchCompositeSummary {
  compositeId: string;
  kind: 'rectangle' | 'polygon';
  /** The shape's name: "Rectangle", "Center rectangle", "Polygon"… */
  title: string;
  /** 1-based, in the composite's counter-clockwise order. */
  side: number;
  sides: number;
  /** Width and height, or the polygon's circumradius. */
  size: { width: number; height: number } | { circumradius: number };
  /**
   * Sizes a dimension already drives with an expression: the card shows the
   * expression, not the number it measures to.
   */
  expressions?: Partial<Record<'width' | 'height' | 'circumradius', string>>;
  /** What a resize holds still, said on the card. */
  anchor: string;
}

interface SketchEntityEditorProps {
  data: SketchObjectData;
  /** Set when the selected line is a side of a rectangle or polygon. */
  composite?: SketchCompositeSummary | null;
  /**
   * `expressions` holds each field typed as an expression rather than a
   * plain number; those sizes keep driving the shape through a dimension.
   */
  onResizeComposite?(
    size: SketchCompositeSummary['size'],
    expressions: NonNullable<SketchCompositeSummary['expressions']>
  ): void;
  scope: Record<string, number>;
  units?: UnitSystem;
  disabled?: boolean;
  error?: string | null;
  onApply(data: SketchObjectData): void;
  onDelete(): void;
  onClose(): void;
  /**
   * The constraints section: what the entity is already held by. Adding one
   * starts from the relations rail, which takes this entity as pick 1.
   * Absent or empty, the editor is the plain value form.
   */
  constraints?: EntityConstraintItem[];
  onEditConstraint?(
    constraintId: string,
    anchor: { x: number; y: number }
  ): void;
  onDeleteConstraint?(constraintId: string): void;
}

interface FieldDefinition {
  key: string;
  label: string;
  dimension?: ExpressionDimension;
  /**
   * Shown when the object carries no value for this key. Optional fields —
   * a text object's `rotation` — are absent on every object created before
   * the field existed, and an empty expression input is invalid, which would
   * disable Apply on an object the user had not touched.
   */
  fallback?: string;
}

const FIELDS: Record<SketchObjectData['objectKind'], FieldDefinition[]> = {
  line: [
    { key: 'x1', label: 'Start X' },
    { key: 'y1', label: 'Start Y' },
    { key: 'x2', label: 'End X' },
    { key: 'y2', label: 'End Y' }
  ],
  rectangle: [
    { key: 'width', label: 'Width' },
    { key: 'height', label: 'Height' },
    { key: 'centerX', label: 'Center X' },
    { key: 'centerY', label: 'Center Y' }
  ],
  circle: [
    { key: 'radius', label: 'Radius' },
    { key: 'centerX', label: 'Center X' },
    { key: 'centerY', label: 'Center Y' }
  ],
  polygon: [
    { key: 'sides', label: 'Sides', dimension: 'number' },
    { key: 'radius', label: 'Radius' },
    { key: 'centerX', label: 'Center X' },
    { key: 'centerY', label: 'Center Y' }
  ],
  arc: [
    { key: 'radius', label: 'Radius' },
    { key: 'centerX', label: 'Center X' },
    { key: 'centerY', label: 'Center Y' },
    { key: 'startAngleDeg', label: 'Start angle', dimension: 'angle' },
    { key: 'endAngleDeg', label: 'End angle', dimension: 'angle' }
  ],
  // Only the numeric fields. The string, family and style need a dedicated
  // editor (the text tool's form) rather than an expression input, so this
  // generic editor exposes what it can drive and leaves the rest alone.
  // Position and rotation place the text on the face being sketched; the
  // string, family and style are not expression fields and live in
  // `TextObjectFields` above the grid.
  text: [
    // The stored size is the em size (the layout scales the face by
    // size / unitsPerEm), not the capital height: Open Sans capitals stand
    // 0.714 of it. The label says which.
    { key: 'size', label: 'Size (em)' },
    { key: 'rotation', label: 'Rotation', fallback: '0', dimension: 'angle' },
    { key: 'x', label: 'X' },
    { key: 'y', label: 'Y' }
  ]
};

/**
 * A dragged entity lands on a double — 41.808471716162806 — and the raw
 * string clipped in a 128 px field says nothing an engineer can use. The
 * field shows the document's working precision instead; expressions are
 * shown as written. `rawValues` keeps what the document holds so a field
 * the user never touched is written back unchanged (see `nextData`).
 */
export const SKETCH_FIELD_DECIMALS = 3;

function fieldText(raw: string | number | undefined, fallback?: string) {
  if (raw === undefined) return fallback ?? '';
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return String(raw);
    const scale = 10 ** SKETCH_FIELD_DECIMALS;
    return String(Math.round(raw * scale) / scale);
  }
  return raw;
}

function initialValues(data: SketchObjectData): Record<string, string> {
  return Object.fromEntries(
    FIELDS[data.objectKind].map(({ key, fallback }) => {
      const raw = (data as unknown as Record<string, string | number>)[key];
      return [key, fieldText(raw, fallback)];
    })
  );
}

/** The raw document values behind `initialValues`, keyed the same way. */
function rawValues(data: SketchObjectData): Record<string, string | number> {
  return Object.fromEntries(
    FIELDS[data.objectKind].flatMap(({ key }) => {
      const raw = (data as unknown as Record<string, string | number>)[key];
      return raw === undefined ? [] : [[key, raw]];
    })
  );
}

function textAttributes(data: SketchObjectData): TextAttributes | null {
  return data.objectKind === 'text'
    ? {
        text: data.text,
        fontFamily: data.fontFamily,
        fontStyle: data.fontStyle,
        // Absent stays absent: Apply writes `align` only once one is picked.
        ...(data.align ? { align: data.align } : {})
      }
    : null;
}

/**
 * The editor's fields after the stored object changed under them — a drag
 * or a turn on the canvas, an undo, a solve. The newest write wins per
 * field: a field whose stored value changed shows the new one, and every
 * other field keeps what it showed, typed or not. So a handle drag lands in
 * X and Y without discarding a string typed but not yet applied, and the
 * editor stays the one owner of the object's values rather than a draft
 * that the canvas silently replaces.
 */
function rebaseEditorFields(
  previous: SketchObjectData,
  next: SketchObjectData,
  values: Record<string, string>,
  text: TextAttributes | null
): { values: Record<string, string>; text: TextAttributes | null } {
  if (previous.objectKind !== next.objectKind) {
    return { values: initialValues(next), text: textAttributes(next) };
  }
  const before = rawValues(previous);
  const after = rawValues(next);
  const shown = initialValues(next);
  const rebasedValues = Object.fromEntries(
    FIELDS[next.objectKind].map(({ key }) => [
      key,
      before[key] === after[key] ? (values[key] ?? shown[key]!) : shown[key]!
    ])
  );
  const was = textAttributes(previous);
  const now = textAttributes(next);
  if (!was || !now || !text) {
    return { values: rebasedValues, text: now };
  }
  const rebasedText: TextAttributes = {
    text: was.text === now.text ? text.text : now.text,
    fontFamily:
      was.fontFamily === now.fontFamily ? text.fontFamily : now.fontFamily,
    fontStyle: was.fontStyle === now.fontStyle ? text.fontStyle : now.fontStyle
  };
  const align = was.align === now.align ? text.align : now.align;
  return {
    values: rebasedValues,
    text: align ? { ...rebasedText, align } : rebasedText
  };
}

function nextData(
  data: SketchObjectData,
  values: Record<string, string>,
  text: TextAttributes | null
): SketchObjectData {
  const raw = rawValues(data);
  // A field still showing the rounded display of its own value keeps the
  // exact value: rounding every untouched coordinate on Apply would nudge
  // geometry the user never meant to change.
  const value = (key: string) =>
    raw[key] !== undefined && values[key] === fieldText(raw[key])
      ? raw[key]
      : coerceParamValue(values[key] ?? '');
  const kind = data.objectKind;
  switch (kind) {
    case 'text':
      // Every case spreads `...data` first. The fields this editor exposes
      // are then overwritten, and everything else survives — `construction`
      // on any kind. Rebuilding a fresh object literal instead silently
      // un-marked construction geometry the moment its radius was edited.
      return {
        ...data,
        objectKind: kind,
        ...(text ?? {}),
        size: value('size'),
        rotation: value('rotation'),
        x: value('x'),
        y: value('y')
      };
    case 'line':
      return {
        ...data,
        objectKind: kind,
        x1: value('x1'),
        y1: value('y1'),
        x2: value('x2'),
        y2: value('y2')
      };
    case 'rectangle':
      return {
        ...data,
        objectKind: kind,
        width: value('width'),
        height: value('height'),
        centerX: value('centerX'),
        centerY: value('centerY')
      };
    case 'circle':
      return {
        ...data,
        objectKind: kind,
        radius: value('radius'),
        centerX: value('centerX'),
        centerY: value('centerY')
      };
    case 'polygon':
      return {
        ...data,
        objectKind: kind,
        sides: value('sides'),
        radius: value('radius'),
        centerX: value('centerX'),
        centerY: value('centerY')
      };
    case 'arc':
      return {
        ...data,
        objectKind: kind,
        radius: value('radius'),
        centerX: value('centerX'),
        centerY: value('centerY'),
        startAngleDeg: value('startAngleDeg'),
        endAngleDeg: value('endAngleDeg')
      };
  }
}

function geometryError(
  kind: SketchObjectData['objectKind'],
  values: Record<string, string>,
  scope: Record<string, number>,
  units: UnitSystem
): string | null {
  let resolved: Record<string, number>;
  try {
    resolved = Object.fromEntries(
      FIELDS[kind].map(({ key, dimension = 'length' }) => [
        key,
        evaluateFieldExpression(values[key] ?? '', scope, {
          documentUnits: units,
          dimension
        })
      ])
    );
  } catch {
    return null;
  }
  if (Object.values(resolved).some((value) => !Number.isFinite(value))) {
    return 'Values must resolve to finite numbers.';
  }
  if (
    (kind === 'rectangle' && (resolved.width! <= 0 || resolved.height! <= 0)) ||
    ((kind === 'circle' || kind === 'polygon' || kind === 'arc') &&
      resolved.radius! <= 0) ||
    (kind === 'text' && resolved.size! <= 0)
  ) {
    return 'Lengths and radii must be greater than zero.';
  }
  if (
    kind === 'polygon' &&
    (!Number.isInteger(resolved.sides) ||
      resolved.sides! < 3 ||
      resolved.sides! > MAX_SKETCH_POLYGON_SIDES)
  ) {
    return `Polygon sides must be an integer from 3 to ${MAX_SKETCH_POLYGON_SIDES}.`;
  }
  if (
    kind === 'line' &&
    Math.hypot(resolved.x2! - resolved.x1!, resolved.y2! - resolved.y1!) < 0.5
  ) {
    return 'Line endpoints must be at least 0.5 units apart.';
  }
  const rawArcSweep =
    kind === 'arc' ? resolved.endAngleDeg! - resolved.startAngleDeg! : null;
  if (
    rawArcSweep !== null &&
    Math.abs(rawArcSweep) > MAX_SKETCH_ARC_SWEEP_DEGREES
  ) {
    return `Arc sweep must not exceed ${MAX_SKETCH_ARC_SWEEP_DEGREES} degrees.`;
  }
  const arcSweep = rawArcSweep === null ? null : Math.abs(rawArcSweep % 360);
  if (arcSweep !== null && (arcSweep < 1 || 360 - arcSweep < 1)) {
    return 'Arc sweep must be at least 1 degree.';
  }
  return null;
}

/** Exact-value editor for the entity selected inside an active sketch. */
export function SketchEntityEditor({
  data,
  scope,
  units = 'mm',
  disabled = false,
  error,
  onApply,
  onDelete,
  onClose,
  constraints,
  onEditConstraint,
  onDeleteConstraint,
  composite,
  onResizeComposite
}: SketchEntityEditorProps) {
  const [values, setValues] = useState(() => initialValues(data));
  const [textAttrs, setTextAttrs] = useState<TextAttributes | null>(() =>
    textAttributes(data)
  );
  // The stored object the fields were last reconciled with. When the object
  // changes while this editor is open, the fields rebase onto it here,
  // during render, so no frame shows the stale values.
  const [base, setBase] = useState(data);
  if (base !== data) {
    const rebased = rebaseEditorFields(base, data, values, textAttrs);
    setBase(data);
    setValues(rebased.values);
    setTextAttrs(rebased.text);
  }
  const fields = FIELDS[data.objectKind];
  const expressionsValid = fields.every(
    ({ key, dimension = 'length' }) =>
      previewExpression(values[key] ?? '', scope, {
        documentUnits: units,
        dimension
      }).ok
  );
  const semanticError = expressionsValid
    ? geometryError(data.objectKind, values, scope, units)
    : null;
  const valid = expressionsValid && !semanticError;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (valid && !disabled) {
      onApply(nextData(data, values, textAttrs));
    }
  }

  // The constraints are a sibling card, not part of the form: the form's
  // label space belongs to its value fields, and a "Radius" tool inside it
  // would answer for the Radius field.
  return (
    <div className="sketch-entity-dock">
      <form
        className="sketch-entity-editor"
        aria-label={`Edit ${data.objectKind}`}
        onSubmit={submit}
      >
        <header>
          <div>
            <span className="eyebrow">Sketch entity</span>
            <strong>{data.objectKind}</strong>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close entity editor"
            onClick={onClose}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <fieldset disabled={disabled} className="sketch-entity-values">
          {textAttrs && (
            <TextObjectFields value={textAttrs} onChange={setTextAttrs} />
          )}
          <div className="sketch-entity-fields">
            {fields.map(({ key, label, dimension = 'length' }) => (
              <ExprInput
                key={key}
                label={label}
                value={values[key] ?? ''}
                scope={scope}
                quantity={{ documentUnits: units, dimension }}
                onChange={(value) =>
                  setValues((current) => ({ ...current, [key]: value }))
                }
              />
            ))}
          </div>
          {!valid && (
            <p className="form-error" role="alert">
              {semanticError ?? 'Fix invalid values before applying this edit.'}
            </p>
          )}
          {/* An Apply the document refused reads as an error, beside the
              values it is about, not as body text under the buttons. */}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button
              type="button"
              className="secondary danger"
              disabled={disabled}
              onClick={onDelete}
            >
              <Trash2 size={13} aria-hidden="true" />
              Delete
            </button>
            <button
              type="submit"
              className="primary"
              disabled={!valid || disabled}
            >
              Apply
            </button>
          </footer>
        </fieldset>
      </form>
      {composite && (
        <SketchCompositeCard
          // A new stored size is a new card: the fields start from it.
          key={`${composite.compositeId}:${JSON.stringify(composite.size)}`}
          composite={composite}
          scope={scope}
          units={units}
          disabled={disabled}
          onResize={(size, expressions) =>
            onResizeComposite?.(size, expressions)
          }
        />
      )}
      {constraints && constraints.length > 0 && (
        <section className="sketch-entity-constraints" aria-label="Constraints">
          <span className="eyebrow">Constraints</span>
          <p className="muted">
            These constraints control this geometry.
            {constraints.some(({ editable }) => editable) &&
              ' Edit a driving dimension below to change its constrained size.'}
          </p>
          <ul className="sketch-constraint-list">
            {constraints.map(({ constraintId, kind, label, editable }) => {
              const Icon = CONSTRAINT_ICONS[kind];
              return (
                <li key={constraintId}>
                  <Icon size={12} aria-hidden="true" />
                  {editable ? (
                    <button
                      type="button"
                      className="sketch-constraint-edit"
                      title={`Edit constraint: ${label}`}
                      aria-label={`Edit constraint: ${label}`}
                      onClick={(event) =>
                        onEditConstraint?.(constraintId, {
                          x: event.clientX,
                          y: event.clientY
                        })
                      }
                    >
                      {label}
                    </button>
                  ) : (
                    <span title={label}>{label}</span>
                  )}
                  <button
                    type="button"
                    className="row-delete"
                    title={`Delete constraint: ${label}`}
                    aria-label={`Delete constraint: ${label}`}
                    onClick={() => onDeleteConstraint?.(constraintId)}
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

const formatSize = (value: number) => String(Math.round(value * 1e6) / 1e6);

/** A size typed as a plain number, as opposed to an expression. */
const PLAIN_SIZE = /^[+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

/**
 * The shape the selected side belongs to, resized as one object: every side
 * and helper moves in one edit, solved together, so the shape's relations
 * never see it half-resized. A centre rectangle keeps its centre; the
 * others keep corner 1; a polygon keeps its centre and rotation.
 */
function SketchCompositeCard({
  composite,
  scope,
  units,
  disabled,
  onResize
}: {
  composite: SketchCompositeSummary;
  scope: Record<string, number>;
  units: UnitSystem;
  disabled: boolean;
  onResize(
    size: SketchCompositeSummary['size'],
    expressions: NonNullable<SketchCompositeSummary['expressions']>
  ): void;
}) {
  const fields =
    'circumradius' in composite.size
      ? [{ key: 'circumradius', label: 'Circumradius' }]
      : [
          { key: 'width', label: 'Width' },
          { key: 'height', label: 'Height' }
        ];
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(composite.size).map(([key, value]) => [
        key,
        composite.expressions?.[key as keyof typeof composite.expressions] ??
          formatSize(value)
      ])
    )
  );
  const resolved = fields.map(({ key }) =>
    previewExpression(values[key] ?? '', scope, {
      documentUnits: units,
      dimension: 'length'
    })
  );
  const numbers = resolved.map((preview) =>
    preview.ok ? (preview.value ?? NaN) : NaN
  );
  const valid = numbers.every((value) => Number.isFinite(value) && value > 0);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || disabled) return;
    // A plain number moves the shape once, as a drag does; an expression
    // (a parameter, say) keeps driving it.
    const expressions = Object.fromEntries(
      fields.flatMap(({ key }) => {
        const text = (values[key] ?? '').trim();
        return PLAIN_SIZE.test(text) ? [] : [[key, text]];
      })
    );
    onResize(
      'circumradius' in composite.size
        ? { circumradius: numbers[0]! }
        : { width: numbers[0]!, height: numbers[1]! },
      expressions
    );
  }
  return (
    <form
      className="sketch-entity-editor"
      aria-label={`Resize ${composite.title.toLowerCase()}`}
      onSubmit={submit}
    >
      <header>
        <div>
          <span className="eyebrow">
            Side {composite.side} of {composite.sides}
          </span>
          <strong>{composite.title}</strong>
        </div>
      </header>
      <fieldset disabled={disabled} className="sketch-entity-values">
        <div className="sketch-entity-fields">
          {fields.map(({ key, label }) => (
            <ExprInput
              key={key}
              label={label}
              value={values[key] ?? ''}
              scope={scope}
              quantity={{ documentUnits: units, dimension: 'length' }}
              onChange={(value) =>
                setValues((current) => ({ ...current, [key]: value }))
              }
            />
          ))}
        </div>
        {!valid && (
          <p className="form-error" role="alert">
            Enter a positive size.
          </p>
        )}
        <footer>
          <span className="muted">{composite.anchor}</span>
          <button
            type="submit"
            className="primary"
            disabled={!valid || disabled}
          >
            Resize
          </button>
        </footer>
      </fieldset>
    </form>
  );
}
