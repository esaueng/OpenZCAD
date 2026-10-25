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
  type ImagePlacement,
  type ImageSlot,
  type InPlaceContext,
  type InPlaceRequest,
  type InPlaceSlots,
  type InPlaceToolId,
  type InPlaceToolSpec,
  type PlanePick,
  type ProfilePick,
  type RefPick
} from '../lib/inPlace/tools';
import { placeImage as placedImage } from '../lib/inPlace/image';
import type { RevolveAxisCandidate } from '../lib/inPlace/revolve';
import type { PlacementPick } from '../lib/inPlace/primitives';

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
  /**
   * Proves a result that adds no body (a datum) built: throws the refusal
   * when it did not. A command with it is judged by it, not by a body.
   */
  check?(derived: ProjectDocument['derived']): void;
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
   * refusal names it as the commit would.
   */
  buildCommand(request: InPlaceRequest, title: string): InPlaceBuiltCommand;
  /** Commits a request through the validated-feature path. */
  commit(request: InPlaceRequest, title: string): void;
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
    placement: PlacementPick | null;
    refs: RefPick[];
    image: ImageSlot | null;
  };
  options: Record<string, string>;
  values: Record<string, number>;
  /** Expressions typed into the keypad, stored instead of their numbers. */
  raws: Record<string, string>;
  /** Values the user has set, which the picks' defaults leave alone. */
  touched: string[];
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
  /** What Done would build now, or null while a slot is still empty. */
  request: InPlaceRequest | null;
  hint: string;
  refusal: string | null;
  canFinish: boolean;
  start(
    tool: InPlaceToolId,
    profiles?: ProfilePick[],
    faces?: FacePick[],
    bodies?: BodyPick[],
    extra?: { refs?: RefPick[]; image?: ImageSlot }
  ): void;
  pickProfile(pick: ProfilePick, additive?: boolean): void;
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
  /**
   * A primitive's footprint drag: where it was drawn, and the values it set
   * (the pressed point and the footprint's sizes). Refused (false) when the
   * command is placed some other way.
   */
  placeFootprint(
    placement: PlacementPick,
    values: Record<string, number>
  ): boolean;
  /** A datum source: refused (false) when the tool takes no such source. */
  pickRef(ref: RefPick): boolean;
  /** A plane or a point for the picture being placed. */
  placeImage(placement: ImagePlacement): boolean;
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
  plane: null,
  placement: null,
  refs: [],
  image: null
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
  const ctx: InPlaceContext = useMemo(
    () => ({
      sketchViews: options.sketchViews,
      datumAxes: options.datumAxes,
      datumLabel: (featureId) => optionsRef.current.datumLabel(featureId),
      linearSnap: options.linearSnap ?? null,
      bodyBounds: (bodyId) => optionsRef.current.bodyBounds?.(bodyId) ?? null,
      imagePlaneBasis: (plane) =>
        optionsRef.current.imagePlaneBasis?.(plane) ?? null
    }),
    [options.sketchViews, options.datumAxes, options.linearSnap]
  );

  const profiles = session?.slots.profiles;
  const bodyCount = session?.slots.bodies.length ?? 0;
  const axisCandidates = useMemo(() => {
    if (!spec?.wantsAxis || !profiles) return [];
    if (spec.axisSource === 'datum' || spec.axisSource === 'world') {
      // A body's turn: its axis lines, once the body is picked.
      return bodyCount > 0
        ? axisCandidatesFor(EMPTY_SLOTS, ctx, spec.axisSource)
        : [];
    }
    return axisCandidatesFor({ ...EMPTY_SLOTS, profiles }, ctx);
  }, [spec, profiles, bodyCount, ctx]);
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
            placement: session.slots.placement,
            refs: session.slots.refs,
            image: session.slots.image
          }
        : EMPTY_SLOTS,
    [session, axisCandidates]
  );

  const heldValues = useMemo(() => session?.values ?? {}, [session?.values]);
  /** Every value as a number, its initial one where none is set. */
  const numbers = useMemo(() => {
    const out: Record<string, number> = {};
    for (const valueSpec of spec?.values ?? []) {
      out[valueSpec.id] = heldValues[valueSpec.id] ?? valueSpec.initial;
    }
    return out;
  }, [spec, heldValues]);
  // A linked value is read from the others each time, never held.
  const values = useMemo(() => {
    if (!spec?.linked) return heldValues;
    const out = { ...heldValues };
    for (const [id, link] of Object.entries(spec.linked)) {
      const read = link.read(slots, numbers);
      if (read !== null) out[id] = read;
    }
    return out;
  }, [spec, heldValues, slots, numbers]);

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
    const out: Record<string, ParamValue> = { ...heldValues };
    for (const [id, raw] of Object.entries(session?.raws ?? {})) out[id] = raw;
    return out;
  }, [heldValues, session?.raws]);
  const chosen = useMemo(() => session?.options ?? {}, [session?.options]);
  const request = useMemo(
    () =>
      spec && spec.ready(slots, ctx)
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
        check?: InPlaceBuiltCommand['check'];
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
        const command = optionsRef.current.buildCommand(current, title);
        command.validate(base);
        const built = command.apply(base);
        builtFrames.set(built, {
          key: JSON.stringify(current),
          bodyId: command.resultBodyId,
          ...(command.check ? { check: command.check } : {})
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
        // A datum adds no body: its own check proves it resolved.
        let unresolved: string | null = null;
        if (result && frame?.check) {
          try {
            frame.check(result.derived);
          } catch (error) {
            unresolved =
              error instanceof Error ? error.message : 'This did not resolve.';
          }
        }
        const valid = Boolean(
          result &&
          (frame?.check
            ? unresolved === null
            : bodyId && result.derived.bodyRepresentations[bodyId]) &&
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
              unresolved ??
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
  const instant = spec?.instant === true;
  useEffect(() => {
    if (!requestKey || instant) {
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
  }, [requestKey, instant, options.baseVersion, preview]);

  const end = useCallback(() => {
    preview.clear();
    setSession(null);
    setRefusal(null);
    setEntryRefusal(null);
    setPreviewValid(false);
    optionsRef.current.publishPreview(null);
  }, [preview]);

  const start = useCallback(
    (
      tool: InPlaceToolId,
      initial: ProfilePick[] = [],
      initialFaces: FacePick[] = [],
      initialBodies: BodyPick[] = [],
      extra: { refs?: RefPick[]; image?: ImageSlot } = {}
    ) => {
      const toolSpec = IN_PLACE_TOOL_SPECS[tool];
      preview.clear();
      optionsRef.current.publishPreview(null);
      setRefusal(null);
      setEntryRefusal(null);
      setPreviewValid(false);
      setSession({
        tool,
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
          placement: null,
          refs: toolSpec.takeRef
            ? (extra.refs ?? []).reduce<RefPick[]>(
                (refs, ref) => toolSpec.takeRef!(refs, ref),
                []
              )
            : [],
          image: extra.image ?? null
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

  const placeFootprint = useCallback(
    (placement: PlacementPick, placed: Record<string, number>) => {
      const current = sessionRef.current;
      const toolSpec = current ? IN_PLACE_TOOL_SPECS[current.tool] : null;
      if (!current || !toolSpec?.footprint) return false;
      // A drawn value replaces a refused typed one, and its refusal with it.
      setEntryRefusal((refused) =>
        refused && refused.valueId in placed ? null : refused
      );
      setSession((latest) => {
        if (!latest) return latest;
        const specs = IN_PLACE_TOOL_SPECS[latest.tool].values;
        const values = { ...latest.values };
        const raws = { ...latest.raws };
        const touched = [...latest.touched];
        for (const [id, value] of Object.entries(placed)) {
          const valueSpec = specs.find((candidate) => candidate.id === id);
          if (!valueSpec) continue;
          // A drawn size replaces a typed one: the drag is the newer word.
          values[id] = clampValue(valueSpec, value);
          delete raws[id];
          if (!touched.includes(id)) touched.push(id);
        }
        return {
          ...latest,
          slots: { ...latest.slots, placement },
          values,
          raws,
          touched
        };
      });
      return true;
    },
    []
  );

  const pickRef = useCallback((ref: RefPick) => {
    const current = sessionRef.current;
    const toolSpec = current ? IN_PLACE_TOOL_SPECS[current.tool] : null;
    if (
      !current ||
      !toolSpec?.takeRef ||
      !toolSpec.refKinds?.includes(ref.kind)
    )
      return false;
    setSession((latest) =>
      latest
        ? {
            ...latest,
            slots: {
              ...latest.slots,
              refs: toolSpec.takeRef!(latest.slots.refs, ref)
            }
          }
        : latest
    );
    return true;
  }, []);

  const placeImage = useCallback(
    (placement: ImagePlacement) => {
      const current = sessionRef.current;
      if (!current?.slots.image) return false;
      // A plane that has not resolved has nowhere to put the picture.
      if (placement.plane && !ctx.imagePlaneBasis?.(placement.plane)) {
        setRefusal(
          'This plane has not resolved, so the picture cannot lie on it. Pick another.'
        );
        return true;
      }
      setRefusal(null);
      // New picks are measured afresh: a distance refused for the old
      // pair no longer stands.
      const linked = IN_PLACE_TOOL_SPECS[current.tool].linked ?? {};
      setEntryRefusal((refused) =>
        refused && refused.valueId in linked ? null : refused
      );
      setSession((latest) => {
        const image = latest?.slots.image;
        if (!latest || !image) return latest;
        const next = placedImage(image, placement, latest.options.clicks, ctx, {
          ...numbersFor(latest)
        });
        // A plane picked (even the same one) means clicks place again.
        const options =
          placement.plane && latest.options.clicks === 'plane'
            ? { ...latest.options, clicks: 'place' }
            : latest.options;
        if (next === image && options === latest.options) return latest;
        const replaned = next.plane !== image.plane;
        return {
          ...latest,
          options,
          slots: { ...latest.slots, image: next },
          ...(replaned
            ? {
                // A new plane starts unslid.
                values: { ...latest.values, offset: 0 },
                raws: Object.fromEntries(
                  Object.entries(latest.raws).filter(([id]) => id !== 'offset')
                ),
                touched: latest.touched.filter((id) => id !== 'offset')
              }
            : {})
        };
      });
      return true;
    },
    [ctx]
  );

  const setOption = useCallback((optionId: string, value: string) => {
    // A refused entry was never applied, and a new choice (a hole's style)
    // may not even show its value: the refusal no longer holds Done. A
    // linked value's refusal stands, though: what it measures (a picture's
    // scale picks) is still there, and only a taken value or new picks
    // answer it.
    const tool = sessionRef.current?.tool;
    const linked = (tool && IN_PLACE_TOOL_SPECS[tool].linked) || {};
    setEntryRefusal((refused) =>
      refused && refused.valueId in linked ? refused : null
    );
    setSession((current) => {
      if (!current) return current;
      const specs = IN_PLACE_TOOL_SPECS[current.tool].options ?? [];
      const optionSpec = specs.find((candidate) => candidate.id === optionId);
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
      const link = current
        ? IN_PLACE_TOOL_SPECS[current.tool].linked?.[valueId]
        : undefined;
      if (current && link) {
        // Written into the values it is read from, as numbers: what it
        // measures is not parametric.
        const latest = sessionRef.current!;
        const slotsNow = slotsOf(latest);
        const written =
          valueSpec && clampValue(valueSpec, value) === value
            ? link.write(slotsNow, numbersFor(latest), value)
            : null;
        if (!written) {
          // An entry refusal, so Done waits: the value shown was refused,
          // and the width it would have set is not what was asked for.
          setEntryRefusal({
            valueId,
            message: `${IN_PLACE_TOOL_SPECS[current.tool].title} cannot take ${raw ?? value} for its ${valueSpec?.label.toLowerCase() ?? 'value'}.`
          });
          return false;
        }
        setEntryRefusal((refused) =>
          refused?.valueId === valueId ? null : refused
        );
        setSession((latestSession) => {
          if (!latestSession) return latestSession;
          const specs = IN_PLACE_TOOL_SPECS[latestSession.tool].values;
          const next = { ...latestSession.values };
          const raws = { ...latestSession.raws };
          for (const [id, number] of Object.entries(written)) {
            const target = specs.find((candidate) => candidate.id === id);
            next[id] = target ? clampValue(target, number) : number;
            delete raws[id];
          }
          return {
            ...latestSession,
            values: next,
            raws,
            touched: [
              ...latestSession.touched,
              ...Object.keys(written).filter(
                (id) => !latestSession.touched.includes(id)
              )
            ]
          };
        });
        return true;
      }
      // A typed value must already be one the tool accepts. An expression
      // is stored as typed, so clamping it for the preview would show one
      // value and commit another; a typed number clamped would build what
      // was not asked for (a −5 width as a sliver), and a typed end of an
      // open range nudged inside it would leave its chip reading as the
      // refused end. Only a drag clamps.
      if (
        current &&
        valueSpec &&
        typed &&
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
        setEntryRefusal({
          valueId,
          message: `${raw === undefined ? value : `${raw} is ${value}`}; ${IN_PLACE_TOOL_SPECS[current.tool].title} ${valueSpec.label.toLowerCase()} takes ${range}.`
        });
        return false;
      }
      // In range alone, a value may still not stand beside the others (a
      // cone's second zero radius): typed, it is refused; dragged, it stays.
      const crossed =
        current && valueSpec
          ? (IN_PLACE_TOOL_SPECS[current.tool].refuseValue?.(
              valueId,
              value,
              current.values
            ) ?? null)
          : null;
      if (crossed) {
        if (typed) {
          setEntryRefusal({
            valueId,
            message: `${raw === undefined ? value : `${raw} is ${value}`}; ${crossed}`
          });
        }
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
        // In range, a value stands as given: only one outside it (a drag
        // past an end) is brought back inside.
        const next = valueInRange(valueSpec, value)
          ? value
          : clampValue(valueSpec, value);
        return {
          ...current,
          values: {
            ...current.values,
            ...carriedValues(current, valueId, next),
            [valueId]: next
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
          // What moved with the entry's previews goes back with it (a hung
          // box's corner, with its height).
          values: {
            ...current.values,
            ...carriedValues(current, valueId, restored),
            [valueId]: restored
          },
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
    !entryRefusal &&
    request &&
    (instant ||
      (previewValid && previewedKey !== null && previewedKey === requestKey))
  );

  const done = useCallback(() => {
    const current = requestRef.current;
    if (!current || !spec || !canFinish) return false;
    if (!spec.instant && requestKeyRef.current !== previewedKey) return false;
    end();
    optionsRef.current.commit(current, spec.featureName ?? spec.title);
    return true;
  }, [spec, canFinish, previewedKey, end]);

  const cancel = useCallback(
    (quiet = false) => {
      if (!spec) return;
      end();
      if (!quiet) {
        optionsRef.current.onStatus(
          `${spec.title} canceled; nothing was added.`
        );
      }
    },
    [spec, end]
  );

  const handles = useMemo(
    () => (spec ? spec.handles(slots, values, ctx, chosen) : []),
    [spec, slots, values, ctx, chosen]
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
    request,
    hint: spec ? spec.hint(slots, chosen, ctx) : '',
    refusal: entryRefusal?.message ?? refusal,
    canFinish,
    start,
    pickProfile,
    pickAxis,
    pickCurve,
    pickFace,
    addFaces,
    pickBody,
    pickPlane,
    placeFootprint,
    pickRef,
    placeImage,
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
 * The values that move with `valueId` becoming `value` (a spec's `carries`),
 * leaving any held as a typed expression alone.
 */
function carriedValues(
  session: Session,
  valueId: string,
  value: number
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(
      IN_PLACE_TOOL_SPECS[session.tool].carries?.(
        valueId,
        value,
        session.values,
        { ...EMPTY_SLOTS, placement: session.slots.placement }
      ) ?? {}
    ).filter(([id]) => session.raws[id] === undefined)
  );
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

/** A session's slots as the specs read them (its axis left unresolved). */
function slotsOf(session: Session): InPlaceSlots {
  return {
    profiles: session.slots.profiles,
    axis: null,
    path: session.slots.path,
    guide: session.slots.guide,
    faces: session.slots.faces,
    bodies: session.slots.bodies,
    plane: session.slots.plane,
    refs: session.slots.refs,
    image: session.slots.image
  };
}

/** A session's values as numbers, its initial one where none is set. */
function numbersFor(session: Session): Record<string, number> {
  const out: Record<string, number> = {};
  for (const valueSpec of IN_PLACE_TOOL_SPECS[session.tool].values) {
    out[valueSpec.id] = session.values[valueSpec.id] ?? valueSpec.initial;
  }
  return out;
}
