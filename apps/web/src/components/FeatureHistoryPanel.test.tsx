import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
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

/** A plate and a fillet that uses it. */
function plateAndFillet() {
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
  return { document, plate: plate!, fillet: fillet! };
}

/** The document with one feature node replaced. */
function withFeature(
  document: ProjectDocument,
  id: string,
  change: (feature: FeatureNode) => FeatureNode
): ProjectDocument {
  return {
    ...document,
    nodes: Object.fromEntries(
      Object.entries(document.nodes).map(([key, node]) => [
        key,
        node.id === id ? change(node as FeatureNode) : node
      ])
    )
  };
}

it('names an inactive dependent the way its history row does', () => {
  const { document, plate, fillet } = plateAndFillet();
  const mark = (key: string) =>
    withFeature(document, fillet.id, (feature) => ({
      ...feature,
      metadata: { ...feature.metadata, [key]: true }
    }));
  const { rerender } = render(
    <FeatureHistoryPanel
      document={mark(FEATURE_SUPPRESSED_METADATA_KEY)}
      selectedId={plate.id}
      failure={null}
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  // The row says "suppressed" or "paused"; this list said "(inactive)".
  expect(screen.getByRole('listitem')).toHaveTextContent(
    'Round corners (suppressed)'
  );
  rerender(
    <FeatureHistoryPanel
      document={mark(FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY)}
      selectedId={plate.id}
      failure={null}
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  expect(screen.getByRole('listitem')).toHaveTextContent(
    'Round corners (paused)'
  );
});

it('does not count zero earlier features when only missing inputs are known', () => {
  const { document, fillet } = plateAndFillet();
  const orphaned = withFeature(
    document,
    fillet.id,
    (feature) =>
      ({
        ...feature,
        data: { ...feature.data, targetBodyId: 'body_gone' }
      }) as FeatureNode
  );
  render(
    <FeatureHistoryPanel
      document={orphaned}
      selectedId={fillet.id}
      failure={null}
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  const details = screen.getByRole('region', { name: 'History details' });
  expect(details).toHaveTextContent('Uses missing inputs');
  expect(details).not.toHaveTextContent('Uses 0');
  expect(details).toHaveTextContent('Earlier inputs could not be resolved.');
});

it('draws the failure actions as buttons, not as the alert text', () => {
  const { document, plate, fillet } = plateAndFillet();
  render(
    <FeatureHistoryPanel
      document={document}
      selectedId={plate.id}
      failure={
        new FeatureBuildError(
          'The radius does not fit.',
          fillet.featureId,
          fillet.name
        )
      }
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  expect(
    screen.getByRole('button', { name: 'Edit Round corners' })
  ).toHaveClass('secondary');
  expect(screen.getByRole('button', { name: 'Dismiss failure' })).toHaveClass(
    'secondary'
  );
});
