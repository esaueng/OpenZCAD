/**
 * Pure selection → action capability resolution.
 *
 * This is the single policy surface for selection-first modeling. Viewport
 * handles, contextual cards, and keyboard routing consume the same result
 * instead of re-implementing topology checks independently.
 */

import type { FaceTopologyReferenceV5, FeatureId } from '@openzcad/shared';
import { UNSTABLE_FACE_SKETCH_REASON } from '../faceSketchAttachment';

export type SelectionActionId =
  | 'export-face-dxf'
  | 'offset-face'
  | 'resize-radial-face'
  | 'edit-fillet'
  | 'remove-fillet'
  | 'remove-face-feature'
  | 'sketch-on-face'
  | 'fillet'
  | 'chamfer'
  | 'extrude-region';

export type SelectionValueKind = 'distance' | 'diameter' | 'radius';
export type SelectionPreviewKind = 'transform-proxy' | 'exact-worker' | 'none';

export interface SelectionCapability {
  action: SelectionActionId;
  label: string;
  enabled: boolean;
  disabledReason?: string;
  /**
   * Something the user should know before choosing an enabled action — how a
   * sketch on a hash-only face is placed, for instance. Shown as the action's
   * title; never a reason to grey it out.
   */
  note?: string;
  valueKind?: SelectionValueKind;
  previewKind: SelectionPreviewKind;
  preferred: boolean;
}

export interface FaceCapabilityTarget {
  surfaceType: 'planar' | 'cylindrical' | 'other';
  hash?: number;
  /** Persistent exact identity when the current kernel projection proves it. */
  reference?: FaceTopologyReferenceV5;
  radius?: number;
  blendRadius?: number;
  /** Present only after lineage resolves to a live Fillet feature. */
  filletFeatureId?: FeatureId;
  /** Analytic imported blend with the exact resize kernel available. */
  canResizeImportedBlend?: boolean;
  /** Imported defeature is exposed only when its planar gate is proven. */
  canRemoveFaceFeature?: boolean;
}

export type CapabilitySelection =
  | { kind: 'face'; target: FaceCapabilityTarget }
  | { kind: 'edges'; count: number; sameBody: boolean }
  | { kind: 'region'; area: number };

function enabled(
  action: SelectionActionId,
  label: string,
  valueKind: SelectionValueKind | undefined,
  previewKind: SelectionPreviewKind,
  preferred = false
): SelectionCapability {
  return {
    action,
    label,
    enabled: true,
    ...(valueKind ? { valueKind } : {}),
    previewKind,
    preferred
  };
}

/**
 * Returns actions in their UI order. Unsupported actions are omitted unless a
 * disabled reason is useful to the person holding the current selection.
 */
export function selectionCapabilities(
  selection: CapabilitySelection
): SelectionCapability[] {
  switch (selection.kind) {
    case 'face': {
      const { target } = selection;
      if (
        (target.filletFeatureId || target.canResizeImportedBlend) &&
        target.blendRadius !== undefined &&
        Number.isFinite(target.blendRadius) &&
        target.blendRadius > 0
      ) {
        return [
          enabled('edit-fillet', 'Edit Fillet', 'radius', 'exact-worker', true),
          enabled('remove-fillet', 'Remove Fillet', undefined, 'exact-worker')
        ];
      }
      if (target.canRemoveFaceFeature) {
        return [
          enabled(
            'remove-face-feature',
            'Remove Blend',
            undefined,
            'exact-worker',
            true
          )
        ];
      }
      // Blend classification alone is not authority to mutate a face. Only a
      // live producing Fillet feature or the proven imported removal path may
      // expose an action.
      if (target.blendRadius !== undefined) {
        return [];
      }
      if (target.surfaceType === 'planar' && target.hash !== undefined) {
        // A face without current lineage still takes a sketch: it lands on a
        // fixed plane coincident with the face, and the note says so up front.
        const sketchCapability =
          target.reference?.currentHash === target.hash
            ? enabled('sketch-on-face', 'Sketch', undefined, 'none')
            : {
                ...enabled('sketch-on-face', 'Sketch', undefined, 'none'),
                note: UNSTABLE_FACE_SKETCH_REASON
              };
        return [
          enabled(
            'offset-face',
            'Offset Face',
            'distance',
            'transform-proxy',
            true
          ),
          sketchCapability,
          // A planar outline is exactly what a laser cutter consumes; the
          // export never mutates the body, so no geometry gate applies.
          enabled('export-face-dxf', 'Export DXF', undefined, 'exact-worker')
        ];
      }
      if (
        target.surfaceType === 'cylindrical' &&
        target.hash !== undefined &&
        target.radius !== undefined &&
        Number.isFinite(target.radius) &&
        target.radius > 0
      ) {
        return [
          enabled(
            'resize-radial-face',
            'Adjust Radius',
            'radius',
            'exact-worker',
            true
          )
        ];
      }
      return [];
    }
    case 'edges':
      if (selection.count === 0 || !selection.sameBody) {
        return [];
      }
      return [
        enabled('fillet', 'Fillet', 'radius', 'exact-worker', true),
        enabled('chamfer', 'Chamfer', 'distance', 'exact-worker')
      ];
    case 'region':
      return Number.isFinite(selection.area) && selection.area > 0
        ? [
            enabled(
              'extrude-region',
              'Extrude',
              'distance',
              'transform-proxy',
              true
            )
          ]
        : [];
  }
}

export function preferredCapability(
  capabilities: SelectionCapability[]
): SelectionCapability | null {
  return (
    capabilities.find(
      (capability) => capability.enabled && capability.preferred
    ) ??
    capabilities.find((capability) => capability.enabled) ??
    null
  );
}
