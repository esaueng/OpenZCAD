import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
import {
  MIRROR_SOURCE_UNAVAILABLE,
  TARGET_BODY_UNAVAILABLE
} from '../lib/refusalLanguage';

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

it('says a step that built on a failed step stands on its unchanged input', () => {
  const base = addPrimitiveFeature(
    createProjectDocument('History', toUserId('user_test')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 20, depth: 8 }
    }
  );
  const rounded = filletEdges(base, {
    name: 'Round corners',
    targetBodyId: base.bodyOrder[0]!,
    edgeHashes: [1],
    size: 1
  });
  const { document } = filletEdges(rounded.document, {
    name: 'Round top',
    targetBodyId: rounded.bodyId,
    edgeHashes: [2],
    size: 1
  });
  const [, failed, dependent] = listFeaturesInOrder(document);
  render(
    <FeatureHistoryPanel
      document={document}
      selectedId={dependent!.id}
      failedFeatureIds={new Set([failed!.featureId])}
      failure={null}
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  expect(screen.getByText('Built on a failed step')).toBeVisible();
  expect(
    screen.getByText(
      /“Round corners” failed to build, so this step is built on that step's input unchanged\./
    )
  ).toBeVisible();
});

// A failing step's card words a typed refusal from its code, as the command
// bar does, and keeps the adapter's sentence out of it (preview check of
// f4c7f13: a resumed Mirror whose source is suppressed).
it("words a failing step's typed refusal from its code", () => {
  const { document, fillet } = plateAndFillet();
  const failing: ProjectDocument = {
    ...document,
    derived: {
      ...document.derived,
      warnings: ['Feature "Round corners": Mirror target is unavailable.'],
      featureWarnings: [
        {
          featureId: fillet.featureId,
          featureName: 'Round corners',
          kind: 'build-failed',
          message: 'Feature "Round corners": Mirror target is unavailable.',
          kernelRefusal: {
            family: 'reference',
            category: 'invalid_input',
            code: 'mirror_source_unavailable'
          }
        }
      ]
    }
  };
  render(
    <FeatureHistoryPanel
      document={failing}
      selectedId={fillet.id}
      failure={null}
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  const details = screen.getByRole('region', { name: 'History details' });
  expect(details).toHaveTextContent('Needs repair');
  expect(screen.getByRole('alert')).toHaveTextContent(
    MIRROR_SOURCE_UNAVAILABLE
  );
  expect(details).not.toHaveTextContent('Mirror target is unavailable.');
});

// As the app commits it: the document's projection keeps only the warning
// strings, and the typed records the rebuild attributed travel beside it
// (`featureAttribution`). The card reads them there (preview re-check of
// 3d82fb8 still read the adapter's sentence).
it('words a committed failing step from the attributed typed records', () => {
  const { document, fillet } = plateAndFillet();
  const message = 'Feature "Round corners": Mirror target is unavailable.';
  const committed: ProjectDocument = {
    ...document,
    derived: { ...document.derived, warnings: [message] }
  };
  expect(committed.derived.featureWarnings).toBeUndefined();
  render(
    <FeatureHistoryPanel
      document={committed}
      featureWarnings={[
        {
          featureId: fillet.featureId,
          featureName: 'Round corners',
          kind: 'build-failed',
          message,
          kernelRefusal: {
            family: 'reference',
            category: 'invalid_input',
            code: 'mirror_source_unavailable'
          }
        }
      ]}
      selectedId={fillet.id}
      failure={null}
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    MIRROR_SOURCE_UNAVAILABLE
  );
  expect(
    screen.getByRole('region', { name: 'History details' })
  ).not.toHaveTextContent('Mirror target is unavailable.');
});

// A chamfer's rebuild refusal quotes its sizes bare. The command bar puts
// the document's unit after them; History's card read "0.5" and "0.095"
// with no unit (preview re-check of #2278, finding 2).
describe("puts the document's unit after a refused chamfer's sizes", () => {
  const message =
    'Feature "Round corners": Chamfer could not be created on 1 selected edge with distance 0.5. Try a smaller distance: distance 0.095 builds here.';
  it.each([
    ['mm', 'mm'],
    ['inch', 'in']
  ] as const)('in a %s document', (units, unit) => {
    const { document, fillet } = plateAndFillet();
    const committed: ProjectDocument = {
      ...document,
      units,
      derived: { ...document.derived, warnings: [message] }
    };
    render(
      <FeatureHistoryPanel
        document={committed}
        featureWarnings={[
          {
            featureId: fillet.featureId,
            featureName: 'Round corners',
            kind: 'build-failed',
            message,
            kernelRefusal: {
              family: 'blend',
              category: 'quality_refused',
              code: 'edge_modifier_refused'
            }
          }
        ]}
        selectedId={fillet.id}
        failure={null}
        onSelect={vi.fn()}
        onDismissFailure={vi.fn()}
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      `Chamfer could not be created on 1 selected edge with distance 0.5 ${unit}. Try a smaller distance: distance 0.095 ${unit} builds here.`
    );
  });
});

// Review of #2405: a chamfer named with quotes and a size of its own kept
// its name in front of the sentence, and the name's number took the unit.
it('puts the unit after the refused size, not in a quoted feature name', () => {
  const { document, fillet } = plateAndFillet();
  const name = 'Chamfer with distance 2 "Nominal"';
  const named = withFeature(document, fillet.id, (feature) => ({
    ...feature,
    name
  }));
  const message = `Feature "${name}": Chamfer could not be created on 1 selected edge with distance 1.5. Try a smaller distance: distance 0.985 builds here.`;
  render(
    <FeatureHistoryPanel
      document={{
        ...named,
        units: 'inch',
        derived: { ...named.derived, warnings: [message] }
      }}
      featureWarnings={[
        {
          featureId: fillet.featureId,
          featureName: name,
          kind: 'build-failed',
          message,
          kernelRefusal: {
            family: 'blend',
            category: 'invalid_input',
            code: 'invalid-input'
          }
        }
      ]}
      selectedId={fillet.id}
      failure={null}
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Chamfer could not be created on 1 selected edge with distance 1.5 in. Try a smaller distance: distance 0.985 in builds here.'
  );
  expect(screen.getByRole('alert')).not.toHaveTextContent('Nominal');
});

// K10: every feature but Mirror refused a missing target body untyped. The
// card words the typed code, as the bar does.
it("words a missing target body from its code, not the adapter's sentence", () => {
  const { document, fillet } = plateAndFillet();
  const message =
    'Feature "Round corners": Edge modifier target is unavailable.';
  render(
    <FeatureHistoryPanel
      document={{
        ...document,
        derived: { ...document.derived, warnings: [message] }
      }}
      featureWarnings={[
        {
          featureId: fillet.featureId,
          featureName: 'Round corners',
          kind: 'build-failed',
          message,
          kernelRefusal: {
            family: 'reference',
            category: 'invalid_input',
            code: 'target_body_unavailable'
          }
        }
      ]}
      selectedId={fillet.id}
      failure={null}
      onSelect={vi.fn()}
      onDismissFailure={vi.fn()}
    />
  );
  expect(screen.getByRole('alert')).toHaveTextContent(TARGET_BODY_UNAVAILABLE);
  expect(
    screen.getByRole('region', { name: 'History details' })
  ).not.toHaveTextContent('target is unavailable');
});
