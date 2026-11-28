import { listFeaturesInOrder, listNodesByKind } from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';

/**
 * The sketches of `document` a feature consumes: extrude and revolve
 * profiles, loft sections, a sweep's profile, path and guide. Read from the
 * document whose sketches are drawn, so a previewed version hides what its
 * own features consume, not what the project's later ones do (#2422).
 */
export function consumedSketchIds(document: ProjectDocument): Set<string> {
  const consumed = new Set<string>();
  for (const feature of listFeaturesInOrder(document)) {
    const data = feature.data as {
      featureKind: string;
      sketchId?: string;
      sections?: { sketchId: string }[];
      profile?: { sketchId?: string };
      path?: { sketchId?: string };
      guide?: { sketchId?: string };
    };
    // A sketch feature's own row references its sketch without consuming it.
    if (data.featureKind === 'sketch') {
      continue;
    }
    if (typeof data.sketchId === 'string') {
      consumed.add(data.sketchId);
    }
    for (const section of data.sections ?? []) {
      consumed.add(section.sketchId);
    }
    if (typeof data.profile?.sketchId === 'string') {
      consumed.add(data.profile.sketchId);
    }
    if (typeof data.path?.sketchId === 'string') {
      consumed.add(data.path.sketchId);
    }
    // A sweep's guide rail is consumed by the sweep exactly as its path is.
    if (typeof data.guide?.sketchId === 'string') {
      consumed.add(data.guide.sketchId);
    }
  }
  return consumed;
}

/**
 * The sketches of `document` not drawn: consumed ones unless shown by hand,
 * and any hidden by hand.
 */
export function hiddenSketchIds(
  document: ProjectDocument,
  overrides: Readonly<Record<string, boolean>>,
  consumed: ReadonlySet<string> = consumedSketchIds(document)
): Set<string> {
  const hidden = new Set<string>();
  for (const sketch of listNodesByKind(document, 'sketch')) {
    const visible =
      overrides[sketch.sketchId] ?? !consumed.has(sketch.sketchId);
    if (!visible) {
      hidden.add(sketch.sketchId);
    }
  }
  return hidden;
}

/**
 * The per-sketch visibility overrides after one sketch is shown or hidden.
 * An override that matches the sketch's default is dropped, and so is one for
 * a sketch no longer in the document, so the persisted map (read back capped
 * at its newest entries) holds only choices that still mean something. The
 * changed sketch moves to the end, keeping the map ordered oldest first.
 */
export function toggledSketchVisibility(
  current: Readonly<Record<string, boolean>>,
  sketchId: string,
  visible: boolean,
  defaultVisible: boolean,
  liveSketchIds: ReadonlySet<string>
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(current)) {
    if (id !== sketchId && liveSketchIds.has(id)) next[id] = value;
  }
  if (visible !== defaultVisible) next[sketchId] = visible;
  return next;
}
