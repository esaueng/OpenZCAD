import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { roundedBlockDocument } from './chamfer-rounded-block';
import { loftedHollowDuct } from './lofted-hollow-duct';
import { mixedSeamFixture } from './mixed-seam';
import { twoFilletCylinder } from './two-fillet-cylinder';

/**
 * The fixed models the viewport look is judged on (U10). Each one stresses a
 * different part of the shading: planar faces meeting at sharp and rounded
 * edges, a curved boss rising out of a block (the reference-CAD comparison
 * shot), a large cylinder whose outline has no B-rep edge, a sphere whose
 * tessellation shows any reflection crawl, and a shell whose inner walls
 * face away from the key light.
 */
export interface LookdevScene {
  /** File-name stem for its captures. */
  readonly id: string;
  readonly title: string;
  build(adapter: ExactKernelAdapter): Promise<ProjectDocument>;
}

export const LOOKDEV_SCENES: readonly LookdevScene[] = [
  {
    id: 'rounded-block',
    title: 'Block with a large round and three small rounds',
    build: async (adapter) => (await roundedBlockDocument(adapter)).document
  },
  {
    id: 'boss-on-block',
    title: 'Rounded cylinder boss joined to a block',
    build: async (adapter) => (await mixedSeamFixture(adapter)).document
  },
  {
    id: 'filleted-cylinder',
    title: 'Wide cylinder with both rims filleted',
    build: async (adapter) => (await twoFilletCylinder(adapter)).document
  },
  {
    id: 'sphere',
    title: 'Sphere',
    build: async () =>
      addPrimitiveFeature(
        createProjectDocument('Lookdev sphere', toUserId('user_lookdev')),
        {
          name: 'Sphere',
          primitiveKind: 'sphere',
          dimensions: { radius: 20 }
        }
      )
  },
  {
    id: 'hollow-duct',
    title: 'Shelled loft, open at both ends',
    build: async (adapter) => (await loftedHollowDuct(adapter)).document
  }
];

/** The camera corners each scene is captured from. */
export const LOOKDEV_VIEWS = [
  { id: 'top-front-left', label: 'Top front left isometric view' },
  { id: 'top-back-right', label: 'Top back right isometric view' },
  { id: 'bottom-front-right', label: 'Bottom front right isometric view' }
] as const;
