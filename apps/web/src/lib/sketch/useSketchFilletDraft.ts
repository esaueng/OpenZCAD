import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnyCommand } from '@openzcad/command-system';
import {
  millimetresPerUnit,
  type ProjectDocument,
  type SketchId,
  type SketchNode
} from '@openzcad/shared';
import type { KeypadRequest } from '../../components/NumericKeypad';
import { errorMessage } from '../errors';
import { evalParamValue } from '../model';
import { countLabel } from '../toasts';
import type { solvedSketchCommands } from './applySolve';
import type { SketchEditValidation } from './editing';
import type * as SketchFilletTools from './filletBatch';

interface FilletCommitHost {
  document: ProjectDocument;
  isCurrent(): boolean;
  solve(
    candidate: ProjectDocument,
    sketchId: SketchId
  ): Promise<Parameters<typeof solvedSketchCommands>[2]>;
  commit(
    base: ProjectDocument,
    sketchId: SketchId,
    commands: AnyCommand[],
    label: string,
    objectId: string | undefined,
    validation: SketchEditValidation
  ): Promise<boolean>;
}

export function useSketchFilletDraft(
  doc: ProjectDocument | null,
  editingSketchNode: SketchNode | null,
  armed: boolean,
  scope: Record<string, number>,
  filletKeypadOpen: boolean,
  blocked: boolean,
  setKeypad: (request: KeypadRequest | null) => void
) {
  const sketchFilletKey =
    doc && editingSketchNode && armed
      ? `${doc.projectId}:${editingSketchNode.sketchId}:${doc.version}`
      : null;
  const [filletDraft, setFilletDraft] = useState<{
    key: string;
    cornerIds: string[];
    firstLine?: string;
    radius?: number;
    rawRadius?: string;
    error?: string;
  } | null>(null);
  const fillet = filletDraft?.key === sketchFilletKey ? filletDraft : null;
  const [filletTools, setFilletTools] = useState<
    typeof SketchFilletTools | null
  >(null);
  const [filletLoadError, setFilletLoadError] = useState(false);
  const filletArmed = sketchFilletKey !== null;
  useEffect(() => {
    if (!filletArmed || filletTools) return;
    let canceled = false;
    import('./filletBatch').then(
      (tools) => {
        if (!canceled) setFilletTools(tools);
      },
      () => {
        if (!canceled) setFilletLoadError(true);
      }
    );
    return () => {
      canceled = true;
    };
  }, [filletArmed, filletTools]);
  const [filletRadiusPreview, setFilletRadiusPreview] = useState<number | null>(
    null
  );
  const [filletCheckingKey, setFilletCheckingKey] = useState<string | null>(
    null
  );
  const filletJob = useRef<symbol | null>(null);
  const filletChecking =
    sketchFilletKey !== null && filletCheckingKey === sketchFilletKey;
  const filletRadius =
    fillet?.radius ?? (doc ? 5 / millimetresPerUnit(doc.units) : 5);
  const shownFilletRadius =
    filletKeypadOpen && filletRadiusPreview !== null
      ? filletRadiusPreview
      : filletRadius;
  useEffect(() => {
    if (filletDraft && filletDraft.key !== sketchFilletKey) {
      filletJob.current = null;
      setFilletCheckingKey(null);
      setFilletDraft(null);
      setFilletRadiusPreview(null);
      if (filletKeypadOpen) setKeypad(null);
    }
  }, [filletDraft, filletKeypadOpen, setKeypad, sketchFilletKey]);
  const filletCorners = useMemo(
    () =>
      sketchFilletKey && doc && editingSketchNode && filletTools
        ? filletTools.listSketchFilletCorners(
            doc,
            editingSketchNode,
            (value) => evalParamValue(value, scope, doc.units) ?? undefined
          )
        : [],
    [doc, editingSketchNode, filletTools, scope, sketchFilletKey]
  );
  const filletCornerIds = fillet?.cornerIds;
  const filletPlan = useMemo(
    () =>
      doc && editingSketchNode && filletCornerIds?.length && filletTools
        ? filletTools.planSketchFilletBatch(
            doc,
            editingSketchNode,
            filletCornerIds,
            shownFilletRadius,
            (value) => evalParamValue(value, scope, doc.units) ?? undefined
          )
        : null,
    [
      doc,
      editingSketchNode,
      filletCornerIds,
      filletTools,
      scope,
      shownFilletRadius
    ]
  );
  const filletRefusal = filletLoadError
    ? 'Sketch Fillet could not load. Reopen the tool to retry.'
    : filletPlan?.status === 'refuse'
      ? filletPlan.reason
      : (fillet?.error ?? null);
  const filletCanFinish =
    filletPlan?.status === 'ready' &&
    !filletRefusal &&
    !filletKeypadOpen &&
    !blocked &&
    !filletChecking;
  const toggleSketchFilletCorner = useCallback(
    (id: string) => {
      if (
        !sketchFilletKey ||
        filletChecking ||
        filletKeypadOpen ||
        !filletCorners.some((corner) => corner.id === id)
      )
        return;
      setFilletDraft((previous) => {
        const current = previous?.key === sketchFilletKey ? previous : null;
        const cornerIds = current?.cornerIds ?? [];
        return {
          ...current,
          key: sketchFilletKey,
          firstLine: undefined,
          error: undefined,
          cornerIds: cornerIds.includes(id)
            ? cornerIds.filter((cornerId) => cornerId !== id)
            : [...cornerIds, id]
        };
      });
    },
    [filletChecking, filletCorners, filletKeypadOpen, sketchFilletKey]
  );

  function pickSketchFilletLine(objectId: string | null) {
    if (!sketchFilletKey || filletChecking || filletKeypadOpen) return;
    const onLine = filletCorners.filter(
      ({ a, b }) => a.objectId === objectId || b.objectId === objectId
    );
    const firstLine = fillet?.firstLine;
    if (firstLine && objectId && objectId !== firstLine) {
      const corner = onLine.find(
        ({ a, b }) => a.objectId === firstLine || b.objectId === firstLine
      );
      if (corner) {
        toggleSketchFilletCorner(corner.id);
        return;
      }
    }
    setFilletDraft({
      ...fillet,
      key: sketchFilletKey,
      cornerIds: fillet?.cornerIds ?? [],
      firstLine:
        !objectId || objectId === firstLine
          ? undefined
          : (firstLine ?? (onLine.length ? objectId : undefined)),
      error:
        objectId && objectId !== firstLine && (firstLine || !onLine.length)
          ? firstLine
            ? 'Those lines do not share an eligible corner.'
            : 'Pick a straight line that meets another line at a corner.'
          : undefined
    });
  }

  function openSketchFilletRadius(initial?: string) {
    if (!filletCornerIds?.length || filletChecking || filletKeypadOpen) return;
    setFilletRadiusPreview(null);
    setKeypad({
      kind: 'sketch-fillet',
      commandValueId: 'sketch-fillet-radius',
      label: 'Fillet radius',
      initial: initial ?? fillet?.rawRadius ?? String(filletRadius),
      selectInitial: initial === undefined,
      unitKind: 'length'
    });
  }

  function clearSketchFilletDraft() {
    filletJob.current = null;
    setFilletCheckingKey(null);
    setFilletDraft(null);
    setFilletRadiusPreview(null);
    setFilletLoadError(false);
    if (filletKeypadOpen) setKeypad(null);
  }

  function acceptRadius(radius: number, rawRadius: string) {
    setFilletDraft(
      (current) =>
        current && { ...current, radius, rawRadius, error: undefined }
    );
    setFilletRadiusPreview(null);
    setKeypad(null);
  }

  async function commitFillet(host: FilletCommitHost): Promise<string | null> {
    const base = host.document;
    if (
      !doc ||
      base.projectId !== doc.projectId ||
      base.version !== doc.version ||
      !editingSketchNode ||
      !filletTools ||
      !sketchFilletKey ||
      filletPlan?.status !== 'ready' ||
      !filletCanFinish ||
      filletJob.current
    )
      return null;

    const { sketchId } = editingSketchNode;
    const job = Symbol();
    filletJob.current = job;
    setFilletCheckingKey(sketchFilletKey);
    const isCurrent = () => filletJob.current === job && host.isCurrent();
    const label = `Fillet ${countLabel(filletPlan.arcs.length, 'corner', 'corners')}`;
    try {
      const commands = filletTools.sketchFilletBatchCommands(
        base,
        editingSketchNode,
        filletPlan,
        fillet?.rawRadius && !Number.isFinite(Number(fillet.rawRadius))
          ? fillet.rawRadius
          : filletRadius
      );
      const committed = await host.commit(
        base,
        sketchId,
        commands,
        label,
        undefined,
        {
          isCurrent,
          checkCandidate: async (candidate) => {
            const outcome = await host.solve(candidate, sketchId);
            const refusal = filletTools.sketchFilletCandidateRefusal(
              candidate,
              sketchId,
              outcome
            );
            if (refusal) throw new Error(refusal);
          }
        }
      );
      return committed ? label : null;
    } catch (error) {
      if (isCurrent()) {
        const message = errorMessage(
          error,
          'The sketch fillet could not be built.'
        );
        setFilletDraft((current) => current && { ...current, error: message });
      }
      return null;
    } finally {
      if (filletJob.current === job) {
        filletJob.current = null;
        setFilletCheckingKey(null);
      }
    }
  }

  return {
    active: filletArmed,
    loading: filletTools === null,
    checking: filletChecking,
    canFinish: filletCanFinish,
    refusal: filletRefusal,
    radius: shownFilletRadius,
    firstLine: fillet?.firstLine,
    cornerIds: filletCornerIds,
    corners: filletCorners,
    plan: filletPlan,
    toggle: toggleSketchFilletCorner,
    pickLine: pickSketchFilletLine,
    openRadius: openSketchFilletRadius,
    acceptRadius,
    previewRadius: setFilletRadiusPreview,
    reset: clearSketchFilletDraft,
    commit: commitFillet
  };
}
