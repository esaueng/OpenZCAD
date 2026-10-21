import { useEffect, useMemo, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { newCanonicalPlaneRef } from '@openzcad/geometry';
import {
  calibratedReferenceImageWidth,
  MAX_REFERENCE_IMAGE_EXTENT,
  MAX_REFERENCE_IMAGE_NAME_LENGTH,
  MIN_REFERENCE_IMAGE_OPACITY,
  referenceImageHeight,
  type FeatureNode,
  type ProjectDocument,
  type ReferenceImage,
  type ReferenceImagePlane,
  type UnitSystem
} from '@openzcad/shared';
import type { ReferenceImageUpdateInput } from '@openzcad/document-core';
import { CardHeader } from '../CardHeader';
import { PanelOverflow } from '../PanelOverflow';
import { PLANE_LABELS } from '../../lib/model';

/**
 * I05: the card for one reference image — its plane, position, turn, width
 * and opacity, plus a two-point scale against a known distance. Every field
 * is a draft the viewport follows as it is typed; Done applies the changes as
 * one undoable edit and Cancel drops them.
 */

export interface ReferenceImageCardProps {
  document: ProjectDocument;
  image: ReferenceImage;
  /**
   * Datum planes the image may lie on. One that has not resolved is still
   * listed — the image on it draws nothing until it does.
   */
  datumPlanes: readonly FeatureNode[];
  /**
   * The plane of the face selected in the viewport, when it is a flat face
   * an image can lie on; a reason when it is not; null with no face picked.
   */
  selectedFacePlane: ReferenceImagePlane | { reason: string } | null;
  /** The picture's bytes, for the two-point scale; null when unavailable. */
  loadPicture(): Promise<Blob | null>;
  editDisabledReason: string | null;
  onDraft(image: ReferenceImage | null): void;
  onApply(update: ReferenceImageUpdateInput): boolean;
  onDelete(): void;
  onClose(): void;
}

type PlaneChoice = string;

function planeChoiceOf(plane: ReferenceImagePlane): PlaneChoice {
  if (plane.type === 'canonical') return `canonical:${plane.plane}`;
  if (plane.type === 'datum') return `datum:${plane.datumFeatureId}`;
  return 'stored-face';
}

function numberText(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

interface DraftText {
  name: string;
  u: string;
  v: string;
  offset: string;
  rotation: string;
  width: string;
}

function draftTextOf(image: ReferenceImage): DraftText {
  return {
    name: image.name,
    u: numberText(image.center.u),
    v: numberText(image.center.v),
    offset: numberText(
      image.plane.type === 'canonical' ? image.plane.offset : 0
    ),
    rotation: numberText(image.rotationDeg),
    width: numberText(image.width)
  };
}

function finite(text: string, bound = MAX_REFERENCE_IMAGE_EXTENT) {
  const value = Number(text.trim());
  return text.trim() !== '' &&
    Number.isFinite(value) &&
    Math.abs(value) <= bound
    ? value
    : null;
}

export function ReferenceImageWorkspaceCard({
  document,
  image,
  datumPlanes,
  selectedFacePlane,
  loadPicture,
  editDisabledReason,
  onDraft,
  onApply,
  onDelete,
  onClose
}: ReferenceImageCardProps) {
  const [text, setText] = useState<DraftText>(() => draftTextOf(image));
  const [plane, setPlane] = useState<ReferenceImagePlane>(image.plane);
  const [opacity, setOpacity] = useState(image.opacity);
  const units: UnitSystem = document.units;

  const name = text.name.trim();
  const u = finite(text.u);
  const v = finite(text.v);
  const offset = finite(text.offset);
  const rotation = finite(text.rotation, 360);
  const width = finite(text.width);
  const problem =
    name.length === 0
      ? 'Name the image.'
      : name.length > MAX_REFERENCE_IMAGE_NAME_LENGTH
        ? `Use at most ${MAX_REFERENCE_IMAGE_NAME_LENGTH} characters.`
        : u === null || v === null
          ? 'Position needs two numbers.'
          : // Only a principal plane has an offset: a hidden field left
            // invalid there must not block an image on a datum or face.
            plane.type === 'canonical' && offset === null
            ? 'Offset needs a number.'
            : rotation === null
              ? 'Rotation must be between −360° and 360°.'
              : width === null || width <= 0
                ? 'Width must be a positive number.'
                : null;

  const placed: ReferenceImagePlane =
    plane.type === 'canonical' && offset !== null
      ? { ...plane, offset }
      : plane;
  const draft: ReferenceImage | null =
    problem === null
      ? {
          ...image,
          name,
          plane: placed,
          center: { u: u!, v: v! },
          rotationDeg: rotation!,
          width: width!,
          opacity
        }
      : null;
  const draftKey = JSON.stringify(draft);
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  useEffect(() => {
    onDraftRef.current(
      draftKey === 'null' ? null : (JSON.parse(draftKey) as ReferenceImage)
    );
  }, [draftKey]);
  useEffect(() => () => onDraftRef.current(null), []);

  const changes = useMemo((): ReferenceImageUpdateInput | null => {
    if (!draft) return null;
    const update: ReferenceImageUpdateInput = { imageId: image.imageId };
    if (draft.name !== image.name) update.name = draft.name;
    if (JSON.stringify(draft.plane) !== JSON.stringify(image.plane))
      update.plane = draft.plane;
    if (draft.center.u !== image.center.u || draft.center.v !== image.center.v)
      update.center = draft.center;
    if (draft.rotationDeg !== image.rotationDeg)
      update.rotationDeg = draft.rotationDeg;
    if (draft.width !== image.width) update.width = draft.width;
    if (draft.opacity !== image.opacity) update.opacity = draft.opacity;
    return update;
    // The draft is rebuilt every render; its key is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, image]);
  const changed = changes !== null && Object.keys(changes).length > 1;

  const choice = planeChoiceOf(plane);
  const choosePlane = (next: string) => {
    if (next === 'stored-face') return;
    if (next === 'selected-face') {
      if (selectedFacePlane && !('reason' in selectedFacePlane))
        setPlane(selectedFacePlane);
      return;
    }
    const [kind, id] = next.split(':') as [string, string];
    if (kind === 'canonical') {
      const ref = newCanonicalPlaneRef(id as 'XY' | 'XZ' | 'YZ', 0);
      setPlane({ ...ref, offset: 0 });
      setText((current) => ({ ...current, offset: '0' }));
    } else if (kind === 'datum') {
      setPlane({
        type: 'datum',
        datumFeatureId: id as FeatureNode['featureId']
      });
    }
  };

  const apply = () => {
    if (!changes || editDisabledReason) return;
    if (!changed) {
      onClose();
      return;
    }
    if (onApply(changes)) onClose();
  };

  return (
    <section
      className="inspector"
      aria-label="Feature inspector"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <CardHeader
        title={image.name}
        eyebrow="Reference image"
        actions={
          <PanelOverflow>
            <button
              type="button"
              className="panel-overflow-item danger"
              disabled={editDisabledReason !== null}
              onClick={onDelete}
            >
              <Trash2 size={13} aria-hidden="true" />
              Delete image
            </button>
          </PanelOverflow>
        }
        closeTitle="Close"
        closeLabel="Close panel"
        onClose={onClose}
      />
      <div className="panel-body">
        <form
          className="feature-form"
          // The card checks its own fields; a browser's step check on the
          // opacity slider must not swallow Enter.
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <label className="field">
            <span>Name</span>
            <input
              value={text.name}
              onChange={(event) =>
                setText({ ...text, name: event.target.value })
              }
            />
          </label>
          <label className="field">
            <span>Plane</span>
            <select
              value={choice}
              onChange={(event) => choosePlane(event.target.value)}
            >
              {(['XY', 'XZ', 'YZ'] as const).map((id) => (
                <option key={id} value={`canonical:${id}`}>
                  {PLANE_LABELS[id]}
                </option>
              ))}
              {datumPlanes.map((datum) => (
                <option
                  key={datum.featureId}
                  value={`datum:${datum.featureId}`}
                >
                  {datum.name}
                </option>
              ))}
              {plane.type === 'face' || plane.type === 'frame' ? (
                <option value="stored-face">
                  {plane.type === 'face' ? 'Face' : 'Face (fixed)'}
                </option>
              ) : null}
              {selectedFacePlane && !('reason' in selectedFacePlane) ? (
                <option value="selected-face">Selected face</option>
              ) : null}
            </select>
          </label>
          {plane.type === 'datum' &&
          !document.derived.datumFrames?.[plane.datumFeatureId] ? (
            <p className="muted">
              This plane has not resolved, so the image is not drawn until it
              does.
            </p>
          ) : null}
          {selectedFacePlane && 'reason' in selectedFacePlane ? (
            <p className="muted">{selectedFacePlane.reason}</p>
          ) : plane.type === 'frame' ? (
            <p className="muted">
              This face has no identity a rebuild can find again, so the image
              stays where it was placed if the face moves.
            </p>
          ) : null}
          {plane.type === 'canonical' ? (
            <label className="field">
              <span>{`Offset (${units})`}</span>
              <input
                inputMode="decimal"
                value={text.offset}
                onChange={(event) =>
                  setText({ ...text, offset: event.target.value })
                }
              />
            </label>
          ) : null}
          <label className="field">
            <span>{`Position U (${units})`}</span>
            <input
              inputMode="decimal"
              value={text.u}
              onChange={(event) => setText({ ...text, u: event.target.value })}
            />
          </label>
          <label className="field">
            <span>{`Position V (${units})`}</span>
            <input
              inputMode="decimal"
              value={text.v}
              onChange={(event) => setText({ ...text, v: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Rotation (°)</span>
            <input
              inputMode="decimal"
              value={text.rotation}
              onChange={(event) =>
                setText({ ...text, rotation: event.target.value })
              }
            />
          </label>
          <label className="field">
            <span>{`Width (${units})`}</span>
            <input
              inputMode="decimal"
              value={text.width}
              onChange={(event) =>
                setText({ ...text, width: event.target.value })
              }
            />
          </label>
          <p className="muted">
            {draft
              ? `Height ${numberText(referenceImageHeight(draft))} ${units} · ${image.pixelWidth} × ${image.pixelHeight} px`
              : `${image.pixelWidth} × ${image.pixelHeight} px`}
          </p>
          <label className="appearance-field">
            <span>Opacity</span>
            <span className="appearance-inputs">
              <input
                type="range"
                aria-label="Image opacity"
                min={MIN_REFERENCE_IMAGE_OPACITY}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(event) => setOpacity(Number(event.target.value))}
              />
              <span className="appearance-value">
                {Math.round(opacity * 100)}%
              </span>
            </span>
          </label>
          <TwoPointScale
            image={image}
            units={units}
            loadPicture={loadPicture}
            onScale={(scaled) =>
              setText((current) => ({ ...current, width: numberText(scaled) }))
            }
          />
          {problem ? (
            <p className="field-error" aria-live="polite">
              {problem}
            </p>
          ) : null}
          <div className="form-footer">
            <div className="form-actions">
              <button
                type="submit"
                className="primary"
                disabled={!draft || editDisabledReason !== null}
                aria-keyshortcuts="Enter"
              >
                Done
              </button>
              <button type="button" className="secondary" onClick={onClose}>
                Cancel
              </button>
            </div>
            {editDisabledReason ? (
              <p className="field-error" role="alert">
                {editDisabledReason}
              </p>
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
}

interface PickedPoint {
  /** In the picture's own pixels, from its top-left corner. */
  x: number;
  y: number;
}

/**
 * Scale by two points: the user clicks two points on the picture whose real
 * distance they know and types that distance; the image takes the width that
 * makes the picked span measure it. Picked on the flat picture rather than in
 * the viewport, so neither the camera nor the image's current size changes
 * what the picks mean.
 */
function TwoPointScale({
  image,
  units,
  loadPicture,
  onScale
}: {
  image: ReferenceImage;
  units: UnitSystem;
  loadPicture(): Promise<Blob | null>;
  onScale(width: number): void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [points, setPoints] = useState<PickedPoint[]>([]);
  const [distance, setDistance] = useState('');
  const loadRef = useRef(loadPicture);
  loadRef.current = loadPicture;

  // Loaded again whenever the picture's location changes: a device-only
  // picture archived by its owner while the scaler is open becomes readable.
  const location = image.artifactId;
  useEffect(() => {
    if (!open) return;
    let live = true;
    let created: string | null = null;
    setMissing(false);
    void loadRef.current().then(
      (blob) => {
        if (!live) return;
        if (!blob) {
          setMissing(true);
          return;
        }
        // An object URL, never a data URL: the CSP allows `blob:` images.
        created = URL.createObjectURL(blob);
        setUrl(created);
        setMissing(false);
      },
      () => live && setMissing(true)
    );
    return () => {
      live = false;
      if (created) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [open, location]);

  const known = Number(distance.trim());
  const width =
    points.length === 2 && distance.trim() !== ''
      ? calibratedReferenceImageWidth(image, points[0]!, points[1]!, known)
      : null;
  const picked =
    points.length === 2
      ? Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y)
      : 0;

  if (!open) {
    return (
      <button
        type="button"
        className="secondary"
        onClick={() => {
          setPoints([]);
          setOpen(true);
        }}
      >
        Scale from two points…
      </button>
    );
  }
  return (
    <fieldset className="reference-image-calibration">
      <legend>Scale from two points</legend>
      {missing ? (
        <p className="field-error">
          The picture is not available on this device.
        </p>
      ) : (
        <>
          <p className="muted">
            {points.length < 2
              ? `Click point ${points.length + 1} of 2 on the picture.`
              : `Picked ${Math.round(picked)} px apart. Type their real distance.`}
          </p>
          <div className="reference-image-pick">
            {url ? (
              <img
                src={url}
                alt={`${image.name}: click two points a known distance apart`}
                draggable={false}
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  if (box.width <= 0 || box.height <= 0) return;
                  const point = {
                    x:
                      ((event.clientX - box.left) / box.width) *
                      image.pixelWidth,
                    y:
                      ((event.clientY - box.top) / box.height) *
                      image.pixelHeight
                  };
                  setPoints((current) =>
                    current.length >= 2 ? [point] : [...current, point]
                  );
                }}
              />
            ) : (
              <p className="muted" role="status">
                Loading the picture…
              </p>
            )}
            {points.map((point, index) => (
              <span
                key={index}
                className="reference-image-marker"
                aria-hidden="true"
                style={{
                  left: `${(point.x / image.pixelWidth) * 100}%`,
                  top: `${(point.y / image.pixelHeight) * 100}%`
                }}
              />
            ))}
          </div>
          <label className="field">
            <span>{`Known distance (${units})`}</span>
            <input
              inputMode="decimal"
              value={distance}
              disabled={points.length < 2}
              onChange={(event) => setDistance(event.target.value)}
            />
          </label>
          {points.length === 2 && distance.trim() !== '' && width === null ? (
            <p className="field-error">
              Pick two different points and a positive distance.
            </p>
          ) : null}
        </>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="secondary"
          disabled={width === null}
          onClick={() => {
            if (width === null) return;
            onScale(width);
            setOpen(false);
          }}
        >
          Scale image
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => setOpen(false)}
        >
          Cancel scaling
        </button>
      </div>
    </fieldset>
  );
}
