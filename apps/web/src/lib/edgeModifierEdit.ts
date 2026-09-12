import { commandFactories } from '@openzcad/command-system';
import type { FeatureNode } from '@openzcad/shared';
import type { EdgeModifierFormValue } from '../components/forms/FeatureForms';

export function edgeModifierCommand(
  feature: FeatureNode | null,
  kind: 'fillet' | 'chamfer',
  value: EdgeModifierFormValue
) {
  if (!feature) {
    return kind === 'fillet'
      ? commandFactories.filletEdges(value)
      : commandFactories.chamferEdges(value);
  }
  return commandFactories.updateFeature(
    {
      featureId: feature.featureId,
      name: value.name,
      // The edge set travels with the edit, so a fillet can take more edges
      // after creation. Hash-only sets clear the stored references: those
      // named the old set, and the kernel resolves the new one by fingerprint.
      data: {
        edgeHashes: value.edgeHashes,
        edgeReferences: value.edgeReferences,
        ...(kind === 'fillet'
          ? { radius: value.size }
          : {
              distance: value.size,
              ...(value.angleDeg !== undefined
                ? { angleDeg: value.angleDeg }
                : {})
            })
      }
    },
    `Edit ${value.name}`
  );
}

export function edgeModifierSliderRange(initialSize: number) {
  const max = Math.max(10, initialSize * 4);
  const step = 10 ** Math.floor(Math.log10(max / 1000));
  return { min: step, max, step };
}
