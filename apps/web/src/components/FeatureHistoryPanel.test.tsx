import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { FeatureHistoryPanel } from './FeatureHistoryPanel';
import { FeatureBuildError } from '../lib/featureValidation';

it('shows dependent history and routes a failed edit by feature identity', async () => {
  const base = addPrimitiveFeature(
    createProjectDocument('History', toUserId('user_test')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 20, depth: 8 }
    }
  );
  const { document } = filletEdges(base, {
    name: 'Round corners',
    targetBodyId: base.bodyOrder[0]!,
    edgeHashes: [1],
    size: 1
  });
  const [plate, fillet] = listFeaturesInOrder(document);
  const select = vi.fn();
  render(
    <FeatureHistoryPanel
      document={document}
      selectedId={plate!.id}
      failure={
        new FeatureBuildError(
          'The radius does not fit.',
          fillet!.featureId,
          fillet!.name
        )
      }
      onSelect={select}
      onResumeHistory={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  expect(screen.getByText('Affects 1 later feature')).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'The previous model is intact'
  );
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Edit Round corners' }));
  expect(select).toHaveBeenCalledWith(fillet!.id);
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Inspect Round corners' }));
  expect(select).toHaveBeenLastCalledWith(fillet!.id);
});
