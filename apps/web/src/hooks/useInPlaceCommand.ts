import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BodyId, ParamValue, ProjectDocument } from '@openzcad/shared';
import { GEOMETRY_PREVIEW_SCHEDULING, LivePreview } from '../lib/livePreview';
import {
  IN_PLACE_TOOL_SPECS,
  axisCandidatesFor,
  clampValue,
  valueInRange,
  type BodyPick,
  type CurvePick,
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
  /** Commits a request through the validated-feature path. */
  commit(
    request: InPlaceRequest,
    title: string,
    edit: InPlaceEditSeed | null
  ): void;
  publishPreview(preview: ProjectDocument | null): void;
  onStatus(message: string): void;
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
  };
  options: Record<string, string>;
  values: Record<string, number>;
  /** Expressions typed into the keypad, stored instead of their numbers. */
  raws: Record<string, string>;
  /** Values the user has set, which the picks' defaults leave alone. */
  touched: string[];
  /** The stored feature this command edits; null while creating one. */
  edit: InPlaceEditSeed | null;
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
    bodies?: BodyPick[]
  ): void;
  pickProfile(pick: ProfilePick, additive?: boolean): void;
  /** Replaces the profiles (an edit's that no longer resolve, dropped). */
  setProfiles(profiles: readonly ProfilePick[]): void;
  /** Replaces the path, guide or face picks, as a re-check leaves them. */
  setPicks(picks: {
    path?: readonly CurvePick[];
    guide?: readonly CurvePick[];
    faces?: readonly FacePick[];
  }): void;
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
  /** Ends the command; `quiet` when another action already says why. */
  cancel(quiet?: boolean): void;
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
  plane: null
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
  const [previewValid, setPreviewValid] = useState(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const spec = session ? IN_PLACE_TOOL_SPECS[session.tool] : null;
  const specRef = useRef(spec);
  specRef.current = spec;
  const editSeed = session?.edit ?? null;
  const editRef = useRef(editSeed);
  editRef.current = editSeed;
  const ctx: InPlaceContext = useMemo(
    () => ({
      sketchViews: options.sketchViews,
      datumAxes: options.datumAxes,
      datumLabel: (featureId) => optionsRef.current.datumLabel(featureId),
      linearSnap: options.linearSnap ?? null,
      bodyBounds: (bodyId) => optionsRef.current.bodyBounds?.(bodyId) ?? null,
      evaluate: (value) => optionsRef.current.evaluate?.(value) ?? null,
      ...(editSeed ? { saved: editSeed.data } : {})
    }),
    [options.sketchViews, options.datumAxes, options.linearSnap, editSeed]
  );

  const profiles = session?.slots.profiles;
  const bodyCount = session?.slots.bodies.length ?? 0;
  const axisCandidates = useMemo(() => {
    if (!spec?.wantsAxis || !profiles) return [];
    // An edited feature's own axis line (a helix's typed one) comes first.
    const own = editSeed?.axes ?? [];
    if (spec.axisSource === 'datum' || spec.axisSource === 'world') {
      // A body's turn: its axis lines, once the body is picked.
      return bodyCount > 0
        ? [...own, ...axisCandidatesFor(EMPTY_SLOTS, ctx, spec.axisSource)]
        : [];
    }
    return [...own, ...axisCandidatesFor({ ...EMPTY_SLOTS, profiles }, ctx)];
  }, [spec, profiles, bodyCount, ctx, editSeed]);
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
            plane: session.slots.plane
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
      spec && spec.ready(slots)
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
    new WeakMap<ProjectDocument, { key: string; bodyId: BodyId | undefined }>()
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
          key: JSON.stringify(current),
          bodyId: command.resultBodyId
        });
        return built;
      },
      derive: (document) => optionsRef.current.derive(document),
      publish: (result) => {
        const frame = result ? builtFrames.get(result.document) : undefined;
        const bodyId = frame?.bodyId;
        // As strict as the card's preflight: a warning the base model did
        // not already carry refuses the preview, even with a body built.
        const known = new Set(
          optionsRef.current.baseDocument()?.derived.warnings ?? []
        );
        const fresh = result?.derived.warnings.find(
          (warning) => !known.has(warning)
        );
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
          setRefusal(
            fresh ??
              result.derived.warnings.at(-1) ??
              'This did not produce a valid body.'
          );
        }
      },
      onFailure: ({ error }) => {
        setPreviewValid(false);
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
  }, [requestKey, options.baseVersion, preview]);

  const end = useCallback(() => {
    preview.clear();
    setSession(null);
    setRefusal(null);
    setPreviewValid(false);
    optionsRef.current.publishPreview(null);
  }, [preview]);

  const start = useCallback(
    (
      tool: InPlaceToolId,
      initial: ProfilePick[] = [],
      initialFaces: FacePick[] = [],
      initialBodies: BodyPick[] = []
    ) => {
      const toolSpec = IN_PLACE_TOOL_SPECS[tool];
      preview.clear();
      optionsRef.current.publishPreview(null);
      setRefusal(null);
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
          plane: null
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
    [preview]
  );

  const edit = useCallback(
    (tool: InPlaceToolId, seed: InPlaceEditSeed) => {
      preview.clear();
      optionsRef.current.publishPreview(null);
      setRefusal(null);
      setPreviewValid(false);
      setSession({
        tool,
        edit: seed,
        slots: {
          profiles: seed.slots.profiles,
          axisId: seed.slots.axisId,
          path: seed.slots.path,
          guide: seed.slots.guide,
          faces: seed.slots.faces,
          bodies: seed.slots.bodies,
          plane: seed.slots.plane
        },
        options: { ...seed.options },
        values: { ...seed.values },
        raws: { ...seed.raws },
        touched: [...seed.touched]
      });
    },
    [preview]
  );

  const pickProfile = useCallback((pick: ProfilePick) => {
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

  const setProfiles = useCallback((profiles: readonly ProfilePick[]) => {
    setSession((current) =>
      current
        ? { ...current, slots: { ...current.slots, profiles: [...profiles] } }
        : current
    );
  }, []);

  const setPicks = useCallback(
    (picks: {
      path?: readonly CurvePick[];
      guide?: readonly CurvePick[];
      faces?: readonly FacePick[];
    }) => {
      setSession((current) =>
        current
          ? {
              ...current,
              slots: {
                ...current.slots,
                ...(picks.path ? { path: [...picks.path] } : {}),
                ...(picks.guide ? { guide: [...picks.guide] } : {}),
                ...(picks.faces ? { faces: [...picks.faces] } : {})
              }
            }
          : current
      );
    },
    []
  );

  const pickAxis = useCallback((axisId: string) => {
    setSession((current) =>
      current ? { ...current, slots: { ...current.slots, axisId } } : current
    );
  }, []);

  const pickCurve = useCallback((curve: CurvePick, additive = true) => {
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
        // Faces of one body: a face of another starts the set over, and a
        // picked face clicked again comes back out.
        next = !sameBody
          ? [face]
          : picked
            ? faces.filter((other) => other.hash !== face.hash)
            : [...faces, face];
      }
      return { ...latest, slots: { ...latest.slots, faces: next } };
    });
    return true;
  }, []);

  const addFaces = useCallback((faces: readonly FacePick[]) => {
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

  const pickPlane = useCallback((plane: PlanePick) => {
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
                : ` and less than ${valueSpec.max}`
            }`
          : valueSpec.max === undefined
            ? `${whole ? `${whole}of ` : ''}at least ${valueSpec.min ?? 0}`
            : `${whole}${valueSpec.min ?? 0} to ${valueSpec.max}`;
        setRefusal(
          `${raw === undefined ? value : `${raw} is ${value}`}; ${IN_PLACE_TOOL_SPECS[current.tool].title} ${valueSpec.label.toLowerCase()} takes ${range}.`
        );
        return false;
      }
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
    end();
    optionsRef.current.commit(
      current,
      editing?.name ?? spec.featureName ?? spec.title,
      editing
    );
    return true;
  }, [spec, canFinish, previewedKey, end]);

  const cancel = useCallback(
    (quiet = false) => {
      if (!spec) return;
      const editing = editRef.current;
      end();
      if (!quiet) {
        optionsRef.current.onStatus(
          editing
            ? `Edit canceled; ${editing.name} is unchanged.`
            : `${spec.title} canceled; nothing was added.`
        );
      }
    },
    [spec, end]
  );

  const handles = useMemo(
    () => (spec ? spec.handles(slots, values, ctx, chosen) : []),
    [spec, slots, values, ctx, chosen]
  );
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
    refusal,
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
    pickPlane,
    setOption,
    previewValue,
    setValue,
    touched: session?.touched ?? EMPTY_TOUCHED,
    restoreValue,
    done,
    cancel
  };
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
