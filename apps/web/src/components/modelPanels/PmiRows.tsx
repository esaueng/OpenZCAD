import { useEffect, useMemo, useState } from 'react';
import { Anchor, Columns3, Crosshair, Trash2 } from 'lucide-react';
import {
  DRAWING_CHARACTERISTIC_LABELS,
  DRAWING_DATUM_MATERIAL_CHARACTERISTICS,
  DRAWING_DATUM_REQUIRED_CHARACTERISTICS,
  DRAWING_DIAMETER_ZONE_CHARACTERISTICS,
  DRAWING_FORM_CHARACTERISTICS,
  DRAWING_GEOMETRIC_CHARACTERISTICS,
  DRAWING_MATERIAL_CHARACTERISTICS,
  MAX_DRAWING_DATUM_REFERENCES,
  modelPmiSurfaceError,
  type DrawingGeometricCharacteristic,
  type DrawingMaterialCondition,
  type FaceGeometry,
  type GeometryBodyRepresentation,
  type BodyId,
  type ModelPmiAnnotation,
  type ModelPmiId,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';
import { commandFactories } from '@openzcad/command-system';
import {
  draftModelPmi,
  faceAnchor,
  modelPmiName,
  pmiFaceRef,
  PMI_DATUM_SLOTS,
  resolveModelPmi,
  type ModelPmiResolution
} from '../../lib/pmi/modelPmi';
import type { AnyCommand } from '@openzcad/command-system';
import {
  setSelectedPmiId,
  usePmiSelection,
  type PmiFacePick,
  type PmiSelectionState
} from '../../lib/pmi/pmiSelection';

const DATUM_LETTERS = [...'ABCDEFGHJKLMNPRSTUVWXYZ'];
const PRECEDENCE = PMI_DATUM_SLOTS;

type Frame = Extract<ModelPmiAnnotation, { kind: 'feature-control-frame' }>;

/**
 * D07 slice C: the model's PMI in Objects. A face selected in the viewport
 * can take a datum feature or a feature control frame; each entry lists
 * under it with its state (broken when its face no longer resolves), and
 * the selected one opens its fields. Every change is one undoable command.
 */
/** The workspace's command runner, and where the rows say what happened. */
interface PmiWorkspace {
  execute(command: AnyCommand): boolean;
  status(message: string): void;
}

/** What the rows and their editor read and do. */
interface PmiRowActions {
  selectedFace: PmiFacePick | null;
  selectedPmiId: string | null;
  /** The document's units, which a frame's tolerance is written in. */
  units: UnitSystem;
  /** False where the model cannot be edited: rows list, nothing changes. */
  editable: boolean;
  onSelect(pmiId: string | null): void;
  onAdd(kind: ModelPmiAnnotation['kind']): void;
  onUpdate(
    annotation: ModelPmiAnnotation,
    label: string,
    options?: { followReferences?: true }
  ): void;
  onDelete(pmiId: string): void;
  /** Re-points an entry at the selected face, keeping the rest. */
  onRepick(pmiId: string): void;
}

/**
 * The selected face as a stored reference, and where its leader lands: the
 * point it was clicked at, or its centre. Null (and said) when the face
 * cannot be told apart from another.
 */
function pickedFace(
  document: ProjectDocument | undefined,
  selected: PmiFacePick | null,
  workspace: PmiWorkspace
) {
  if (!document || !selected) return null;
  const bodies = document.derived.bodyRepresentations;
  const face = pmiFaceRef(bodies, selected.bodyId as BodyId, selected.hash);
  const topology = bodies[selected.bodyId as BodyId]?.topology?.faces.find(
    (candidate) => candidate.hash === selected.hash
  );
  const anchor = selected.point ?? (topology ? faceAnchor(topology) : null);
  if (!face || !anchor) {
    workspace.status(
      'That face cannot be told apart from another one in the model. Pick a different face.'
    );
    return null;
  }
  return { face, anchor, geometry: topology?.geometry };
}

function rowActions(
  document: ProjectDocument | undefined,
  selection: PmiSelectionState,
  editable: boolean,
  workspace: PmiWorkspace
): PmiRowActions {
  return {
    selectedFace: selection.face,
    selectedPmiId: selection.selectedPmiId,
    units: document?.units ?? 'mm',
    editable,
    onSelect: setSelectedPmiId,
    onAdd(kind) {
      const pick = pickedFace(document, selection.face, workspace);
      if (!pick || !document) return;
      const annotation = draftModelPmi(
        kind,
        pick.face,
        pick.anchor,
        document.pmi,
        document.units,
        pick.geometry
      );
      if (workspace.execute(commandFactories.addModelPmi({ annotation }))) {
        setSelectedPmiId(annotation.pmiId);
        workspace.status(
          annotation.kind === 'datum-feature'
            ? `Datum ${annotation.letter} added to the face.`
            : 'Feature control frame added. Choose its characteristic, tolerance and datums in Objects.'
        );
      }
    },
    onUpdate(annotation, label, options) {
      workspace.execute(
        commandFactories.updateModelPmi({ annotation, ...options }, label)
      );
    },
    onDelete(pmiId) {
      if (
        workspace.execute(
          commandFactories.deleteModelPmi({ pmiId: pmiId as ModelPmiId })
        ) &&
        selection.selectedPmiId === pmiId
      )
        setSelectedPmiId(null);
    },
    onRepick(pmiId) {
      const pick = pickedFace(document, selection.face, workspace);
      const previous = document?.pmi?.annotations.find(
        (entry) => entry.pmiId === pmiId
      );
      if (!pick || !previous) return;
      // #2321: a frame never moves to a face its characteristic cannot
      // control (cylindricity to a flat cap).
      const surface =
        previous.kind === 'feature-control-frame'
          ? modelPmiSurfaceError(
              previous.characteristic,
              pick.geometry?.surfaceType
            )
          : null;
      if (surface) {
        workspace.status(
          `${surface} Pick a face it applies to, or change the characteristic first.`
        );
        return;
      }
      workspace.execute(
        commandFactories.updateModelPmi(
          {
            annotation: { ...previous, face: pick.face, anchor: pick.anchor }
          },
          'Re-pick PMI face'
        )
      );
    }
  };
}

export function PmiRows(props: {
  document: ProjectDocument | undefined;
  representations: Readonly<Record<string, GeometryBodyRepresentation>>;
  bodyNames: ReadonlyMap<string, string>;
  editable: boolean;
  onCommand(command: AnyCommand): boolean;
}) {
  const pmi = props.document?.pmi;
  const selection = usePmiSelection();
  const [message, setMessage] = useState<string | null>(null);
  const actions = rowActions(props.document, selection, props.editable, {
    execute: props.onCommand,
    status: setMessage
  });
  const annotations = pmi?.annotations ?? [];
  const resolutions = useMemo(
    () => resolveModelPmi(pmi, props.representations),
    [pmi, props.representations]
  );
  const letters = annotations.flatMap((entry) =>
    entry.kind === 'datum-feature' ? [entry.letter] : []
  );
  return (
    <>
      {message ? (
        <p className="pmi-hint pmi-message" role="status">
          {message}
        </p>
      ) : null}
      {actions.selectedFace && actions.editable ? (
        <div className="object-row pmi-add" role="listitem">
          <span className="pmi-add-label">Selected face:</span>
          <button
            type="button"
            className="secondary"
            onClick={() => actions.onAdd('datum-feature')}
          >
            <Anchor size={12} aria-hidden="true" /> Datum feature
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => actions.onAdd('feature-control-frame')}
          >
            <Columns3 size={12} aria-hidden="true" /> Feature control frame
          </button>
        </div>
      ) : null}
      {annotations.map((annotation) => {
        const resolution = resolutions.get(annotation.pmiId);
        const broken = resolution && !resolution.ok;
        const selected = actions.selectedPmiId === annotation.pmiId;
        const name = modelPmiName(annotation);
        const body = props.bodyNames.get(annotation.face.bodyId) ?? 'a body';
        return (
          <div
            key={annotation.pmiId}
            className={`object-row pmi-row${selected ? ' selected' : ''}${broken ? ' is-broken' : ''}`}
            role="listitem"
          >
            <button
              type="button"
              className="body-row-main"
              aria-pressed={selected}
              title={`${name} on ${body}${broken ? ` — broken: ${resolution.message}` : ''}`}
              onClick={() =>
                actions.onSelect(selected ? null : annotation.pmiId)
              }
            >
              <span className="feature-icon">
                {annotation.kind === 'datum-feature' ? (
                  <Anchor size={13} aria-hidden="true" />
                ) : (
                  <Columns3 size={13} aria-hidden="true" />
                )}
              </span>
              <span className="feature-name">
                {name}
                {broken ? ' (broken)' : ''}
              </span>
            </button>
            {actions.editable ? (
              <button
                type="button"
                className="row-visibility"
                aria-label={`Delete ${name}`}
                title={`Delete ${name}`}
                onClick={() => actions.onDelete(annotation.pmiId)}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            ) : null}
            {selected ? (
              <PmiEditor
                annotation={annotation}
                letters={letters}
                resolution={resolution}
                actions={actions}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/** How to repair a broken entry: each cause has its own remedy (#2260). */
function brokenGuidance(
  resolution: Extract<ModelPmiResolution, { ok: false }>
): string {
  switch (resolution.reason) {
    case 'datum-undefined':
      return `${resolution.message} Or delete the frame.`;
    case 'surface-incompatible':
      return `${resolution.message} Select a face it applies to and move it there, choose another characteristic, or delete it.`;
    default:
      return `${resolution.message} Select its face and re-pick, or delete it.`;
  }
}

function PmiEditor(props: {
  annotation: ModelPmiAnnotation;
  letters: string[];
  resolution: ModelPmiResolution | undefined;
  actions: PmiRowActions;
}) {
  const { annotation, actions, resolution } = props;
  const disabled = !actions.editable;
  return (
    <div className="pmi-editor">
      {resolution && !resolution.ok ? (
        <p className="pmi-broken" role="alert">
          Broken: {brokenGuidance(resolution)}
        </p>
      ) : null}
      {annotation.kind === 'datum-feature' ? (
        <label className="pmi-field">
          <span>Letter</span>
          <select
            value={annotation.letter}
            disabled={disabled}
            onChange={(event) =>
              // #2375: the frames naming this datum follow its new letter.
              actions.onUpdate(
                { ...annotation, letter: event.target.value },
                'Change datum letter',
                { followReferences: true }
              )
            }
          >
            {DATUM_LETTERS.filter(
              (letter) =>
                letter === annotation.letter || !props.letters.includes(letter)
            ).map((letter) => (
              <option key={letter} value={letter}>
                {letter}
              </option>
            ))}
            {DATUM_LETTERS.includes(annotation.letter) ? null : (
              <option value={annotation.letter}>{annotation.letter}</option>
            )}
          </select>
        </label>
      ) : (
        <FrameFields
          frame={annotation}
          geometry={resolution?.face?.geometry}
          letters={props.letters}
          units={actions.units}
          disabled={disabled}
          onUpdate={actions.onUpdate}
        />
      )}
      {actions.editable ? (
        <button
          type="button"
          className="secondary"
          disabled={!actions.selectedFace}
          title={
            actions.selectedFace
              ? 'Put this on the face selected in the viewport'
              : 'Select a face in the viewport first'
          }
          onClick={() => actions.onRepick(annotation.pmiId)}
        >
          <Crosshair size={12} aria-hidden="true" /> Move to selected face
        </button>
      ) : null}
    </div>
  );
}

function FrameFields(props: {
  frame: Frame;
  /**
   * The resolved face's geometry, also while the frame is broken for a
   * reason other than its face: some characteristics need its surface.
   */
  geometry: FaceGeometry | undefined;
  letters: string[];
  units: string;
  disabled: boolean;
  onUpdate: (annotation: ModelPmiAnnotation, label: string) => void;
}) {
  const { frame, disabled } = props;
  const declared = [...props.letters].sort(
    (a, b) => a.length - b.length || a.localeCompare(b)
  );
  const datums = frame.datums ?? [];
  const required = DRAWING_DATUM_REQUIRED_CHARACTERISTICS.includes(
    frame.characteristic
  );
  const withDatums = (list: Frame['datums'] & object) => {
    const { datums: _previous, ...rest } = frame;
    return list.length ? { ...rest, datums: list } : rest;
  };
  const chooseCharacteristic = (
    characteristic: DrawingGeometricCharacteristic
  ) => {
    const { diameterZone, material, datums: previous, ...rest } = frame;
    const keepModifiers =
      DRAWING_DATUM_MATERIAL_CHARACTERISTICS.includes(characteristic);
    const next = DRAWING_FORM_CHARACTERISTICS.includes(characteristic)
      ? []
      : (previous ?? []).map((reference) =>
          keepModifiers ? reference : { letter: reference.letter }
        );
    if (
      next.length === 0 &&
      DRAWING_DATUM_REQUIRED_CHARACTERISTICS.includes(characteristic) &&
      declared[0]
    )
      next.push({ letter: declared[0] });
    props.onUpdate(
      {
        ...rest,
        characteristic,
        ...(diameterZone &&
        DRAWING_DIAMETER_ZONE_CHARACTERISTICS.includes(characteristic)
          ? { diameterZone }
          : {}),
        ...(material &&
        DRAWING_MATERIAL_CHARACTERISTICS.includes(characteristic)
          ? { material }
          : {}),
        ...(next.length ? { datums: next } : {})
      },
      'Change frame characteristic'
    );
  };
  return (
    <>
      <label className="pmi-field">
        <span>Characteristic</span>
        <select
          value={frame.characteristic}
          disabled={disabled}
          onChange={(event) =>
            chooseCharacteristic(
              event.target.value as DrawingGeometricCharacteristic
            )
          }
        >
          {DRAWING_GEOMETRIC_CHARACTERISTICS.map((characteristic) => (
            <option
              key={characteristic}
              value={characteristic}
              disabled={
                (declared.length === 0 &&
                  DRAWING_DATUM_REQUIRED_CHARACTERISTICS.includes(
                    characteristic
                  )) ||
                // #2321: not one that cannot control this face.
                (characteristic !== frame.characteristic &&
                  modelPmiSurfaceError(
                    characteristic,
                    props.geometry?.surfaceType
                  ) !== null)
              }
            >
              {DRAWING_CHARACTERISTIC_LABELS[characteristic]}
              {characteristic === 'concentricity' ||
              characteristic === 'symmetry'
                ? ' (ISO 1101)'
                : ''}
            </option>
          ))}
        </select>
      </label>
      <AmountField
        value={frame.amount}
        units={props.units}
        disabled={disabled}
        onCommit={(amount) =>
          props.onUpdate({ ...frame, amount }, 'Change frame tolerance')
        }
      />
      <label className="pmi-check">
        <input
          type="checkbox"
          checked={frame.diameterZone === true}
          disabled={
            disabled ||
            !DRAWING_DIAMETER_ZONE_CHARACTERISTICS.includes(
              frame.characteristic
            )
          }
          onChange={(event) => {
            const { diameterZone: _previous, ...rest } = frame;
            props.onUpdate(
              event.target.checked ? { ...rest, diameterZone: true } : rest,
              'Change frame zone'
            );
          }}
        />
        Cylindrical zone (Ø)
      </label>
      <label className="pmi-field">
        <span>Material condition</span>
        <select
          value={frame.material ?? ''}
          disabled={
            disabled ||
            !DRAWING_MATERIAL_CHARACTERISTICS.includes(frame.characteristic)
          }
          onChange={(event) => {
            const { material: _previous, ...rest } = frame;
            const value = event.target.value as DrawingMaterialCondition | '';
            props.onUpdate(
              value ? { ...rest, material: value } : rest,
              'Change frame modifier'
            );
          }}
        >
          <option value="">Regardless of size</option>
          <option value="mmc">MMC (M)</option>
          <option value="lmc">LMC (L)</option>
        </select>
      </label>
      {DRAWING_FORM_CHARACTERISTICS.includes(frame.characteristic) ? (
        <p className="pmi-hint">
          A form tolerance controls the feature alone and names no datum.
        </p>
      ) : (
        Array.from({ length: MAX_DRAWING_DATUM_REFERENCES }, (_, index) => {
          const reference = datums[index];
          const others = datums
            .filter((_, other) => other !== index)
            .map((entry) => entry.letter);
          return (
            <label key={index} className="pmi-field">
              <span>{PRECEDENCE[index]} datum</span>
              <select
                value={reference?.letter ?? ''}
                disabled={disabled || index > datums.length}
                onChange={(event) => {
                  const letter = event.target.value;
                  const next = letter
                    ? datums.length > index
                      ? datums.map((entry, at) =>
                          at === index ? { ...entry, letter } : entry
                        )
                      : [...datums, { letter }]
                    : datums.slice(0, index);
                  props.onUpdate(withDatums(next), 'Change frame datums');
                }}
              >
                <option value="" disabled={index === 0 && required}>
                  None
                </option>
                {reference && !declared.includes(reference.letter) ? (
                  <option value={reference.letter}>
                    {reference.letter} (undeclared)
                  </option>
                ) : null}
                {declared
                  .filter((letter) => !others.includes(letter))
                  .map((letter) => (
                    <option key={letter} value={letter}>
                      {letter}
                    </option>
                  ))}
              </select>
            </label>
          );
        })
      )}
    </>
  );
}

function AmountField(props: {
  value: number;
  units: string;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const commit = () => {
    const value = Number(draft);
    if (
      draft.trim() !== '' &&
      Number.isFinite(value) &&
      value > 0 &&
      value <= 1e6 &&
      Number(value.toFixed(6)) === value &&
      value !== props.value
    )
      props.onCommit(value);
    setDraft(String(props.value));
  };
  return (
    <label className="pmi-field">
      <span>Tolerance ({props.units === 'inch' ? 'in' : props.units})</span>
      <input
        type="number"
        step="any"
        min={0}
        value={draft}
        disabled={props.disabled}
        aria-label="PMI frame tolerance"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(String(props.value));
        }}
      />
    </label>
  );
}
