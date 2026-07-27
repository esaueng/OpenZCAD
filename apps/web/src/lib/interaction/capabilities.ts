/**
 * Pure selection → action capability resolution.
 *
 * This is the single policy surface for selection-first modeling. Viewport
 * handles, contextual cards, and keyboard routing consume the same result
 * instead of re-implementing topology checks independently.
 */

export type SelectionActionId =
  | 'offset-face'
  | 'resize-radial-face'
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
  valueKind?: SelectionValueKind;
  previewKind: SelectionPreviewKind;
  preferred: boolean;
}

export interface FaceCapabilityTarget {
  surfaceType: 'planar' | 'cylindrical' | 'other';
  hash?: number;
  diameter?: number;
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
      if (target.surfaceType === 'planar' && target.hash !== undefined) {
        return [
          enabled(
            'offset-face',
            'Offset Face',
            'distance',
            'transform-proxy',
            true
          ),
          enabled('sketch-on-face', 'Sketch', undefined, 'none')
        ];
      }
      if (
        target.surfaceType === 'cylindrical' &&
        target.hash !== undefined &&
        target.diameter !== undefined &&
        Number.isFinite(target.diameter) &&
        target.diameter > 0
      ) {
        return [
          enabled(
            'resize-radial-face',
            'Resize',
            'diameter',
            'transform-proxy',
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
