import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type {
  BodyId,
  ExtrudeToFaceTarget,
  ParamValue,
  ThroughAllSide,
  UnitSystem
} from '@openzcad/shared';
import {
  extrudeChoiceWith,
  extrudeDraftNumber,
  extrudeDraftRefusal,
  extrudeDraftValue,
  extrudeFormValue,
  extrudeIsThroughAll,
  extrudeIsToFace,
  extrudeNeedsTarget,
  extrudeOffersThroughAll,
  extrudeShownExtent,
  initialExtrudeDraft,
  reversedDistance,
  toFaceReachText,
  type ExtrudeDraft,
  type ExtrudeDraftContext,
  type ExtrudeDraftInitial,
  type ExtrudeFormValue,
  type ExtrudeToFacePicking
} from '../lib/extrudeDraft';
import type { ExtrudeChoice } from '../lib/extrudeInference';
import { formatNumber, paramValueText } from '../lib/model';
import { InPlaceCommandBar, type InPlaceOption } from './InPlaceCommandBar';

/**
 * The in-place Extrude (U09): the region's arrow, a back arrow and a draft
 * rig in the model, and this bar. Everything the extrude card held is here
 * behind Options — the operation and its target, the extent, Symmetric, the
 * three numbers (each typed on the keypad, expressions kept) and Reverse —
 * refused by the same rules the History editor's card applies.
 */

/** The numbers the bar, its keypad and the model's handles edit. */
export type ExtrudeValueId = 'distance' | 'backDistance' | 'draftAngle';

/** The draft as numbers, for the handles the model draws. */
export interface ExtrudeCommandState {
  value: ExtrudeFormValue;
  extent: 'blind' | 'to-face' | 'through-all';
  symmetric: boolean;
  /** NaN while a field's text does not evaluate. */
  distance: number;
  backDistance: number;
  draftAngle: number;
  /** Each value as its text holds it (a typed expression as typed). */
  texts: Record<ExtrudeValueId, string>;
}

export interface ExtrudeCommandHandle {
  /** Done: false when the draft cannot be created yet. */
  submit(): boolean;
  /**
   * A value typed on the keypad (`text` as typed) or dragged on a handle
   * (a number); a drag that would leave a derived extent turns it to
   * Distance, as the arrow does.
   */
  setValue(valueId: ExtrudeValueId, text: string): void;
  /** The text a value holds now, as the keypad opens on it. */
  text(valueId: ExtrudeValueId): string;
  /** Whether anything has changed since the command opened. */
  touched(): boolean;
}

interface ExtrudeCommandProps {
  scope: Record<string, number>;
  units: UnitSystem;
  bodies: { bodyId: BodyId; name: string }[];
  initial: ExtrudeDraftInitial;
  profileCount: number;
  disabled: boolean;
  /**
   * Editing a stored extrude (U09): titled for it, its operation never
   * inferred, and its draft published as it opens so the model's handles
   * stand on what is stored.
   */
  editing?: boolean;
  /** Why the last preview or Done was refused, said where the hint is. */
  note?: string | null;
  /** The edited feature's name as it is now (a rename since it opened). */
  name?: string;
  toFacePicking?: ExtrudeToFacePicking;
  /**
   * The open keypad's entry for one of these values does not evaluate
   * (`Distance: …`): Done waits, or it would create the last valid value.
   */
  entryRefusal?: string | null;
  /** The region's arrow (and its keypad) set the distance through this. */
  distanceSetterRef: MutableRefObject<((value: ParamValue) => void) | null>;
  commandRef: MutableRefObject<ExtrudeCommandHandle | null>;
  /** A value's row was pressed, at this client point (for the keypad). */
  onOpenValue(valueId: ExtrudeValueId, at: { x: number; y: number }): void;
  /** Every change, valid or not: what the preview and handles read. */
  onDraft(state: ExtrudeCommandState): void;
  /** Every change: the extrude to preview, or null while it cannot apply. */
  onPreview(value: ExtrudeFormValue | null): void;
  onSubmit(value: ExtrudeFormValue): void;
  onCancel(): void;
}

const OPERATIONS: InPlaceOption['choices'] = [
  {
    value: 'automatic',
    label: 'Automatic',
    note: 'Adds, cuts or starts a body from where the extrusion meets the model.'
  },
  { value: 'new-body', label: 'New body' },
  { value: 'add', label: 'Add' },
  { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' }
];

const THROUGH_ALL_SIDES: InPlaceOption['choices'] = [
  { value: 'forward', label: 'Along the sketch normal' },
  { value: 'backward', label: 'Against the sketch normal' },
  { value: 'both', label: 'Both sides' }
];

const VALUE_LABELS: Record<ExtrudeValueId, string> = {
  distance: 'Distance',
  backDistance: 'Back distance',
  draftAngle: 'Draft angle'
};

const FINISH = 'Enter to finish · Esc cancels';

/**
 * The values an extrude in this extent offers to type: Distance only for a
 * blind one, Back distance only one-sided, a draft except through all.
 */
export function extrudeShownValues(state: {
  extent: ExtrudeCommandState['extent'];
  symmetric: boolean;
}): ExtrudeValueId[] {
  const blind = state.extent === 'blind';
  return [
    ...(blind ? (['distance'] as const) : []),
    ...(blind && !state.symmetric ? (['backDistance'] as const) : []),
    ...(state.extent !== 'through-all' ? (['draftAngle'] as const) : [])
  ];
}

export function ExtrudeCommand({
  scope,
  units,
  bodies,
  initial,
  profileCount,
  disabled,
  editing = false,
  note = null,
  name,
  entryRefusal = null,
  toFacePicking,
  distanceSetterRef,
  commandRef,
  onOpenValue,
  onDraft,
  onPreview,
  onSubmit,
  onCancel
}: ExtrudeCommandProps) {
  const [draft, setDraft] = useState<ExtrudeDraft>(() =>
    initialExtrudeDraft(initial, !editing)
  );
  // Changes read the draft as the last one left it, not as this render saw
  // it: two drag frames can land before a render.
  const draftRef = useRef(draft);
  const openedDraft = useRef(draft);
  // A new extrude opens at zero until the user drags or types a distance,
  // so the zero-distance refusal waits for that edit (or a Done).
  const [distanceEdited, setDistanceEdited] = useState(false);
  const ctx: ExtrudeDraftContext = {
    scope,
    units,
    initial,
    bodies,
    ...(toFacePicking ? { toFacePicking } : {})
  };
  const throughAll = extrudeIsThroughAll(draft);
  const toFace = extrudeIsToFace(draft, ctx);
  const blind = !throughAll && !toFace;

  function stateOf(next: ExtrudeDraft): ExtrudeCommandState {
    const value = extrudeFormValue(next, ctx);
    return {
      value,
      extent: value.endCondition ?? 'blind',
      symmetric: value.symmetric,
      distance: evaluated(next.distance, 'length'),
      backDistance: evaluated(next.backDistance, 'length'),
      draftAngle: evaluated(next.draftAngle, 'angle'),
      texts: {
        distance: next.distance,
        backDistance: next.backDistance,
        draftAngle: next.draftAngle
      }
    };
  }

  function evaluated(text: string, kind: 'length' | 'angle'): number {
    return extrudeDraftNumber(text, kind, ctx) ?? Number.NaN;
  }

  function change(patch: Partial<ExtrudeDraft>) {
    if (
      toFacePicking?.armed &&
      patch.endCondition !== undefined &&
      patch.endCondition !== 'to-face'
    ) {
      toFacePicking.cancel();
    }
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    if (patch.distance !== undefined) setDistanceEdited(true);
    setDraft(next);
    onDraft(stateOf(next));
    onPreview(extrudeDraftValue(next, ctx));
  }

  // The arrow and its keypad set a distance: on a to-face or through-all
  // extrude that is a choice of Distance over the derived extent.
  // An edit opens on a stored extrude whose handles stand on what it stores.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !editing) return;
    opened.current = true;
    onDraft(stateOf(draftRef.current));
    // Once, as it opens; later drafts are published as they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  const changeRef = useRef(change);
  changeRef.current = change;
  useEffect(() => {
    distanceSetterRef.current = (value) =>
      changeRef.current({
        distance: paramValueText(value),
        ...(draftRef.current.endCondition !== 'blind'
          ? { endCondition: 'blind' as const }
          : {})
      });
    return () => {
      distanceSetterRef.current = null;
    };
  }, [distanceSetterRef]);

  // A picked face becomes the target, and the depth it gives becomes the
  // dormant distance, so switching back to Distance keeps the same reach.
  const pendingFace = useRef<ExtrudeToFaceTarget | null>(null);
  const updateFace = useRef((_target: ExtrudeToFaceTarget) => {});
  updateFace.current = (target) => {
    const reach = toFacePicking?.describe(target).distance ?? null;
    pendingFace.current = reach === null ? target : null;
    change({
      toFace: target,
      endCondition: 'to-face',
      ...(reach !== null ? { distance: toFaceReachText(reach) } : {})
    });
  };
  const faceReach =
    toFace && draft.toFace
      ? toFacePicking!.describe(draft.toFace).distance
      : undefined;
  useEffect(() => {
    const target = pendingFace.current;
    if (!target) return;
    if (!toFace || draft.toFace !== target) {
      pendingFace.current = null;
      return;
    }
    if (faceReach !== null && faceReach !== undefined) {
      updateFace.current(target);
    }
  }, [toFace, draft.toFace, faceReach]);
  const faceSetterRef = toFacePicking?.setterRef;
  const cancelPick = useRef(() => {});
  cancelPick.current = () => toFacePicking?.cancel();
  useEffect(() => {
    if (!faceSetterRef) return;
    faceSetterRef.current = (target) => updateFace.current(target);
    return () => {
      faceSetterRef.current = null;
      // Closing the command withdraws its pick, armed or not.
      cancelPick.current();
    };
  }, [faceSetterRef]);

  function submit(): boolean {
    setDistanceEdited(true);
    const value = extrudeDraftValue(draftRef.current, ctx);
    if (!value || disabled || entryRefusal) return false;
    onSubmit(value);
    return true;
  }

  function setValue(valueId: ExtrudeValueId, text: string) {
    // A keypad left open across a Done must not change what it commits.
    if (disabled) return;
    if (valueId === 'distance') {
      change({
        distance: text,
        ...(draftRef.current.endCondition !== 'blind'
          ? { endCondition: 'blind' as const }
          : {})
      });
    } else if (valueId === 'backDistance') {
      // A back distance is one-sided: it ends Symmetric, as the card's
      // field (shown only off Symmetric) never stood beside it.
      change({ backDistance: text, symmetric: false });
    } else {
      change({ draftAngle: text });
    }
  }
  const handle = useRef<ExtrudeCommandHandle | null>(null);
  handle.current = {
    submit,
    setValue,
    text: (valueId) => draftRef.current[valueId],
    touched: () =>
      JSON.stringify(draftRef.current) !== JSON.stringify(openedDraft.current)
  };
  useEffect(() => {
    commandRef.current = {
      submit: () => handle.current?.submit() ?? false,
      setValue: (valueId, text) => handle.current?.setValue(valueId, text),
      text: (valueId) => handle.current?.text(valueId) ?? '',
      touched: () => handle.current?.touched() ?? false
    };
    return () => {
      commandRef.current = null;
    };
  }, [commandRef]);

  const refusal =
    entryRefusal ??
    (extrudeDraftRefusal(draft, ctx, distanceEdited) || null) ??
    note;
  const canFinish =
    !disabled && !entryRefusal && extrudeDraftValue(draft, ctx) !== null;
  const toFaceInfo =
    toFace && draft.toFace ? toFacePicking!.describe(draft.toFace) : null;
  const regions = profileCount > 1 ? ` · ${profileCount} profiles` : '';
  const hint = toFacePicking?.armed
    ? 'Click a planar face parallel to the sketch · Esc cancels'
    : toFace
      ? toFaceInfo
        ? `Up to ${toFaceInfo.label}${regions} · ${FINISH}`
        : 'Pick the face to reach from Options'
      : throughAll
        ? `Through the whole target${regions} · ${FINISH}`
        : `Drag the arrows, or tap a value to type${regions} · ${FINISH}`;

  const options: InPlaceOption[] = [
    {
      id: 'operation',
      label: 'Operation',
      value: draft.choice.operation,
      // An edit keeps the operation the feature stores: nothing infers it.
      choices: editing
        ? OPERATIONS.filter((choice) => choice.value !== 'automatic')
        : OPERATIONS
    }
  ];
  if (extrudeNeedsTarget(draft.choice)) {
    const target =
      'targetBodyId' in draft.choice ? draft.choice.targetBodyId : undefined;
    options.push({
      id: 'target',
      label: 'Target body',
      value: target ?? '',
      choices: bodies.map((body) => ({
        value: body.bodyId,
        label: body.name
      }))
    });
  }
  if (extrudeOffersThroughAll(draft) || toFacePicking) {
    options.push({
      id: 'extent',
      label: 'Extent',
      value: extrudeShownExtent(draft, ctx),
      choices: [
        { value: 'blind', label: 'Distance' },
        ...(toFacePicking
          ? [
              {
                value: 'to-face',
                label: 'To face',
                note: 'Reaches the face wherever it moves later; the face is found again by its identity on every rebuild.'
              }
            ]
          : []),
        ...(extrudeOffersThroughAll(draft)
          ? [
              {
                value: 'through-all',
                label: 'Through all',
                note: 'Cuts through the whole target, however its size or position changes later.'
              }
            ]
          : [])
      ]
    });
  }
  if (throughAll) {
    options.push({
      id: 'throughAllSide',
      label: 'Direction',
      value: draft.throughAllSide,
      choices: THROUGH_ALL_SIDES
    });
  }
  if (blind) {
    options.push({
      id: 'symmetric',
      label: 'Sides',
      value: draft.symmetric ? 'symmetric' : 'one-side',
      choices: [
        { value: 'one-side', label: 'One side' },
        {
          value: 'symmetric',
          label: 'Symmetric',
          note: 'Half the distance to each side of the sketch plane.'
        }
      ]
    });
  }

  function setOption(optionId: string, value: string) {
    switch (optionId) {
      case 'operation':
        change({
          choice: extrudeChoiceWith(
            draft.choice,
            value as ExtrudeChoice['operation'],
            bodies
          )
        });
        return;
      case 'target':
        change({
          choice: {
            operation: draft.choice.operation as 'add' | 'cut' | 'intersect',
            ...(value ? { targetBodyId: value as BodyId } : {})
          }
        });
        return;
      case 'extent':
        change({
          endCondition: value as ExtrudeDraft['endCondition']
        });
        // To face with nothing picked arms the pick at once: the face is
        // the only thing it needs.
        if (value === 'to-face' && !draft.toFace && !toFacePicking?.armed) {
          toFacePicking?.onPick();
        }
        return;
      case 'throughAllSide':
        change({ throughAllSide: value as ThroughAllSide });
        return;
      case 'symmetric':
        change({ symmetric: value === 'symmetric' });
        return;
    }
  }

  const values = extrudeShownValues({
    extent: throughAll ? 'through-all' : toFace ? 'to-face' : 'blind',
    symmetric: draft.symmetric
  }).map((valueId) => {
    const text = draft[valueId];
    const plain = Number(text.trim());
    const unit = valueId === 'draftAngle' ? '°' : ` ${units}`;
    return {
      id: valueId,
      label: VALUE_LABELS[valueId],
      text: Number.isFinite(plain) ? `${formatNumber(plain)}${unit}` : text
    };
  });

  const actions = [
    ...(blind ? [{ id: 'reverse', label: 'Reverse direction' }] : []),
    ...(toFace && toFacePicking
      ? [
          {
            id: 'pick-face',
            label: toFacePicking.armed
              ? 'Cancel face pick'
              : draft.toFace || toFacePicking.unresolved
                ? 'Re-pick face'
                : 'Pick face'
          }
        ]
      : [])
  ];

  return (
    <InPlaceCommandBar
      title={editing ? `Edit ${name ?? initial.name}` : 'Extrude'}
      hint={hint}
      refusal={toFacePicking?.armed ? null : refusal}
      canFinish={canFinish}
      // While a Done is checked (or an exact operation holds the model) the
      // draft it captured is the one shown: only Cancel takes input.
      locked={disabled}
      options={options}
      onOption={setOption}
      values={values}
      onValue={(valueId, at) => onOpenValue(valueId as ExtrudeValueId, at)}
      actions={actions}
      onAction={(actionId) => {
        if (actionId === 'reverse') {
          change({ distance: reversedDistance(draft.distance) });
        } else if (actionId === 'pick-face') {
          toFacePicking?.onPick();
        }
      }}
      onDone={() => {
        submit();
      }}
      onCancel={onCancel}
    />
  );
}
