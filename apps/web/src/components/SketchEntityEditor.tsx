import { useState, type FormEvent } from 'react';
import { coerceParamValue, evaluateExpression } from '@openzcad/document-core';
import {
  MAX_SKETCH_ARC_SWEEP_DEGREES,
  MAX_SKETCH_POLYGON_SIDES,
  type SketchObjectData
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

/** A constraint tool the entity can start, with whether it is armed now. */
export interface EntityConstraintTool {
  kind: SketchConstraintToolKind;
  label: string;
  armed: boolean;
}

interface SketchEntityEditorProps {
  data: SketchObjectData;
  scope: Record<string, number>;
  disabled?: boolean;
  error?: string | null;
  onApply(data: SketchObjectData): void;
  onDelete(): void;
  onClose(): void;
  /**
   * The constraints section: what the entity is already held by, and what
   * can be added from it. Absent, the editor is the plain value form.
   */
  constraints?: EntityConstraintItem[];
  constraintTools?: EntityConstraintTool[];
  onConstraintTool?(kind: SketchConstraintToolKind): void;
  onEditConstraint?(
    constraintId: string,
    anchor: { x: number; y: number }
  ): void;
  onDeleteConstraint?(constraintId: string): void;
}

interface FieldDefinition {
  key: string;
  label: string;
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
    { key: 'sides', label: 'Sides' },
    { key: 'radius', label: 'Radius' },
    { key: 'centerX', label: 'Center X' },
    { key: 'centerY', label: 'Center Y' }
  ],
  arc: [
    { key: 'radius', label: 'Radius' },
    { key: 'centerX', label: 'Center X' },
    { key: 'centerY', label: 'Center Y' },
    { key: 'startAngleDeg', label: 'Start angle' },
    { key: 'endAngleDeg', label: 'End angle' }
  ],
  // Only the numeric fields. The string, family and style need a dedicated
  // editor (the text tool's form) rather than an expression input, so this
  // generic editor exposes what it can drive and leaves the rest alone.
  // Position and rotation place the text on the face being sketched; the
  // string, family and style are not expression fields and live in
  // `TextObjectFields` above the grid.
  text: [
    { key: 'size', label: 'Size' },
    { key: 'rotation', label: 'Rotation', fallback: '0' },
    { key: 'x', label: 'X' },
    { key: 'y', label: 'Y' }
  ]
};

function initialValues(data: SketchObjectData): Record<string, string> {
  return Object.fromEntries(
    FIELDS[data.objectKind].map(({ key, fallback }) => {
      const raw = (data as unknown as Record<string, string | number>)[key];
      return [key, raw === undefined ? (fallback ?? '') : String(raw)];
    })
  );
}

function nextData(
  data: SketchObjectData,
  values: Record<string, string>,
  text: TextAttributes | null
): SketchObjectData {
  const value = (key: string) => coerceParamValue(values[key] ?? '');
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
  scope: Record<string, number>
): string | null {
  let resolved: Record<string, number>;
  try {
    resolved = Object.fromEntries(
      FIELDS[kind].map(({ key }) => [
        key,
        evaluateExpression(values[key] ?? '', scope)
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
  disabled = false,
  error,
  onApply,
  onDelete,
  onClose,
  constraints,
  constraintTools,
  onConstraintTool,
  onEditConstraint,
  onDeleteConstraint
}: SketchEntityEditorProps) {
  const [values, setValues] = useState(() => initialValues(data));
  const [textAttrs, setTextAttrs] = useState<TextAttributes | null>(() =>
    data.objectKind === 'text'
      ? {
          text: data.text,
          fontFamily: data.fontFamily,
          fontStyle: data.fontStyle
        }
      : null
  );
  const fields = FIELDS[data.objectKind];
  const expressionsValid = fields.every(
    ({ key }) => previewExpression(values[key] ?? '', scope).ok
  );
  const semanticError = expressionsValid
    ? geometryError(data.objectKind, values, scope)
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
            {fields.map(({ key, label }) => (
              <ExprInput
                key={key}
                label={label}
                value={values[key] ?? ''}
                scope={scope}
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
        {error && <p role="alert">{error}</p>}
      </form>
      {constraintTools && constraintTools.length > 0 && (
        <section className="sketch-entity-constraints" aria-label="Constraints">
          <span className="eyebrow">Constraints</span>
          {Boolean(constraints?.length) && (
            <p className="muted">
              These constraints control this geometry. Edit a driving dimension
              below to change its constrained size.
            </p>
          )}
          <div
            className="sketch-entity-constraint-tools"
            role="group"
            aria-label="Add a constraint from this entity"
          >
            {constraintTools.map(({ kind, label, armed }) => {
              const Icon = CONSTRAINT_ICONS[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  className={armed ? 'active' : undefined}
                  aria-pressed={armed}
                  aria-label={`${label} constraint`}
                  title={`${label} constraint`}
                  onClick={() => onConstraintTool?.(kind)}
                >
                  <Icon size={14} aria-hidden="true" />
                </button>
              );
            })}
          </div>
          {constraints && constraints.length > 0 && (
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
          )}
        </section>
      )}
    </div>
  );
}
