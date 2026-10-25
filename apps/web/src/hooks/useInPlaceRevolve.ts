import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlaneBasis } from '@openzcad/geometry';
import type {
  BodyId,
  FeatureId,
  ParamValue,
  ProjectDocument,
  SketchId,
  SketchProfileReference,
  Vector3
} from '@openzcad/shared';
import { GEOMETRY_PREVIEW_SCHEDULING, LivePreview } from '../lib/livePreview';
import {
  clampRevolveAngle,
  revolveAngleInRange,
  revolveProfileRegions,
  revolveAxisCandidates,
  revolveHint,
  revolveRigPlacement,
  type RevolveAxisCandidate,
  type RevolveRigPlacement
} from '../lib/inPlace/revolve';

/**
 * State and behaviour of the in-place Revolve (U09 phase 1).
 *
 * The command has no form. Its profile comes from the selection or a region
 * click, its axis from a click on one of the lines the viewport draws, and
 * its angle from the handle (or the keypad the handle's chip opens). As soon
 * as profile and axis are known an exact preview runs through the same
 * command factory the commit uses, so what Done saves is what was shown.
 *
 * Kept out of App so the workspace component only wires it in.
 */

/** The parts of a sketch view this command reads. */
export interface InPlaceSketchView {
  sketchId: SketchId;
  basis: PlaneBasis;
  regions: readonly {
    regionFingerprint: number;
    outer: readonly { x: number; y: number }[];
    /** The authored entities bounding it, which survive a renumbering. */
    sourceEntityIds?: readonly string[];
  }[];
}

/** A picked profile: its sketch, its stored reference, and which region. */
export interface InPlaceProfilePick {
  sketchId: SketchId;
  reference: SketchProfileReference;
  regionFingerprint: number;
}

/** What a revolve command needs to be built, without names or ids. */
export interface InPlaceRevolveRequest {
  sketchId: SketchId;
  profile: SketchProfileReference;
  axis: RevolveAxisCandidate['choice'];
  /** Absent is a full turn, stored exactly as before partial revolves. */
  angleDeg?: ParamValue;
}

/** A built command, reduced to what preview and commit need from it. */
export interface InPlaceBuiltCommand {
  validate(document: ProjectDocument): void;
  apply(document: ProjectDocument): ProjectDocument;
  resultBodyId: BodyId | undefined;
}

export interface UseInPlaceRevolveOptions {
  sketchViews: readonly InPlaceSketchView[];
  document: ProjectDocument | null;
  /** The live document the preview builds on (the command manager's). */
  baseDocument(): ProjectDocument | null;
  derive(document: ProjectDocument): Promise<ProjectDocument['derived']>;
  /** Builds the same command the commit runs. */
  buildCommand(request: InPlaceRevolveRequest): InPlaceBuiltCommand;
  /** Commits a request through the validated-feature path. */
  commit(request: InPlaceRevolveRequest): void;
  publishPreview(preview: ProjectDocument | null): void;
  datumLabel(featureId: FeatureId): string;
  onStatus(message: string): void;
}

interface RevolveSession {
  profile: InPlaceProfilePick | null;
  axisId: string | null;
  angle: number;
  /** An expression typed into the keypad, stored instead of the number. */
  angleRaw: string | null;
}

export interface InPlaceRevolve {
  active: boolean;
  sketchId: SketchId | null;
  /** The picked region within that sketch. */
  regionFingerprint: number | null;
  axisCandidates: RevolveAxisCandidate[];
  axisId: string | null;
  angle: number;
  placement: RevolveRigPlacement | null;
  hint: string;
  refusal: string | null;
  canFinish: boolean;
  start(profile: InPlaceProfilePick | null): void;
  pickProfile(profile: InPlaceProfilePick): void;
  pickAxis(axisId: string): void;
  previewAngle(value: number): void;
  setAngle(value: number, raw?: string): void;
  done(): boolean;
  /** Ends the command; `quiet` when another action already says why. */
  cancel(quiet?: boolean): void;
}

function toWorld(basis: PlaneBasis, point: { x: number; y: number }): Vector3 {
  return {
    x: basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
    y: basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
    z: basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
  };
}

export function useInPlaceRevolve(
  options: UseInPlaceRevolveOptions
): InPlaceRevolve {
  const [session, setSession] = useState<RevolveSession | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [previewValid, setPreviewValid] = useState(false);
  /**
   * The angle the shown frame was built for. Done waits until it is the
   * session's angle: a drag or a typed value not previewed yet would commit
   * a solid nobody has seen, and a refusal would arrive after it closed.
   */
  const [previewedAngle, setPreviewedAngle] = useState<number | null>(null);
  const buildingAngleRef = useRef<number | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const previewBodyRef = useRef<BodyId | undefined>(undefined);

  const profile = session?.profile ?? null;
  const view = useMemo(
    () =>
      profile
        ? (options.sketchViews.find(
            (candidate) => candidate.sketchId === profile.sketchId
          ) ?? null)
        : null,
    [options.sketchViews, profile]
  );

  const axisCandidates = useMemo(
    () =>
      view
        ? revolveAxisCandidates(
            view.basis,
            options.document?.derived.datumAxes,
            optionsRef.current.datumLabel
          )
        : [],
    [view, options.document?.derived.datumAxes]
  );
  const axis =
    axisCandidates.find((candidate) => candidate.id === session?.axisId) ??
    null;

  const placement = useMemo(() => {
    if (!view || !axis) return null;
    // The picked region's outline, found again by its entities when an undo
    // or redo renumbered its fingerprint.
    const outline = (
      profile ? revolveProfileRegions(view.regions, profile) : []
    ).flatMap((region) =>
      region.outer.map((point) => toWorld(view.basis, point))
    );
    return revolveRigPlacement(outline, axis);
  }, [view, axis, profile]);

  // The request the preview and the commit share; null until buildable.
  const requestFor = useCallback(
    (angle: ParamValue): InPlaceRevolveRequest | null =>
      profile && axis
        ? {
            sketchId: profile.sketchId,
            profile: profile.reference,
            axis: axis.choice,
            ...(angle === 360 ? {} : { angleDeg: angle })
          }
        : null,
    [profile, axis]
  );
  const requestRef = useRef(requestFor);
  requestRef.current = requestFor;

  const preview = useRef(
    new LivePreview<ProjectDocument, ProjectDocument['derived']>({
      build: (value: number) => {
        buildingAngleRef.current = value;
        const request = requestRef.current(value);
        const base = optionsRef.current.baseDocument();
        if (!request || !base) return null;
        const command = optionsRef.current.buildCommand(request);
        command.validate(base);
        previewBodyRef.current = command.resultBodyId;
        return command.apply(base);
      },
      derive: (document) => optionsRef.current.derive(document),
      publish: (result) => {
        const bodyId = previewBodyRef.current;
        const valid = Boolean(
          result && bodyId && result.derived.bodyRepresentations[bodyId]
        );
        setPreviewValid(valid);
        setPreviewedAngle(buildingAngleRef.current);
        if (!result) return;
        if (valid) {
          setRefusal(null);
          optionsRef.current.publishPreview({
            ...result.document,
            derived: result.derived
          });
        } else {
          setRefusal(
            result.derived.warnings[0] ??
              'This revolve did not produce a valid body.'
          );
        }
      },
      onFailure: ({ error }) => {
        setPreviewValid(false);
        setRefusal(
          error instanceof Error
            ? error.message
            : 'Unable to preview this revolve.'
        );
      },
      ...GEOMETRY_PREVIEW_SCHEDULING
    })
  ).current;

  // A new profile or axis previews the current angle at once: the solid is
  // on screen the frame after the axis click, as in the reference.
  const axisId = axis?.id ?? null;
  // The document the preview builds on: an undo or redo replaces it, and a
  // frame of the old one must not stand for what Done would now commit.
  const baseVersion = options.document?.version ?? null;
  useEffect(() => {
    if (!profile || !axisId) return;
    // LivePreview keeps a completed frame by value alone, so the same angle
    // on a new profile, axis or base would republish the old solid: drop it.
    preview.clear();
    setPreviewValid(false);
    preview.request(sessionRef.current?.angle ?? 360);
  }, [profile, axisId, baseVersion, preview]);

  const end = useCallback(() => {
    preview.clear();
    previewBodyRef.current = undefined;
    setSession(null);
    setRefusal(null);
    setPreviewValid(false);
    optionsRef.current.publishPreview(null);
  }, [preview]);

  const start = useCallback((initialProfile: InPlaceProfilePick | null) => {
    setRefusal(null);
    setPreviewValid(false);
    setSession({
      profile: initialProfile,
      axisId: null,
      angle: 360,
      angleRaw: null
    });
  }, []);

  const pickProfile = useCallback((next: InPlaceProfilePick) => {
    setSession((current) => {
      if (!current) return current;
      // Another region of the same sketch keeps the axis: it is still in
      // that plane. A new sketch has its own axes, so the slot empties.
      const sameSketch = current.profile?.sketchId === next.sketchId;
      return {
        ...current,
        profile: next,
        axisId: sameSketch ? current.axisId : null
      };
    });
  }, []);

  const pickAxis = useCallback((next: string) => {
    setSession((current) => (current ? { ...current, axisId: next } : current));
  }, []);

  const previewAngle = useCallback(
    (value: number) => {
      const angle = clampRevolveAngle(value);
      setSession((current) =>
        current ? { ...current, angle, angleRaw: null } : current
      );
      preview.request(angle);
    },
    [preview]
  );

  const setAngle = useCallback(
    (value: number, raw?: string) => {
      // An expression is stored as typed, so it must already be an angle a
      // revolve accepts: clamping it for the preview would show one angle
      // and commit another.
      if (raw !== undefined && !revolveAngleInRange(value)) {
        setRefusal(
          `${raw} is ${value}°; a revolve takes more than 0° and up to 360°.`
        );
        return;
      }
      const angle = clampRevolveAngle(value);
      setSession((current) =>
        current ? { ...current, angle, angleRaw: raw ?? null } : current
      );
      preview.request(angle);
    },
    [preview]
  );

  const canFinish = Boolean(
    profile &&
    axis &&
    previewValid &&
    previewedAngle !== null &&
    previewedAngle === (session?.angle ?? 360)
  );

  const done = useCallback(() => {
    const current = sessionRef.current;
    if (!current || !canFinish) return false;
    // A full turn is stored as an absent angle (see `requestFor`).
    const angle: ParamValue = current.angleRaw ?? current.angle;
    const request = requestRef.current(angle);
    if (!request) return false;
    end();
    optionsRef.current.commit(request);
    return true;
  }, [canFinish, end]);

  const cancel = useCallback(
    (quiet = false) => {
      if (!sessionRef.current) return;
      end();
      if (!quiet)
        optionsRef.current.onStatus('Revolve canceled; nothing was added.');
    },
    [end]
  );

  return {
    active: session !== null,
    sketchId: profile?.sketchId ?? null,
    regionFingerprint: profile?.regionFingerprint ?? null,
    axisCandidates,
    axisId,
    angle: session?.angle ?? 360,
    placement,
    hint: revolveHint({ sketchId: profile?.sketchId ?? null, axis }),
    refusal,
    canFinish,
    start,
    pickProfile,
    pickAxis,
    previewAngle,
    setAngle,
    done,
    cancel
  };
}
