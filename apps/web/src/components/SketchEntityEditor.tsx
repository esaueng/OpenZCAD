import { useState, type FormEvent } from 'react';
import { coerceParamValue, evaluateExpression } from '@openzcad/document-core';
import type { SketchObjectData } from '@openzcad/shared';
import { Trash2, X } from 'lucide-react';
import { ExprInput } from './ExprInput';
import { previewExpression } from '../lib/model';

interface SketchEntityEditorProps {
  data: SketchObjectData;
  scope: Record<string, number>;
  onApply(data: SketchObjectData): void;
  onDelete(): void;
  onClose(): void;
}

interface FieldDefinition {
  key: string;
  label: string;
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
  text: [
    { key: 'size', label: 'Size' },
    { key: 'x', label: 'X' },
    { key: 'y', label: 'Y' }
  ]
};

function initialValues(data: SketchObjectData): Record<string, string> {
  return Object.fromEntries(
    FIELDS[data.objectKind].map(({ key }) => [
      key,
      String((data as unknown as Record<string, string | number>)[key] ?? '')
    ])
  );
}

function nextData(
  data: SketchObjectData,
  values: Record<string, string>
): SketchObjectData {
  const value = (key: string) => coerceParamValue(values[key] ?? '');
  const kind = data.objectKind;
  switch (kind) {
    case 'text':
      // Every case spreads `...data` first. The fields this editor exposes
      // are then overwritten, and everything else survives — the `text`,
      // `fontFamily` and `fontStyle` of a text object, which are not
      // expression fields, and `construction` on any kind. Rebuilding a fresh
      // object literal instead silently un-marked construction geometry the
      // moment its radius was edited.
      return {
        ...data,
        objectKind: kind,
        size: value('size'),
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
    (!Number.isInteger(resolved.sides) || resolved.sides! < 3)
  ) {
    return 'Polygon sides must be an integer of at least 3.';
  }
  if (
    kind === 'line' &&
    Math.hypot(resolved.x2! - resolved.x1!, resolved.y2! - resolved.y1!) < 0.5
  ) {
    return 'Line endpoints must be at least 0.5 units apart.';
  }
  const arcSweep =
    kind === 'arc'
      ? Math.abs((resolved.endAngleDeg! - resolved.startAngleDeg!) % 360)
      : null;
  if (arcSweep !== null && (arcSweep < 1 || 360 - arcSweep < 1)) {
    return 'Arc sweep must be at least 1 degree.';
  }
  return null;
}

/** Exact-value editor for the entity selected inside an active sketch. */
export function SketchEntityEditor({
  data,
  scope,
  onApply,
  onDelete,
  onClose
}: SketchEntityEditorProps) {
  const [values, setValues] = useState(() => initialValues(data));
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
    if (valid) {
      onApply(nextData(data, values));
    }
  }

  return (
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
        <button type="button" className="secondary danger" onClick={onDelete}>
          <Trash2 size={13} aria-hidden="true" />
          Delete
        </button>
        <button type="submit" className="primary" disabled={!valid}>
          Apply
        </button>
      </footer>
    </form>
  );
}
