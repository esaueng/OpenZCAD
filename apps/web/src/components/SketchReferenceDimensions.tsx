import { useState } from 'react';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  describeSketchReferenceDimension,
  resolveSketchReferenceDimension,
  toSketchReferenceAnnotationId,
  type EntityId,
  type SketchNode,
  type SketchObjectData,
  type SketchPointRef,
  type SketchReferenceDistanceMode,
  type SketchReferenceDimensionData
} from '@openzcad/shared';
import { formatNumber } from '../lib/model';

interface Props {
  sketch: SketchNode;
  objects: { id: string; label: string; data: SketchObjectData }[];
  units: string;
  resolve(value: number | string): number | undefined;
  disabled: boolean;
  onCommand(command: AnyCommand): void;
}

/** Saved measurements are a separate instrument, never a numeric edit form. */
export function SketchReferenceDimensions({
  sketch,
  objects,
  units,
  resolve,
  disabled,
  onCommand
}: Props) {
  const [kind, setKind] =
    useState<SketchReferenceDimensionData['dimensionKind']>('distance');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [distanceMode, setDistanceMode] =
    useState<SketchReferenceDistanceMode>('absolute');
  const namedObjects = objects.map((object, index) => ({
    ...object,
    label: objects.some(
      (other) => other.id !== object.id && other.label === object.label
    )
      ? `${object.label} (position ${index + 1})`
      : object.label
  }));
  const points = namedObjects.flatMap((object) => {
    const roles: SketchPointRef['point'][] =
      object.data.objectKind === 'line'
        ? ['start', 'end']
        : object.data.objectKind === 'arc'
          ? ['center', 'start', 'end']
          : object.data.objectKind === 'circle'
            ? ['center']
            : [];
    return roles.map((point) => ({
      key: JSON.stringify({ objectId: object.id, point }),
      label: `${object.label}.${point}`
    }));
  });
  const entities = namedObjects
    .filter((o) =>
      kind === 'angle'
        ? o.data.objectKind === 'line'
        : o.data.objectKind === 'circle' || o.data.objectKind === 'arc'
    )
    .map((o) => ({ key: o.id, label: o.label }));
  const options = kind === 'distance' ? points : entities;
  const a = options.some((o) => o.key === first) ? first : '';
  const b = options.some((o) => o.key === second) ? second : '';
  const data: SketchReferenceDimensionData | null =
    !a || (kind !== 'radius' && !b)
      ? null
      : kind === 'distance'
        ? {
            dimensionKind: kind,
            ...(distanceMode !== 'absolute' ? { distanceMode } : {}),
            a: JSON.parse(a) as SketchPointRef,
            b: JSON.parse(b) as SketchPointRef
          }
        : kind === 'radius'
          ? { dimensionKind: kind, objectId: a as EntityId }
          : { dimensionKind: kind, a: a as EntityId, b: b as EntityId };
  const byId = new Map(objects.map((o) => [o.id as EntityId, o.data]));
  const candidate = data
    ? resolveSketchReferenceDimension(
        byId,
        { annotationId: toSketchReferenceAnnotationId('sref_candidate'), data },
        resolve
      )
    : null;
  const valueText = (
    outcome: ReturnType<typeof resolveSketchReferenceDimension>
  ) =>
    outcome.status === 'unresolved'
      ? 'Unresolved'
      : outcome.dimensionKind === 'angle'
        ? `${formatNumber(outcome.valueDeg)}°`
        : `${formatNumber(outcome.value)} ${units === 'inch' ? 'in' : units}`;
  const nameOf = (id: EntityId) =>
    namedObjects.find((o) => o.id === id)?.label ?? String(id);
  return (
    <fieldset className="sketch-reference-dimensions" disabled={disabled}>
      <legend>Reference dimensions</legend>
      <p>
        Saved measured values. They do not constrain geometry. Horizontal and
        vertical distances follow the sketch axes.
      </p>
      <label>
        Reference type
        <select
          value={kind}
          onChange={(event) => {
            setKind(event.currentTarget.value as typeof kind);
            setFirst('');
            setSecond('');
          }}
        >
          <option value="distance">Distance</option>
          <option value="radius">Radius</option>
          <option value="angle">Angle</option>
        </select>
      </label>
      {kind === 'distance' ? (
        <label>
          Distance type
          <select
            value={distanceMode}
            onChange={(event) =>
              setDistanceMode(
                event.currentTarget.value as SketchReferenceDistanceMode
              )
            }
          >
            <option value="absolute">Absolute</option>
            <option value="horizontal">Horizontal</option>
            <option value="vertical">Vertical</option>
          </select>
        </label>
      ) : null}
      <label>
        {kind === 'radius' ? 'Reference geometry' : 'Reference from'}
        <select
          value={a}
          onChange={(event) => setFirst(event.currentTarget.value)}
        >
          <option value="">
            Choose {kind === 'distance' ? 'point' : 'geometry'}
          </option>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {kind !== 'radius' ? (
        <label>
          Reference to
          <select
            value={b}
            onChange={(event) => setSecond(event.currentTarget.value)}
          >
            <option value="">
              Choose {kind === 'distance' ? 'point' : 'line'}
            </option>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {candidate ? (
        <p role="status">
          {candidate.status === 'current'
            ? `Measured: ${valueText(candidate)}`
            : candidate.reason.replace(
                'Reference dimension "sref_candidate": ',
                ''
              )}
        </p>
      ) : (
        <p>Choose targets to add a reference.</p>
      )}
      <button
        type="button"
        disabled={candidate?.status !== 'current'}
        onClick={() => {
          if (data && candidate?.status === 'current')
            onCommand(
              commandFactories.addSketchReferenceDimension({
                sketchId: sketch.sketchId,
                data
              })
            );
        }}
      >
        Add reference
      </button>
      <ul>
        {(sketch.referenceDimensions ?? []).map((reference) => {
          const outcome = resolveSketchReferenceDimension(
            byId,
            reference,
            resolve
          );
          const description = describeSketchReferenceDimension(
            reference.data,
            nameOf
          );
          return (
            <li key={reference.annotationId} aria-label={description}>
              <span>{description}</span>
              <output aria-label={description + ' measured value'}>
                {valueText(outcome)} · Reference
              </output>
              {outcome.status === 'unresolved' ? (
                <p role="status">{outcome.reason}</p>
              ) : null}
              <button
                type="button"
                aria-label={`Delete ${description}`}
                onClick={() =>
                  onCommand(
                    commandFactories.deleteSketchReferenceDimension({
                      sketchId: sketch.sketchId,
                      annotationId: reference.annotationId
                    })
                  )
                }
              >
                Delete reference
              </button>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
