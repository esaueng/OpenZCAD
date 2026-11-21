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
import type { ExtrudeChoice, ResolvedExtrude } from '../lib/extrudeInference';
import { formatNumber, paramValueText } from '../lib/model';
import {
  extrudeShownValues,
  type ExtrudeCommandExtent,
  type ExtrudeValueId
} from '../lib/extrudeShownValues';
import { InPlaceCommandBar, type InPlaceOption } from './InPlaceCommandBar';

/**
 * The in-place Extrude (U09): the region's arrow, a back arrow and a draft
 * rig in the model, and this bar. Everything the extrude card held is here
 * behind Options — the operation and its target, the extent, Symmetric, the
 * three numbers (each typed on the keypad, expressions kept) and Reverse —
 * refused by the same rules the History editor's card applies.
 */

export { extrudeShownValues, type ExtrudeValueId };

/** The draft as numbers, for the handles the model draws. */
export interface ExtrudeCommandState {
  value: ExtrudeFormValue;
  extent: ExtrudeCommandExtent;
  symmetric: boolean;
  /** NaN while a field's text does not evaluate. */
  distance: number;
  backDistance: number;
  /** F01 (v113): the offset from the face (To face only). */
  faceOffset: number;
  /** F01 (v121): the start offset along the sketch normal. */
  startOffset: number;
  draftAngle: number;
  /** F01 (v126): the back side's draft (two-sided blind only). */
  backDraftAngle: number;
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
  /**
   * A value moved in the model ahead of being set: the region's arrow
   * previews each frame under the hand and sets the distance only on
   * release, so a refusal meanwhile is about this value.
   */
  holdValue(valueId: ExtrudeValueId): void;
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
  /**
   * The kernel refused the draft as it now stands (a preview or a Done):
   * said where the hint is, after the input last changed, which is the one
   * to change back or again. The last preview that built stays on screen.
   */
  valueRefusal?: string | null;
  /** The current draft is replacing the preview still on screen. */
  previewPending?: boolean;
  /** The current draft's accepted exact operation, while Auto is selected. */
  resolvedChoice?: ResolvedExtrude['inference'] | null;
  /** Leaves Section view for a current preview hidden by the section. */
  onShowFullModel?: () => void;
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
  /**
   * Every change: the extrude to preview, or null while it cannot apply.
   * A refusal known at once (the draft does not validate) may be returned:
   * it is this change's, even when it reads the same as the one before.
   */
  onPreview(value: ExtrudeFormValue | null): string | null | void;
  /**
   * The value the bar names a kernel refusal after, or null when it names
   * none: the model marks that value's chip, and no other, as refused.
   */
  onRefusedValue?(valueId: ExtrudeValueId | null): void;
  onSubmit(value: ExtrudeFormValue): void;
  onCancel(): void;
}

const OPERATIONS: InPlaceOption['choices'] = [
  {
    value: 'automatic',
    label: 'Auto',
    tip: 'Adds, cuts or starts a body as it meets the model'
  },
  { value: 'new-body', label: 'New body' },
  { value: 'add', label: 'Add' },
  { value: 'cut', label: 'Cut' },
  { value: 'intersect', label: 'Intersect' }
];

const THROUGH_ALL_SIDES: InPlaceOption['choices'] = [
  { value: 'forward', label: 'Forward' },
  { value: 'backward', label: 'Reverse' },
  { value: 'both', label: 'Both' }
];

const VALUE_LABELS: Record<ExtrudeValueId, string> = {
  distance: 'Distance',
  backDistance: 'Back distance',
  faceOffset: 'Offset from face',
  startOffset: 'Start offset',
  draftAngle: 'Draft angle',
  backDraftAngle: 'Back draft angle'
};

/**
 * The bar input a change set, by the name it carries in the bar, or null
 * when nothing changed. A change that moves several fields is named for the
 * one the user set: a picked face (which also sets the reach), a value
 * (which may also leave an extent or Symmetric), then an option.
 */
export function extrudeChangedInput(
  previous: ExtrudeDraft,
  next: ExtrudeDraft
): string | null {
  if (next.toFace !== previous.toFace) return 'Face';
  for (const valueId of [
    'distance',
    'backDistance',
    'faceOffset',
    'startOffset',
    'draftAngle',
    'backDraftAngle'
  ] as const) {
    if (next[valueId] !== previous[valueId]) return VALUE_LABELS[valueId];
  }
  if (next.choice.operation !== previous.choice.operation) return 'Operation';
  if (JSON.stringify(next.choice) !== JSON.stringify(previous.choice)) {
    return 'Target body';
  }
  if (next.endCondition !== previous.endCondition) return 'Extent';
  if (next.throughAllSide !== previous.throughAllSide) return 'Direction';
  if (next.symmetric !== previous.symmetric) return 'Sides';
  return null;
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
  valueRefusal = null,
  previewPending = false,
  resolvedChoice = null,
  onShowFullModel,
  name,
  entryRefusal = null,
  toFacePicking,
  distanceSetterRef,
  commandRef,
  onOpenValue,
  onDraft,
  onPreview,
  onRefusedValue,
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
  // The input the last change set, and the one a kernel refusal is named
  // for: the input changed when that refusal arrived. A later change must
  // not take the blame for a refusal it did not cause.
  const [lastInput, setLastInput] = useState<string | null>(null);
  const [refused, setRefused] = useState<{
    message: string | null;
    input: string | null;
  }>({ message: null, input: null });
  if (refused.message !== valueRefusal) {
    setRefused({ message: valueRefusal, input: valueRefusal && lastInput });
  }
  const refusedInput =
    refused.message === valueRefusal ? refused.input : lastInput;
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
      faceOffset: evaluated(next.faceOffset, 'length'),
      startOffset: evaluated(next.startOffset, 'length'),
      draftAngle: evaluated(next.draftAngle, 'angle'),
      backDraftAngle: evaluated(next.backDraftAngle, 'angle'),
      texts: {
        distance: next.distance,
        backDistance: next.backDistance,
        faceOffset: next.faceOffset,
        startOffset: next.startOffset,
        draftAngle: next.draftAngle,
        backDraftAngle: next.backDraftAngle
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
    const previous = draftRef.current;
    const next = { ...previous, ...patch };
    draftRef.current = next;
    const input = extrudeChangedInput(previous, next);
    if (input) setLastInput(input);
    if (patch.distance !== undefined) setDistanceEdited(true);
    setDraft(next);
    onDraft(stateOf(next));
    const known = onPreview(extrudeDraftValue(next, ctx));
    // The parent withdraws and re-sets such a refusal in one render, which
    // the comparison below cannot tell from the standing one.
    if (typeof known === 'string') {
      setRefused({ message: known, input: input ?? lastInput });
    }
  }

  // An edit opens on a stored extrude whose handles stand on what it stores.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !editing) return;
    opened.current = true;
    onDraft(stateOf(draftRef.current));
    // Once, as it opens; later drafts are published as they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
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
      // A face on the sketch plane has no reach to keep: the typed
      // distance stays for switching back.
      ...(reach !== null && reach !== 0
        ? { distance: toFaceReachText(reach) }
        : {})
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
    // A late handle or keypad event must not change the draft Done took.
    if (disabled) return;
    // Setting the distance overrides a to-face or through-all extent.
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
    } else if (valueId === 'faceOffset') {
      change({ faceOffset: text });
    } else if (valueId === 'startOffset') {
      change({ startOffset: text });
    } else if (valueId === 'backDraftAngle') {
      change({ backDraftAngle: text });
    } else {
      change({ draftAngle: text });
    }
  }
  const handle = useRef<ExtrudeCommandHandle | null>(null);
  handle.current = {
    submit,
    setValue,
    text: (valueId) => draftRef.current[valueId],
    holdValue: (valueId) => setLastInput(VALUE_LABELS[valueId]),
    touched: () =>
      JSON.stringify(draftRef.current) !== JSON.stringify(openedDraft.current)
  };
  useEffect(() => {
    distanceSetterRef.current = (value) =>
      handle.current?.setValue('distance', paramValueText(value));
    return () => {
      distanceSetterRef.current = null;
    };
  }, [distanceSetterRef]);
  useEffect(() => {
    commandRef.current = {
      submit: () => handle.current?.submit() ?? false,
      setValue: (valueId, text) => handle.current?.setValue(valueId, text),
      text: (valueId) => handle.current?.text(valueId) ?? '',
      holdValue: (valueId) => handle.current?.holdValue(valueId),
      touched: () => handle.current?.touched() ?? false
    };
    return () => {
      commandRef.current = null;
    };
  }, [commandRef]);

  const draftRefusal = extrudeDraftRefusal(draft, ctx, distanceEdited);
  const ownRefusal = entryRefusal ?? (draftRefusal || null) ?? note;
  const refusal = ownRefusal ?? valueRefusal;
  const canFinish = !disabled && !entryRefusal && draftRefusal === null;
  const namedInput =
    ownRefusal === null && valueRefusal && !toFacePicking?.armed
      ? refusedInput
      : null;
  const refusedValue =
    (Object.keys(VALUE_LABELS) as ExtrudeValueId[]).find(
      (valueId) => VALUE_LABELS[valueId] === namedInput
    ) ?? null;
  const reportRefusedValue = useRef(onRefusedValue);
  reportRefusedValue.current = onRefusedValue;
  useEffect(() => {
    reportRefusedValue.current?.(refusedValue);
  }, [refusedValue]);
  // A command that closes takes its mark with it.
  useEffect(() => () => reportRefusedValue.current?.(null), []);
  const toFaceInfo =
    toFace && draft.toFace ? toFacePicking!.describe(draft.toFace) : null;
  const regions = profileCount > 1 ? ` · ${profileCount} profiles` : '';
  const guidance = toFacePicking?.armed
    ? 'Click a flat face parallel to the sketch'
    : toFace
      ? toFaceInfo
        ? `Up to ${toFaceInfo.label}${regions}`
        : 'Pick the face to reach'
      : throughAll
        ? `Through all${regions}`
        : `Drag the arrows, or tap a value${regions}`;
  const checking =
    previewPending &&
    !toFacePicking?.armed &&
    draftRefusal === null &&
    !refusal;
  const inferred =
    draft.choice.operation === 'automatic' &&
    draftRefusal === null &&
    !previewPending
      ? resolvedChoice
      : null;
  const choice = inferred ?? draft.choice;
  const target =
    'targetBodyId' in choice
      ? bodies.find((body) => body.bodyId === choice.targetBodyId)?.name
      : null;
  const operation =
    choice.operation === 'automatic'
      ? 'Auto'
      : choice.operation === 'new-body'
        ? 'New body'
        : `${OPERATIONS.find((item) => item.value === choice.operation)!.label}${target ? ` · ${target}` : ''}`;
  const hintLead = `${inferred ? 'Preview: ' : ''}${operation} · `;
  const hint = `${hintLead}${checking ? 'Checking preview…' : guidance}`;
  const recovery =
    onShowFullModel && !toFacePicking?.armed
      ? {
          hint: (
            <>
              {hintLead}
              <span>Section view hides this change</span>
            </>
          ),
          label: 'Show full model',
          onActivate: onShowFullModel
        }
      : undefined;

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
                tip: 'Follows the face if it moves'
              }
            ]
          : []),
        ...(extrudeOffersThroughAll(draft)
          ? [
              {
                value: 'through-all',
                label: 'Through all',
                tip: 'Cuts through the whole target'
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
          tip: 'Half each side'
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
    symmetric: draft.symmetric,
    backDistance: evaluated(draft.backDistance, 'length')
  }).map((valueId) => {
    const text = draft[valueId];
    const plain = Number(text.trim());
    const unit =
      valueId === 'draftAngle' || valueId === 'backDraftAngle'
        ? '°'
        : ` ${units}`;
    const formatted = formatNumber(plain);
    return {
      id: valueId,
      label: VALUE_LABELS[valueId],
      text: Number.isFinite(plain)
        ? `${Number(formatted) === plain ? formatted : plain}${unit}`
        : text
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
      refusalInput={ownRefusal === null ? refusedInput : null}
      canFinish={canFinish}
      previewPending={checking}
      recovery={recovery}
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
