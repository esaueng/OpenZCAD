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
      onDismissFailure={vi.fn()}
    />
  );
  expect(screen.getByText('Affects 1 later feature')).toBeVisible();
  // The row names the feature; the block does not repeat it, nor say the
  // ordinary state.
  expect(screen.queryByText('Plate', { exact: true })).toBeNull();
  expect(screen.queryByText('Included in the build')).toBeNull();
  expect(
    screen.getByText(/can break these later features/, { exact: false })
  ).toBeVisible();
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

it('draws nothing for a standalone feature that is in the build', () => {
  const document = addPrimitiveFeature(
    createProjectDocument('History', toUserId('user_test')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 20, depth: 8 }
    }
  );
  const [plate] = listFeaturesInOrder(document);
  const { container } = render(
    <FeatureHistoryPanel
      document={document}
      selectedId={plate!.id}
      failure={null}
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  // It used to read "Plate / Included in the build / No earlier features
  // feed this one. / Nothing later depends on it." — none of it news.
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByRole('region', { name: 'History details' })).toBeNull();
});

it('keeps the dependents and their warning for a feature others use', () => {
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
  const { rerender } = render(
    <FeatureHistoryPanel
      document={document}
      selectedId={plate!.id}
      failure={null}
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  const details = screen.getByRole('region', { name: 'History details' });
  expect(details).toHaveTextContent('Affects 1 later feature');
  expect(details).toHaveTextContent('can break these later features');
  expect(details).not.toHaveTextContent(/earlier feature/);

  // The last feature has inputs but no dependents: its inputs, no warning.
  rerender(
    <FeatureHistoryPanel
      document={document}
      selectedId={fillet!.id}
      failure={null}
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  const last = screen.getByRole('region', { name: 'History details' });
  expect(last).toHaveTextContent('Uses 1 earlier feature');
  expect(last).not.toHaveTextContent(/later/);
  expect(screen.queryByText(/Nothing later depends/)).toBeNull();
});
