import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BodyId,
  ParamValue,
  ParametricVector3,
  ProjectDocument
} from '@openzcad/shared';
import { GEOMETRY_PREVIEW_SCHEDULING, LivePreview } from '../lib/livePreview';
import {
  IN_PLACE_TOOL_SPECS,
  axisCandidatesFor,
  clampValue,
  valueInRange,
  type BodyPick,
  type CurvePick,
  type EdgePick,
  type FacePick,
  type HandleSpec,
  type InPlaceContext,
  type InPlaceRequest,
  type InPlaceSlots,
  type InPlaceToolId,
  type InPlaceToolSpec,
  type OptionSpec,
  type PlanePick,
  type ProfilePick
} from '../lib/inPlace/tools';
import type { RevolveAxisCandidate } from '../lib/inPlace/revolve';
import type { InPlaceEditSeed } from '../lib/inPlace/edit';
import { findFeature } from '@openzcad/document-core';

/**
 * Runs whichever in-place command (U09) is active.
 *
 * A command has no form. Its slots fill from picks — a region click for a
 * profile, a click on a drawn axis line, a click on a sketch curve — and as
 * soon as the required slots are filled an exact preview runs through the
 * same command factory the commit uses, so what Done saves is what was
 * shown. Its numbers come from handles, or from the keypad their chips open.
 */

/** A built command, reduced to what preview and commit need from it. */
export interface InPlaceBuiltCommand {
  validate(document: ProjectDocument): void;
  apply(document: ProjectDocument): ProjectDocument;
  resultBodyId: BodyId | undefined;
}

export interface UseInPlaceCommandOptions extends InPlaceContext {
  /** The live document the preview builds on (the command manager's). */
  baseDocument(): ProjectDocument | null;
  /**
   * The base document's version: an undo or redo replaces it, and a frame
   * built on the old one must not stand for what Done would now commit.
   */
  baseVersion?: number | null;
  /**
   * An edit's seed read again from the feature as the model has it now, so
   * a value the user has not changed follows a change made to it since (an
   * undo, a collaborator), with the command that now edits it; null once
   * no in-place command edits it (it was deleted, or made into a Move),
   * undefined when there is nothing to read it from.
   */
  reseed?(
    edit: InPlaceEditSeed
  ): { tool: InPlaceToolId; seed: InPlaceEditSeed } | null | undefined;
  derive(document: ProjectDocument): Promise<ProjectDocument['derived']>;
  /**
   * Builds the same command the commit runs, named for the tool so a kernel
   * refusal names it as the commit would. With `edit`, that is the feature's
   * `updateFeature`, not a new feature.
   */
  buildCommand(
    request: InPlaceRequest,
    title: string,
    edit: InPlaceEditSeed | null
  ): InPlaceBuiltCommand;
  /**
   * Commits a request through the validated-feature path. An edit reports
   * back through `settleEdit`; a new feature may return whether it landed,
   * and the command stays open until then (nothing returned: it has).
   */
  commit(
    request: InPlaceRequest,
    title: string,
    edit: InPlaceEditSeed | null,
    /**
     * True once the command is closed or replaced while this commit still
     * validates: the host withdraws the candidate rather than land it.
     */
    withdrawn: () => boolean
  ): Promise<boolean> | void;
  publishPreview(preview: ProjectDocument | null): void;
  onStatus(message: string): void;
}

const SLOT_KEYS = [
  'profiles',
  'axisId',
  'path',
  'guide',
  'faces',
  'bodies',
  'plane',
  'edges'
] as const;

/** Where a pick stands or what it measures, not what it references. */
const PLACEMENT_KEYS = new Set([
  'min',
  'max',
  'point',
  'centroid',
  'center',
  'normal',
  'origin',
  'direction',
  'middle',
  'outward',
  'end',
  'fields',
  'regionFingerprint',
  'surfaceType'
]);

/**
 * What a slot references, for telling a user's repick from the same picks
 * read again (a re-measured box, a renumbered region).
 */
function slotIdentity(slot: unknown): string {
  return JSON.stringify(
    slot ?? null,
    function (this: unknown, key: string, value: unknown) {
      if (PLACEMENT_KEYS.has(key)) return undefined;
      // A face or edge named by its lineage is that lineage: the hash it
      // resolves to now changes with every upstream rebuild.
      const holder = this as { reference?: unknown } | null;
      if (
        (key === 'hash' || key === 'topologyId') &&
        holder?.reference !== undefined
      ) {
        return undefined;
      }
      return value;
    }
  );
}

/** An edit's session, armed from its seed. */
function sessionFromSeed(tool: InPlaceToolId, seed: InPlaceEditSeed): Session {
  return {
    tool,
    edit: seed,
    slots: {
      profiles: seed.slots.profiles,
      axisId: seed.slots.axisId,
      path: seed.slots.path,
      guide: seed.slots.guide,
      faces: seed.slots.faces,
      bodies: seed.slots.bodies,
      plane: seed.slots.plane,
      edges: seed.slots.edges
    },
    options: { ...seed.options },
    values: { ...seed.values },
    raws: { ...seed.raws },
    touched: [...seed.touched]
  };
}

interface Session {
  tool: InPlaceToolId;
  slots: {
    profiles: ProfilePick[];
    axisId: string | null;
    path: CurvePick[];
    guide: CurvePick[];
    faces: FacePick[];
    bodies: BodyPick[];
    plane: PlanePick | null;
    edges: EdgePick[];
  };
  options: Record<string, string>;
  values: Record<string, number>;
  /** Expressions typed into the keypad, stored instead of their numbers. */
  raws: Record<string, string>;
  /** Values the user has set, which the picks' defaults leave alone. */
  touched: string[];
  /** The stored feature this command edits; null while creating one. */
  edit: InPlaceEditSeed | null;
  /**
   * Whether a later direct edit reshapes the edited body, as the feature
   * stands now (its seed said so when armed; an undo may change it).
   */
  reshapedLater?: boolean;
}

export interface InPlaceCommand {
  active: boolean;
  tool: InPlaceToolId | null;
  spec: InPlaceToolSpec | null;
  slots: InPlaceSlots;
  axisCandidates: RevolveAxisCandidate[];
  handles: HandleSpec[];
  values: Record<string, number>;
  /** Values held as typed expressions, by id. */
  raws: Record<string, string>;
  options: Record<string, string>;
  /** The Options menu: the spec's, with an edit's own choices, unlocked. */
  optionSpecs: OptionSpec[];
  /** The feature being edited, or null while creating. */
  editing: InPlaceEditSeed | null;
  hint: string;
  refusal: string | null;
  canFinish: boolean;
  /** Re-arms the command that made a stored feature, seeded from it. */
  edit(tool: InPlaceToolId, seed: InPlaceEditSeed): void;
  start(
    tool: InPlaceToolId,
    profiles?: ProfilePick[],
    faces?: FacePick[],
    bodies?: BodyPick[],
    edges?: EdgePick[]
  ): void;
  pickProfile(pick: ProfilePick, additive?: boolean): void;
  /**
   * Replaces the profiles (an edit's that no longer resolve, dropped). With
   * `from`, only while the slot still holds those picks: one the live reseed
   * replaced meanwhile is newer than what the re-check read.
   */
  setProfiles(
    profiles: readonly ProfilePick[],
    from?: readonly ProfilePick[]
  ): void;
  /**
   * Replaces the path, guide or face picks, as a re-check leaves them; with
   * `from`, each only while its slot still holds what the re-check read.
   */
  setPicks(
    picks: {
      path?: readonly CurvePick[];
      guide?: readonly CurvePick[];
      faces?: readonly FacePick[];
      bodies?: readonly BodyPick[];
      edges?: readonly EdgePick[];
    },
    from?: Pick<InPlaceSlots, 'path' | 'guide' | 'faces' | 'bodies' | 'edges'>
  ): void;
  pickAxis(axisId: string): void;
  pickCurve(curve: CurvePick, additive?: boolean): void;
  /** A face click: refused (false) when the tool takes no such face. */
  pickFace(face: FacePick): boolean;
  /**
   * A box sweep's faces, added to a many-face command without toggling any
   * back out. Faces stay on one body: the body already picked, else the one
   * the sweep caught most of. Returns how many faces the command now holds,
   * or null when the command takes no face list.
   */
  addFaces(faces: readonly FacePick[]): number | null;
  /** A body click (any of its faces): refused when the tool takes none. */
  pickBody(body: BodyPick): boolean;
  /**
   * An edge click: it joins the command's edges, or a picked one comes back
   * out; an edge of another body starts the set over. Refused (false) when
   * the tool takes no edges.
   */
  pickEdge(edge: EdgePick): boolean;
  /** Replaces the command's edges (Select all, Clear); false without any. */
  setEdges(edges: readonly EdgePick[]): boolean;
  pickPlane(plane: PlanePick): boolean;
  setOption(optionId: string, value: string): void;
  previewValue(valueId: string, value: number): void;
  /** False when a typed expression is refused, leaving the value as it was. */
  setValue(valueId: string, value: number, raw?: string): boolean;
  /** Values the user has set, which the picks' or values' defaults leave alone. */
  touched: readonly string[];
  /**
   * A value put back as it was before an entry was canceled: its number,
   * its expression, and whether it was set, so a default it followed still
   * applies to it.
   */
  restoreValue(
    valueId: string,
    value: number,
    raw: string | undefined,
    touched: boolean
  ): void;
  done(): boolean;
  /**
   * An edit's Done waits on its validated commit: `true` ends the edit,
   * `false` (refused) leaves it open to correct and retry.
   */
  settleEdit(edit: InPlaceEditSeed, committed: boolean): void;
  /** Ends the command; `quiet` when another action already says why. */
  /** Ends the command; false while a Done is still validating (not quiet). */
  cancel(quiet?: boolean): boolean;
}

const EMPTY_RAWS: Record<string, string> = {};
const EMPTY_TOUCHED: readonly string[] = [];

const EMPTY_SLOTS: InPlaceSlots = {
  profiles: [],
  axis: null,
  path: [],
  guide: [],
  faces: [],
  bodies: [],
  plane: null,
  edges: []
};

function sameProfile(a: ProfilePick, b: ProfilePick): boolean {
  return (
    a.sketchId === b.sketchId && a.regionFingerprint === b.regionFingerprint
  );
}

export function useInPlaceCommand(
  options: UseInPlaceCommandOptions
): InPlaceCommand {
  const [session, setSession] = useState<Session | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  // A typed value the tool refused: it stands until the next accepted
  // value, and Done waits with it, since the chip went back to the value
  // before and finishing would commit that instead of what was typed.
  const [committing, setCommittingState] = useState(false);
  // While an edit's Done is validating, its inputs hold still: a change made
  // meanwhile would be closed away unseen by that commit's success.
  const committingRef = useRef(false);
  /** Which Done is committing: a command started or ended since is not it. */
  const commitToken = useRef(0);
  const setCommitting = useCallback((value: boolean) => {
    committingRef.current = value;
    setCommittingState(value);
  }, []);
  /**
   * What an edit's values and options were seeded from, kept for each one
   * the user has not changed: the user's own changes differ from it.
   */
  const seededRef = useRef<{
    values: Record<string, number>;
    raws: Record<string, string>;
    options: Record<string, string>;
    slots: Session['slots'];
  } | null>(null);
  const [entryRefusal, setEntryRefusal] = useState<{
    valueId: string;
    message: string;
  } | null>(null);
  const [previewValid, setPreviewValid] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const spec = session ? IN_PLACE_TOOL_SPECS[session.tool] : null;
  const specRef = useRef(spec);
  specRef.current = spec;
  const editSeed = session?.edit ?? null;
  const editRef = useRef(editSeed);
  editRef.current = editSeed;
  const sessionTouched = session?.touched ?? EMPTY_TOUCHED;
  // The edited feature's data in the model now, else as it armed: what the
  // command passes through unchanged (a hole's position, a draft's pull)
  // follows a change made to it since (an undo, a collaborator).
  const baseNow = options.baseDocument();
  const savedData = useMemo(() => {
    if (!editSeed) return undefined;
    const live = baseNow?.nodes
      ? findFeature(baseNow, editSeed.featureId)
      : undefined;
    return live && live.data.featureKind === editSeed.data.featureKind
      ? live.data
      : editSeed.data;
  }, [editSeed, baseNow]);
  const savedDataRef = useRef(savedData);
  savedDataRef.current = savedData;
  const ctx: InPlaceContext = useMemo(
    () => ({
      sketchViews: options.sketchViews,
      datumAxes: options.datumAxes,
      datumLabel: (featureId) => optionsRef.current.datumLabel(featureId),
      linearSnap: options.linearSnap ?? null,
      bodyBounds: (bodyId) => optionsRef.current.bodyBounds?.(bodyId) ?? null,
      evaluate: (value) => optionsRef.current.evaluate?.(value) ?? null,
      touched: sessionTouched,
      ...(savedData ? { saved: savedData } : {}),
      ...((session?.reshapedLater ?? editSeed?.reshapedLater)
        ? { reshapedLater: true }
        : {})
    }),
    [
      options.sketchViews,
      options.datumAxes,
      options.linearSnap,
      sessionTouched,
      savedData,
      editSeed,
      session?.reshapedLater
    ]
  );

  const profiles = session?.slots.profiles;
  const bodyCount = session?.slots.bodies.length ?? 0;
  const axisCandidates = useMemo(() => {
    if (!spec?.wantsAxis || !profiles) return [];
    // An edited feature's own axis line (a helix's typed one) comes first,
    // read again from what it stores whenever the model changes under the
    // edit (an undo, a collaborator's parameter edit).
    const saved = savedData;
    const read = (vector: ParametricVector3) => {
      const parts = [vector.x, vector.y, vector.z].map((part) =>
        typeof part === 'number'
          ? part
          : (optionsRef.current.evaluate?.(part) ?? null)
      );
      return parts.some((part) => part === null)
        ? null
        : { x: parts[0]!, y: parts[1]!, z: parts[2]! };
    };
    const own = (editSeed?.axes ?? []).map((candidate) => {
      if (candidate.id !== 'saved' || saved?.featureKind !== 'helical-sweep') {
        return candidate;
      }
      const origin = read(saved.axisOrigin);
      const direction = read(saved.axisDirection);
      return origin && direction
        ? { ...candidate, origin, direction }
        : candidate;
    });
    // A helix whose stored axis did not read when the edit armed (its
    // parameter unresolved) gets its saved axis once it reads now.
    if (
      editSeed &&
      saved?.featureKind === 'helical-sweep' &&
      !own.some((candidate) => candidate.id === 'saved')
    ) {
      const origin = read(saved.axisOrigin);
      const direction = read(saved.axisDirection);
      if (origin && direction) {
        own.push({
          id: 'saved',
          label: 'Its saved axis',
          origin,
          direction,
          choice: { saved: true }
        });
      }
    }
    if (spec.axisSource === 'datum' || spec.axisSource === 'world') {
      // A body's turn: its axis lines, once the body is picked.
      return bodyCount > 0
        ? [...own, ...axisCandidatesFor(EMPTY_SLOTS, ctx, spec.axisSource)]
        : [];
    }
    return [
      ...own,
      ...axisCandidatesFor(
        { ...EMPTY_SLOTS, profiles },
        ctx,
        'sketch',
        editSeed?.slots.axisId
      )
    ];
    // The base version re-reads the saved axis's expressions, as the effect
    // below does for typed values: a parameter can change with no change
    // to the feature itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    spec,
    profiles,
    bodyCount,
    ctx,
    editSeed,
    savedData,
    options.baseVersion
  ]);
  const slots: InPlaceSlots = useMemo(
    () =>
      session
        ? {
            profiles: session.slots.profiles,
            axis:
              axisCandidates.find(
                (candidate) => candidate.id === session.slots.axisId
              ) ?? null,
            path: session.slots.path,
            guide: session.slots.guide,
            faces: session.slots.faces,
            bodies: session.slots.bodies,
            plane: session.slots.plane,
            edges: session.slots.edges
          }
        : EMPTY_SLOTS,
    [session, axisCandidates]
  );

  const values = useMemo(() => session?.values ?? {}, [session?.values]);
  /** Every value as a number, its initial one where none is set. */
  const numbers = useMemo(() => {
    const out: Record<string, number> = {};
    for (const valueSpec of spec?.values ?? []) {
      out[valueSpec.id] = values[valueSpec.id] ?? valueSpec.initial;
    }
    return out;
  }, [spec, values]);

  // Defaults the picks suggest (a helix radius through the profile), or
  // another value does (a hole step from its bore), land on every value the
  // user has not set, each time they change.
  const defaultsKey = spec?.defaults
    ? JSON.stringify(spec.defaults(slots, ctx, numbers))
    : '';
  /** The defaults as they stand now, for a value put back unset. */
  const defaultsRef = useRef<Record<string, number>>({});
  defaultsRef.current = defaultsKey
    ? (JSON.parse(defaultsKey) as Record<string, number>)
    : {};
  useEffect(() => {
    if (!defaultsKey) return;
    const defaults = JSON.parse(defaultsKey) as Record<string, number>;
    setSession((current) => {
      if (!current) return current;
      const next = { ...current.values };
      let changed = false;
      for (const [id, value] of Object.entries(defaults)) {
        if (!current.touched.includes(id) && next[id] !== value) {
          next[id] = value;
          changed = true;
        }
      }
      return changed ? { ...current, values: next } : current;
    });
  }, [defaultsKey]);

  const paramValues = useMemo(() => {
    const out: Record<string, ParamValue> = { ...values };
    for (const [id, raw] of Object.entries(session?.raws ?? {})) out[id] = raw;
    return out;
  }, [values, session?.raws]);
  const chosen = useMemo(() => session?.options ?? {}, [session?.options]);
  const request = useMemo(
    () =>
      spec && spec.ready(slots, chosen)
        ? spec.request(slots, paramValues, chosen, ctx, numbers)
        : null,
    [spec, slots, paramValues, chosen, ctx, numbers]
  );
  const requestRef = useRef(request);
  requestRef.current = request;
  const requestKey = request ? JSON.stringify(request) : null;
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;
  /** The request the last valid preview showed; Done commits only that. */
  const [previewedKey, setPreviewedKey] = useState<string | null>(null);
  /**
   * The request each built document was built for, and the body it adds. A
   * frame LivePreview republishes from its cache is that same document, so
   * both travel with it rather than being read from whichever build started
   * last.
   */
  const builtFrames = useRef(
    new WeakMap<
      ProjectDocument,
      {
        key: string;
        bodyId: BodyId | undefined;
        /** The base version the frame was built on. */
        base: number | null | undefined;
      }
    >()
  ).current;

  const preview = useRef(
    new LivePreview<ProjectDocument, ProjectDocument['derived']>({
      build: () => {
        const current = requestRef.current;
        const base = optionsRef.current.baseDocument();
        const title =
          specRef.current?.featureName ?? specRef.current?.title ?? 'Preview';
        if (!current || !base) return null;
        const command = optionsRef.current.buildCommand(
          current,
          title,
          editRef.current
        );
        command.validate(base);
        const built = command.apply(base);
        builtFrames.set(built, {
          base: optionsRef.current.baseVersion,
          key: JSON.stringify(current),
          bodyId: command.resultBodyId
        });
        return built;
      },
      derive: (document) => optionsRef.current.derive(document),
      publish: (result) => {
        const built = result ? builtFrames.get(result.document) : undefined;
        // A frame built on a base the model has since moved past (an undo,
        // a collaborator's edit landing mid-build) is not what Done would
        // commit now: it is not shown, and the frame on the new base is.
        const frame =
          built && built.base === optionsRef.current.baseVersion
            ? built
            : undefined;
        if (built && !frame) return;
        const bodyId = frame?.bodyId;
        // As strict as the card's preflight: a warning the base model did
        // not already carry refuses the preview, even with a body built.
        const known = new Set(
          optionsRef.current.baseDocument()?.derived.warnings ?? []
        );
        const fresh = result?.derived.warnings.find(
          (warning) => !known.has(warning)
        );
        // An edit of a suppressed feature previews it built (the host's
        // command does so), so its body is looked for like any other.
        const valid = Boolean(
          result &&
          bodyId &&
          result.derived.bodyRepresentations[bodyId] &&
          !fresh
        );
        setPreviewValid(valid);
        setPreviewedKey(valid ? (frame?.key ?? null) : null);
        if (!result) return;
        if (valid) {
          setRefusal(null);
          optionsRef.current.publishPreview({
            ...result.document,
            derived: result.derived
          });
        } else {
          // The last frame that built is not this request: left on screen
          // under the refusal, it reads as the value that was refused.
          optionsRef.current.publishPreview(null);
          setRefusal(
            fresh ??
              result.derived.warnings.at(-1) ??
              'This did not produce a valid body.'
          );
        }
      },
      onFailure: ({ error }) => {
        setPreviewValid(false);
        optionsRef.current.publishPreview(null);
        setRefusal(
          error instanceof Error ? error.message : 'Unable to preview this.'
        );
      },
      ...GEOMETRY_PREVIEW_SCHEDULING
    })
  ).current;

  // Every change of what would be built previews at once: the solid is on
  // screen the frame after the pick that completes it.
  const generation = useRef(0);
  const editIdentity = session?.edit ?? null;
  // A refused entry belongs to the edit it was typed in: one re-armed from
  // a changed feature (a Linear pattern made Grid) starts without it.
  useEffect(() => {
    setEntryRefusal(null);
  }, [editIdentity]);
  useEffect(() => {
    if (!requestKey) {
      // Nothing to build (a pick taken back out): no frame, and no refusal
      // left over from the request that was.
      preview.clear();
      setPreviewValid(false);
      setRefusal(null);
      optionsRef.current.publishPreview(null);
      return;
    }
    // A new request is not shown yet: Done waits for its own frame, never
    // the previous request's (which a profile or axis change replaces).
    setPreviewValid(false);
    generation.current += 1;
    preview.request(generation.current);
    // A re-armed edit is a new request even when it builds the same thing
    // (two like Scales of one body): its own frame, so Done is not held.
  }, [requestKey, options.baseVersion, preview, editIdentity]);

  // A typed expression is stored as typed and evaluated against the model:
  // when the model changes under the command (an undo, a collaborator's
  // parameter edit), its number is read again, so the chip and the handle
  // stand where the preview builds.
  useEffect(() => {
    setSession((current) => {
      if (!current) return current;
      let changed = false;
      // An edited feature's own plane, stored as written, likewise: the
      // numbers a slide starts from are its fields read again.
      const plane = current.slots.plane;
      let slots = current.slots;
      if (plane?.kind === 'saved') {
        // Its fields as the feature stores them now: a collaborator may
        // have retyped the plane itself.
        const stored = savedDataRef.current;
        const storedPlane =
          stored &&
          (stored.featureKind === 'mirror' || stored.featureKind === 'split') &&
          'origin' in stored.plane
            ? stored.plane
            : null;
        const text = (vector: ParametricVector3) => ({
          x: String(vector.x),
          y: String(vector.y),
          z: String(vector.z)
        });
        const fields = storedPlane
          ? {
              origin: text(storedPlane.origin),
              normal: text(storedPlane.normal)
            }
          : plane.fields;
        const read = (text: { x: string; y: string; z: string }) => {
          const [x, y, z] = [text.x, text.y, text.z].map(
            (part) => optionsRef.current.evaluate?.(part) ?? null
          );
          return x == null || y == null || z == null ? null : { x, y, z };
        };
        const origin = read(fields.origin);
        const normal = read(fields.normal);
        if (
          origin &&
          normal &&
          JSON.stringify([origin, normal, fields]) !==
            JSON.stringify([plane.origin, plane.normal, plane.fields])
        ) {
          slots = { ...slots, plane: { ...plane, origin, normal, fields } };
          changed = true;
        }
      }
      const values = { ...current.values };
      let raws = current.raws;
      let tool = current.tool;
      let chosen = current.options;
      let touched = current.touched;
      let reshapedLater = current.reshapedLater;
      // A stored value or option the user has not changed since it was
      // seeded takes the feature's as it is now. One the user changed keeps
      // its old baseline, so it stays theirs even if the feature later comes
      // to match it.
      const baseline = seededRef.current;
      const reseeded =
        current.edit && baseline
          ? optionsRef.current.reseed?.(current.edit)
          : null;
      // A feature now made by another command (a linear pattern turned
      // circular, a scale turned into a turn) is edited by that command:
      // the edit re-arms from it. A Boolean's operations are one command's
      // choices, followed below like any option.
      if (
        reseeded &&
        reseeded.tool !== current.tool &&
        !committingRef.current &&
        !(IN_PLACE_TOOL_SPECS[current.tool].options ?? []).some(
          (option) =>
            option.switchesTool &&
            option.choices.some((choice) => choice.value === reseeded.tool)
        )
      ) {
        seededRef.current = {
          values: reseeded.seed.values,
          raws: reseeded.seed.raws,
          options: reseeded.seed.options,
          slots: reseeded.seed.slots
        };
        return sessionFromSeed(reseeded.tool, reseeded.seed);
      }
      const live = reseeded?.seed ?? null;
      if (live && baseline) {
        const nextBaseline = {
          values: { ...baseline.values },
          raws: { ...baseline.raws },
          options: { ...baseline.options },
          slots: baseline.slots
        };
        const ids = new Set([
          ...Object.keys(live.values),
          ...Object.keys(live.raws),
          ...Object.keys(baseline.values),
          ...Object.keys(baseline.raws)
        ]);
        const nextRaws = { ...raws };
        const take = <T>(
          target: Record<string, T>,
          id: string,
          value: T | undefined
        ) => {
          if (value === undefined) delete target[id];
          else target[id] = value;
        };
        for (const id of ids) {
          // A written value is the user's own until its text changes; its
          // number moves with the model.
          const untouched =
            baseline.raws[id] !== undefined
              ? raws[id] === baseline.raws[id]
              : raws[id] === undefined && values[id] === baseline.values[id];
          if (!untouched) continue;
          // Whether the feature stores it at all follows the feature too: a
          // size it now stores is no default to replace, and one it dropped
          // is left absent again.
          const stored = live.touched.includes(id);
          if (stored !== touched.includes(id)) {
            touched = stored
              ? [...touched, id]
              : touched.filter((other) => other !== id);
            changed = true;
          }
          take(nextBaseline.values, id, live.values[id]);
          take(nextBaseline.raws, id, live.raws[id]);
          if (live.values[id] === values[id] && live.raws[id] === raws[id]) {
            continue;
          }
          take(values, id, live.values[id]);
          take(nextRaws, id, live.raws[id]);
          changed = true;
        }
        raws = nextRaws;
        const optionSpecs = IN_PLACE_TOOL_SPECS[current.tool].options ?? [];
        for (const [id, value] of Object.entries(live.options)) {
          if (chosen[id] !== baseline.options[id]) continue;
          nextBaseline.options[id] = value;
          if (chosen[id] === value) continue;
          chosen = { ...chosen, [id]: value };
          // A Boolean's operation is its tool.
          const optionSpec = optionSpecs.find((spec) => spec.id === id);
          if (optionSpec?.switchesTool && value in IN_PLACE_TOOL_SPECS) {
            tool = value as InPlaceToolId;
          }
          changed = true;
        }
        // So do its picks: an untouched slot takes what the feature
        // references now (an undo may have re-pointed its path or bodies).
        // A point a click placed (a draft's clicked hinge) is the user's own,
        // though a point is otherwise only where a face stands: the faces
        // still follow the feature, and the point stays on its face while
        // that face is still drafted (gone, the hinge asks for a click).
        const placing = IN_PLACE_TOOL_SPECS[current.tool].clickPlacesPoint;
        const placed =
          placing !== undefined && chosen[placing.optionId] === placing.value
            ? slots.faces.find((face) => face.point !== undefined)
            : undefined;
        const sameFace = (a: FacePick, b: FacePick) =>
          a.bodyId === b.bodyId &&
          (a.reference !== undefined && b.reference !== undefined
            ? slotIdentity(a.reference) === slotIdentity(b.reference)
            : a.hash === b.hash);
        const takeSlot = <K extends keyof Session['slots']>(key: K) => {
          const now = slotIdentity(slots[key]);
          if (now !== slotIdentity(baseline.slots[key])) return;
          nextBaseline.slots = {
            ...nextBaseline.slots,
            [key]: live.slots[key]
          };
          if (slotIdentity(live.slots[key]) === now) return;
          let next = live.slots[key];
          if (key === 'faces' && placed?.point) {
            const point = placed.point;
            next = live.slots.faces.map((face) =>
              sameFace(face, placed) ? { ...face, point } : face
            ) as typeof next;
          }
          slots = { ...slots, [key]: next };
          changed = true;
        };
        for (const key of SLOT_KEYS) takeSlot(key);
        // Whether a later edit reshapes the body is the feature's now too.
        const reshaped = live.reshapedLater === true;
        if (
          reshaped !==
          (current.reshapedLater ?? current.edit?.reshapedLater === true)
        ) {
          reshapedLater = reshaped;
          changed = true;
        }
        seededRef.current = nextBaseline;
      }
      for (const [valueId, raw] of Object.entries(raws)) {
        const number = optionsRef.current.evaluate?.(raw);
        if (
          number !== null &&
          number !== undefined &&
          Number.isFinite(number) &&
          number !== values[valueId]
        ) {
          values[valueId] = number;
          changed = true;
        }
      }
      return changed
        ? {
            ...current,
            tool,
            options: chosen,
            slots,
            values,
            raws,
            touched,
            ...(reshapedLater !== undefined ? { reshapedLater } : {})
          }
        : current;
    });
  }, [options.baseVersion]);

  const end = useCallback(() => {
    commitToken.current += 1;
    preview.clear();
    setSession(null);
    setCommitting(false);
    setRefusal(null);
    setEntryRefusal(null);
    setPreviewValid(false);
    optionsRef.current.publishPreview(null);
  }, [preview, setCommitting]);

  // An edit of a feature no in-place command edits any more (an undo made
  // its Scale a Move) ends: its old request would be written back over it.
  useEffect(() => {
    const armed = sessionRef.current?.edit;
    if (!armed || committingRef.current || !optionsRef.current.reseed) return;
    if (optionsRef.current.reseed(armed) !== null) return;
    end();
    optionsRef.current.onStatus(
      `${armed.name}: it is no longer edited here · its edit closed.`
    );
  }, [options.baseVersion, end]);

  const start = useCallback(
    (
      tool: InPlaceToolId,
      initial: ProfilePick[] = [],
      initialFaces: FacePick[] = [],
      initialBodies: BodyPick[] = [],
      initialEdges: EdgePick[] = []
    ) => {
      const toolSpec = IN_PLACE_TOOL_SPECS[tool];
      commitToken.current += 1;
      preview.clear();
      optionsRef.current.publishPreview(null);
      setRefusal(null);
      setEntryRefusal(null);
      setCommitting(false);
      setPreviewValid(false);
      setSession({
        tool,
        edit: null,
        slots: {
          profiles:
            toolSpec.profileMode === 'none'
              ? []
              : toolSpec.profileMode === 'one'
                ? initial.slice(0, 1)
                : initial,
          axisId: null,
          path: [],
          guide: [],
          faces: toolSpec.faceMode
            ? toolSpec.faceMode === 'one'
              ? initialFaces.slice(0, 1)
              : initialFaces
            : [],
          bodies: toolSpec.bodyMode
            ? toolSpec.bodyMode === 'one'
              ? initialBodies.slice(0, 1)
              : initialBodies
            : [],
          plane: null,
          edges: toolSpec.edgeMode ? sameBodyEdges(initialEdges) : []
        },
        options: Object.fromEntries(
          (toolSpec.options ?? []).map((option) => [option.id, option.initial])
        ),
        values: Object.fromEntries(
          toolSpec.values.map((value) => [value.id, value.initial])
        ),
        raws: {},
        touched: []
      });
    },
    [preview, setCommitting]
  );

  const edit = useCallback(
    (tool: InPlaceToolId, seed: InPlaceEditSeed) => {
      seededRef.current = {
        values: seed.values,
        raws: seed.raws,
        options: seed.options,
        slots: seed.slots
      };
      commitToken.current += 1;
      preview.clear();
      optionsRef.current.publishPreview(null);
      setRefusal(null);
      setEntryRefusal(null);
      setCommitting(false);
      setPreviewValid(false);
      setSession(sessionFromSeed(tool, seed));
    },
    [preview, setCommitting]
  );

  const pickProfile = useCallback((pick: ProfilePick) => {
    if (committingRef.current) return;
    setSession((current) => {
      if (!current) return current;
      const toolSpec = IN_PLACE_TOOL_SPECS[current.tool];
      if (toolSpec.profileMode === 'none') return current;
      const existing = current.slots.profiles;
      if (toolSpec.profileMode === 'many') {
        // Sections run in click order; clicking a picked one takes it out.
        const without = existing.filter((other) => !sameProfile(other, pick));
        const profilesNext =
          without.length < existing.length ? without : [...existing, pick];
        return {
          ...current,
          slots: { ...current.slots, profiles: profilesNext }
        };
      }
      // Another region of the same sketch keeps the axis: it is still in
      // that plane. A new sketch has its own axes, so that slot empties.
      const sameSketch = existing[0]?.sketchId === pick.sketchId;
      return {
        ...current,
        slots: {
          ...current.slots,
          profiles: [pick],
          axisId: sameSketch ? current.slots.axisId : null
        }
      };
    });
  }, []);

  const setProfiles = useCallback(
    (profiles: readonly ProfilePick[], from?: readonly ProfilePick[]) => {
      setSession((current) =>
        current && (!from || current.slots.profiles === from)
          ? {
              ...current,
              slots: { ...current.slots, profiles: [...profiles] }
            }
          : current
      );
    },
    []
  );

  const setPicks = useCallback(
    (
      picks: {
        path?: readonly CurvePick[];
        guide?: readonly CurvePick[];
        faces?: readonly FacePick[];
        bodies?: readonly BodyPick[];
        edges?: readonly EdgePick[];
      },
      from?: Pick<InPlaceSlots, 'path' | 'guide' | 'faces' | 'bodies' | 'edges'>
    ) => {
      setSession((current) => {
        if (!current) return current;
        // A slot the live reseed replaced since the re-check read it keeps
        // the newer picks; the next re-check reads those.
        const take = <
          K extends 'path' | 'guide' | 'faces' | 'bodies' | 'edges'
        >(
          key: K
        ) =>
          picks[key] !== undefined &&
          (!from || current.slots[key] === from[key]);
        return {
          ...current,
          slots: {
            ...current.slots,
            ...(take('path') ? { path: [...picks.path!] } : {}),
            ...(take('guide') ? { guide: [...picks.guide!] } : {}),
            ...(take('faces') ? { faces: [...picks.faces!] } : {}),
            ...(take('bodies') ? { bodies: [...picks.bodies!] } : {}),
            ...(take('edges') ? { edges: [...picks.edges!] } : {})
          }
        };
      });
    },
    []
  );

  const pickAxis = useCallback((axisId: string) => {
    if (committingRef.current) return;
    setSession((current) =>
      current ? { ...current, slots: { ...current.slots, axisId } } : current
    );
  }, []);

  const pickCurve = useCallback((curve: CurvePick, additive = true) => {
    if (committingRef.current) return;
    setSession((current) => {
      if (!current) return current;
      // While Options say so, clicks build a sweep's guide rail instead.
      const slot = current.options.curves === 'guide' ? 'guide' : 'path';
      const path = current.slots[slot];
      const picked = path.some(
        (other) =>
          other.sketchId === curve.sketchId && other.entityId === curve.entityId
      );
      // A path lives in one sketch: a curve from another starts it over.
      const sameSketch = path[0]?.sketchId === curve.sketchId;
      const next = picked
        ? path.filter((other) => other.entityId !== curve.entityId)
        : additive && sameSketch
          ? [...path, curve]
          : [curve];
      return { ...current, slots: { ...current.slots, [slot]: next } };
    });
  }, []);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const pickFace = useCallback((face: FacePick) => {
    if (committingRef.current) return false;
    const current = sessionRef.current;
    const toolSpec = current ? IN_PLACE_TOOL_SPECS[current.tool] : null;
    if (!current || !toolSpec?.faceMode) return false;
    if (
      toolSpec.faceFilter === 'planar' &&
      face.surfaceType !== undefined &&
      face.surfaceType.toLowerCase() !== 'plane'
    ) {
      return false;
    }
    setSession((latest) => {
      if (!latest) return latest;
      const faces = latest.slots.faces;
      const sameBody = faces[0]?.bodyId === face.bodyId;
      let next: FacePick[];
      if (toolSpec.faceMode === 'one') {
        // One face: a click replaces it, or (on the same face) moves where
        // it was clicked, which is how a hole is repositioned.
        next = [face];
      } else {
        const picked = faces.some((other) => other.hash === face.hash);
        const placing =
          toolSpec.clickPlacesPoint !== undefined &&
          latest.options[toolSpec.clickPlacesPoint.optionId] ===
            toolSpec.clickPlacesPoint.value;
        if (placing && sameBody) {
          // The click places the point: a picked face keeps its place and
          // takes it, another joins with it, and no other face keeps one.
          const unplaced = faces.map((other) => {
            const { point: _point, ...rest } = other;
            return rest;
          });
          next = picked
            ? unplaced.map((other) =>
                other.hash === face.hash ? { ...other, ...face } : other
              )
            : [...unplaced, face];
        } else {
          // Faces of one body: a face of another starts the set over, and
          // a picked face clicked again comes back out.
          next = !sameBody
            ? [face]
            : picked
              ? faces.filter((other) => other.hash !== face.hash)
              : [...faces, face];
        }
      }
      return { ...latest, slots: { ...latest.slots, faces: next } };
    });
    return true;
  }, []);

  const addFaces = useCallback((faces: readonly FacePick[]) => {
    if (committingRef.current) return null;
    const current = sessionRef.current;
    const toolSpec = current ? IN_PLACE_TOOL_SPECS[current.tool] : null;
    if (!current || toolSpec?.faceMode !== 'many') return null;
    const accepted = faces.filter(
      (face) =>
        toolSpec.faceFilter !== 'planar' ||
        face.surfaceType === undefined ||
        face.surfaceType.toLowerCase() === 'plane'
    );
    const next = mergeSweptFaces(current.slots.faces, accepted);
    const merged = { ...current, slots: { ...current.slots, faces: next } };
    sessionRef.current = merged;
    setSession(merged);
    return next.length;
  }, []);

  const pickBody = useCallback((body: BodyPick) => {
    if (committingRef.current) return false;
    const current = sessionRef.current;
    const toolSpec = current ? IN_PLACE_TOOL_SPECS[current.tool] : null;
    if (!current || !toolSpec?.bodyMode) return false;
    setSession((latest) => {
      if (!latest) return latest;
      const bodies = latest.slots.bodies;
      const picked = bodies.some((other) => other.bodyId === body.bodyId);
      const next =
        toolSpec.bodyMode === 'one'
          ? [body]
          : picked
            ? bodies.filter((other) => other.bodyId !== body.bodyId)
            : [...bodies, body];
      // A new body has its own axis to turn about.
      const sameFirst = next[0]?.bodyId === bodies[0]?.bodyId;
      return {
        ...latest,
        slots: {
          ...latest.slots,
          bodies: next,
          axisId: sameFirst ? latest.slots.axisId : null
        }
      };
    });
    return true;
  }, []);

  const pickEdge = useCallback((edge: EdgePick) => {
    if (committingRef.current) return false;
    const current = sessionRef.current;
    const toolSpec = current ? IN_PLACE_TOOL_SPECS[current.tool] : null;
    if (!current || !toolSpec?.edgeMode) return false;
    setSession((latest) => {
      if (!latest) return latest;
      const edges = latest.slots.edges;
      const sameBody = edges[0]?.bodyId === edge.bodyId;
      const picked = edges.some((other) => other.hash === edge.hash);
      // Edges of one body, in pick order: an edge of another starts the set
      // over, and a picked one clicked again comes back out.
      const next = !sameBody
        ? [edge]
        : picked
          ? edges.filter((other) => other.hash !== edge.hash)
          : [...edges, edge];
      return { ...latest, slots: { ...latest.slots, edges: next } };
    });
    return true;
  }, []);

  const setEdges = useCallback((edges: readonly EdgePick[]) => {
    if (committingRef.current) return false;
    const current = sessionRef.current;
    const toolSpec = current ? IN_PLACE_TOOL_SPECS[current.tool] : null;
    if (!current || !toolSpec?.edgeMode) return false;
    setSession((latest) =>
      latest
        ? {
            ...latest,
            slots: { ...latest.slots, edges: sameBodyEdges(edges) }
          }
        : latest
    );
    return true;
  }, []);

  const pickPlane = useCallback((plane: PlanePick) => {
    if (committingRef.current) return false;
    const current = sessionRef.current;
    const toolSpec = current ? IN_PLACE_TOOL_SPECS[current.tool] : null;
    if (!current || !toolSpec?.wantsPlane) return false;
    setSession((latest) => {
      if (!latest) return latest;
      // A new plane starts unslid: an offset measured from the old one
      // means nothing on it.
      const offsetSpec = IN_PLACE_TOOL_SPECS[latest.tool].values.find(
        (value) => value.id === 'offset'
      );
      return {
        ...latest,
        slots: { ...latest.slots, plane },
        ...(offsetSpec
          ? {
              values: { ...latest.values, offset: offsetSpec.initial },
              // A typed offset goes too, or it would still stand in for the
              // reset value on the new plane.
              raws: Object.fromEntries(
                Object.entries(latest.raws).filter(([id]) => id !== 'offset')
              ),
              touched: latest.touched.filter((id) => id !== 'offset')
            }
          : {})
      };
    });
    return true;
  }, []);

  const setOption = useCallback((optionId: string, value: string) => {
    if (committingRef.current) return;
    setSession((current) => {
      if (!current) return current;
      const specs = IN_PLACE_TOOL_SPECS[current.tool].options ?? [];
      const optionSpec = specs.find((candidate) => candidate.id === optionId);
      // The operation of a boolean is its tool: the bodies stay picked.
      if (optionSpec?.switchesTool && value in IN_PLACE_TOOL_SPECS) {
        return {
          ...current,
          tool: value as InPlaceToolId,
          options: { ...current.options, [optionId]: value }
        };
      }
      const options = { ...current.options, [optionId]: value };
      // Two options that may not match (a grid's directions) trade places
      // rather than leave a pair the kernel refuses.
      const other = optionSpec?.distinctFrom;
      const otherSpec = specs.find((candidate) => candidate.id === other);
      if (other && otherSpec) {
        const otherValue = current.options[other] ?? otherSpec.initial;
        if (otherValue === value) {
          options[other] = current.options[optionId] ?? optionSpec.initial;
        }
      }
      return { ...current, options };
    });
  }, []);

  const writeValue = useCallback(
    (
      valueId: string,
      value: number,
      raw: string | undefined,
      typed: boolean
    ) => {
      if (committingRef.current) return false;
      const current = sessionRef.current;
      const valueSpec = current
        ? IN_PLACE_TOOL_SPECS[current.tool].values.find(
            (candidate) => candidate.id === valueId
          )
        : undefined;
      // An expression is stored as typed, so it must already be a value the
      // tool accepts: clamping it for the preview would show one value and
      // commit another. Nor is a typed end of an open range nudged inside
      // it, where its chip would still read as the refused end.
      if (
        current &&
        valueSpec &&
        (raw !== undefined || (typed && valueSpec.exclusive)) &&
        !valueInRange(valueSpec, value)
      ) {
        const whole = valueSpec.integer ? 'whole numbers ' : '';
        const range = valueSpec.exclusive
          ? `more than ${valueSpec.min ?? 0}${
              valueSpec.max === undefined
                ? ''
                : valueSpec.exclusive === 'min'
                  ? ` and at most ${valueSpec.max}`
                  : ` and less than ${valueSpec.max}`
            }`
          : valueSpec.max === undefined
            ? `${whole ? `${whole}of ` : ''}at least ${valueSpec.min ?? 0}`
            : `${whole}${valueSpec.min ?? 0} to ${valueSpec.max}`;
        setEntryRefusal({
          valueId,
          message: `${raw === undefined ? value : `${raw} is ${value}`}; ${IN_PLACE_TOOL_SPECS[current.tool].title} ${valueSpec.label.toLowerCase()} takes ${range}.`
        });
        return false;
      }
      // Only the refused value, taken now, lifts its refusal: another value
      // changing leaves the refused one still not what was typed.
      setEntryRefusal((refused) =>
        refused?.valueId === valueId ? null : refused
      );
      setSession((current) => {
        if (!current) return current;
        const valueSpec = IN_PLACE_TOOL_SPECS[current.tool].values.find(
          (candidate) => candidate.id === valueId
        );
        if (!valueSpec) return current;
        const raws = { ...current.raws };
        if (raw === undefined) delete raws[valueId];
        else raws[valueId] = raw;
        return {
          ...current,
          values: {
            ...current.values,
            // In range, a value stands as given: only one outside it (a
            // drag past an end) is brought back inside.
            [valueId]: valueInRange(valueSpec, value)
              ? value
              : clampValue(valueSpec, value)
          },
          raws,
          touched: current.touched.includes(valueId)
            ? current.touched
            : [...current.touched, valueId]
        };
      });
      return true;
    },
    []
  );
  const previewValue = useCallback(
    (valueId: string, value: number) =>
      writeValue(valueId, value, undefined, false),
    [writeValue]
  );
  const setValue = useCallback(
    (valueId: string, value: number, raw?: string) =>
      writeValue(valueId, value, raw, true),
    [writeValue]
  );
  const restoreValue = useCallback(
    (
      valueId: string,
      value: number,
      raw: string | undefined,
      wasTouched: boolean
    ) => {
      // Unset, it takes its default as the default stands now: the value
      // it followed may have moved while the entry was open (a bore dragged
      // under an open step chip).
      const restored =
        !wasTouched && valueId in defaultsRef.current
          ? defaultsRef.current[valueId]!
          : value;
      setSession((current) => {
        if (!current) return current;
        const raws = { ...current.raws };
        if (raw === undefined) delete raws[valueId];
        else raws[valueId] = raw;
        const others = current.touched.filter((id) => id !== valueId);
        return {
          ...current,
          values: { ...current.values, [valueId]: restored },
          raws,
          touched: wasTouched ? [...others, valueId] : others
        };
      });
    },
    []
  );

  // Done waits for a valid preview of exactly what it would commit: a pick
  // that changed the request since the last frame has not been shown yet.
  const canFinish = Boolean(
    !committing &&
    !entryRefusal &&
    request &&
    previewValid &&
    previewedKey !== null &&
    previewedKey === requestKey
  );

  const done = useCallback(() => {
    const current = requestRef.current;
    if (!current || !spec || !canFinish) return false;
    if (requestKeyRef.current !== previewedKey) return false;
    const editing = editRef.current;
    // A command stays open until its commit is validated, so a refusal (the
    // model moved meanwhile, another exact operation held the lock) leaves
    // it there to correct or retry rather than gone with its picks.
    setCommitting(true);
    commitToken.current += 1;
    const token = commitToken.current;
    const landed = optionsRef.current.commit(
      current,
      editing?.name ?? spec.featureName ?? spec.title,
      editing,
      () => commitToken.current !== token
    );
    if (!editing) {
      if (!landed) {
        end();
      } else {
        void landed.then(
          (committed) => {
            // Only the command that was committing: one started since is
            // its own.
            if (commitToken.current !== token) return;
            if (committed) end();
            else setCommitting(false);
          },
          () => {
            if (commitToken.current === token) setCommitting(false);
          }
        );
      }
    }
    return true;
  }, [spec, canFinish, previewedKey, end, setCommitting]);

  const settleEdit = useCallback(
    (edit: InPlaceEditSeed, committed: boolean) => {
      // Only the edit that was committing: one armed since is its own.
      if (editRef.current !== edit) return;
      setCommitting(false);
      if (committed) end();
    },
    [end, setCommitting]
  );

  const cancel = useCallback(
    (quiet = false) => {
      if (!spec) return true;
      const editing = editRef.current;
      // A Done still validating is not taken back by Cancel, which would say
      // nothing was added (or changed) while the commit could still land:
      // it waits for the outcome. A quiet close (another command, a new
      // selection, a replaced document) withdraws the candidate instead,
      // which the host's validated run checks before it commits.
      if (committingRef.current && !quiet) {
        optionsRef.current.onStatus(
          editing
            ? `${editing.name} is still being saved · wait for it to finish.`
            : `${spec.title} is still being added · wait for it to finish.`
        );
        return false;
      }
      end();
      if (!quiet) {
        optionsRef.current.onStatus(
          editing
            ? `Edit canceled; ${editing.name} is unchanged.`
            : `${spec.title} canceled; nothing was added.`
        );
      }
      return true;
    },
    [spec, end]
  );

  const handles = useMemo(
    () => (spec ? spec.handles(slots, values, ctx, chosen) : []),
    [spec, slots, values, ctx, chosen]
  );
  // A refused entry holds Done until its value is taken, or until the value
  // no longer applies: a choice (a hole's style) that hides its chip.
  useEffect(() => {
    if (
      entryRefusal &&
      !handles.some((handle) => handle.valueId === entryRefusal.valueId)
    ) {
      setEntryRefusal(null);
    }
  }, [entryRefusal, handles]);
  const optionSpecs = useMemo(
    () =>
      (spec?.options ?? [])
        .filter((option) => !editSeed?.lockedOptions.includes(option.id))
        .map((option) => {
          const own = editSeed?.choices[option.id];
          return own
            ? { ...option, choices: [...option.choices, ...own] }
            : option;
        }),
    [spec, editSeed]
  );

  return {
    active: session !== null,
    tool: session?.tool ?? null,
    spec,
    slots,
    axisCandidates,
    handles,
    values,
    raws: session?.raws ?? EMPTY_RAWS,
    options: chosen,
    optionSpecs,
    editing: editSeed,
    hint: spec ? spec.hint(slots, chosen) : '',
    refusal: entryRefusal?.message ?? refusal,
    canFinish,
    edit,
    start,
    pickProfile,
    setProfiles,
    setPicks,
    pickAxis,
    pickCurve,
    pickFace,
    addFaces,
    pickBody,
    pickEdge,
    setEdges,
    pickPlane,
    setOption,
    previewValue,
    setValue,
    touched: session?.touched ?? EMPTY_TOUCHED,
    restoreValue,
    done,
    settleEdit,
    cancel
  };
}

/** Edges as a command holds them: the first one's body only, once each. */
function sameBodyEdges(edges: readonly EdgePick[]): EdgePick[] {
  const body = edges[0]?.bodyId;
  const seen = new Set<number>();
  return edges.filter((edge) => {
    if (edge.bodyId !== body || seen.has(edge.hash)) return false;
    seen.add(edge.hash);
    return true;
  });
}

/**
 * `picked` with a sweep's faces added. One body: the body already picked,
 * else the body the sweep caught most faces of (the first, on a tie).
 */
export function mergeSweptFaces(
  picked: readonly FacePick[],
  swept: readonly FacePick[]
): FacePick[] {
  const counts = new Map<string, number>();
  for (const face of swept) {
    counts.set(face.bodyId, (counts.get(face.bodyId) ?? 0) + 1);
  }
  let body = picked[0]?.bodyId as string | undefined;
  if (body === undefined) {
    for (const [candidate, count] of counts) {
      if (body === undefined || count > counts.get(body)!) body = candidate;
    }
  }
  const next = [...picked];
  for (const face of swept) {
    if (face.bodyId !== body) continue;
    if (next.some((other) => other.hash === face.hash)) continue;
    next.push(face);
  }
  return next;
}
