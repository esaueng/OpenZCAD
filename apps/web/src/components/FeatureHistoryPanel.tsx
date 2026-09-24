import { useMemo } from 'react';
import {
  isFeatureRollbackSuppressed,
  isFeatureSuppressed,
  type ProjectDocument,
  type FeatureNode
} from '@openzcad/shared';
import { featureHistory } from '../lib/featureHistory';
import {
  refusingWarning,
  type FeatureBuildError
} from '../lib/featureValidation';

interface Props {
  document: ProjectDocument;
  selectedId: string | null;
  failure: FeatureBuildError | null;
  onSelect(id: string): void;
  onResumeHistory(): void;
  onDismissFailure(): void;
}

export function FeatureHistoryPanel({
  document,
  selectedId,
  failure,
  onSelect,
  onResumeHistory,
  onDismissFailure
}: Props) {
  const graph = useMemo(() => featureHistory(document), [document]);
  const selected = graph.features.find((feature) => feature.id === selectedId);
  const downstream = selected ? graph.downstream(selected.featureId) : [];
  const parents = selected
    ? graph.features.filter((feature) =>
        graph.parents.get(selected.featureId)?.has(feature.featureId)
      )
    : [];
  const missing = selected
    ? [...(graph.missing.get(selected.featureId) ?? [])]
    : [];
  const rolledBack = graph.features.filter(isFeatureRollbackSuppressed);
  const culprit = failure?.featureId
    ? graph.features.find((feature) => feature.featureId === failure.featureId)
    : undefined;
  const warning =
    selected && !isFeatureSuppressed(selected)
      ? refusingWarning(
          selected.name,
          document.derived.warnings,
          document.derived.featureWarnings,
          selected.featureId
        )
      : null;
  const link = (feature: FeatureNode) => (
    <li key={feature.featureId}>
      <button
        type="button"
        aria-label={`Inspect ${feature.name}`}
        onClick={() => onSelect(feature.id)}
      >
        {feature.name}
      </button>
      {isFeatureSuppressed(feature) && <span> (inactive)</span>}
    </li>
  );
  if (!selected && !failure && !rolledBack.length) return null;
  return (
    <section className="feature-history-panel" aria-label="History details">
      {failure && (
        <div className="feature-history-failure" role="alert">
          <strong>Edit not saved{culprit ? ` · ${culprit.name}` : ''}</strong>
          <p>{failure.message}</p>
          <p>
            The previous model is intact. Adjust the failing feature, then retry
            the edit.
          </p>
          {culprit && (
            <button type="button" onClick={() => onSelect(culprit.id)}>
              Edit {culprit.name}
            </button>
          )}
          <button type="button" onClick={onDismissFailure}>
            Dismiss failure
          </button>
        </div>
      )}
      {rolledBack.length > 0 && (
        <div role="status">
          <p>
            {rolledBack.length} later{' '}
            {rolledBack.length === 1 ? 'feature is' : 'features are'} paused by
            rollback.
          </p>
          <button type="button" onClick={onResumeHistory}>
            Resume full history
          </button>
          <p className="muted">Manually suppressed features stay suppressed.</p>
        </div>
      )}
      {selected && (
        <div>
          <strong>{selected.name}</strong>
          <p>
            {isFeatureRollbackSuppressed(selected)
              ? 'Paused by rollback'
              : isFeatureSuppressed(selected)
                ? 'Suppressed'
                : warning || missing.length > 0
                  ? 'Needs repair'
                  : 'Included in the build'}
          </p>
          {warning && <p role="alert">{warning}</p>}
          {missing.length > 0 && (
            <p role="alert">
              An input {missing.join(' or ')} is missing from history. Undo its
              deletion or edit this feature's references.
            </p>
          )}
          {/* An empty disclosure said it twice: "Uses 0 earlier features"
              over "No earlier geometry dependencies." One line instead. */}
          {parents.length === 0 && missing.length === 0 ? (
            <p className="muted">No earlier features feed this one.</p>
          ) : (
            <details open>
              <summary>
                Uses {parents.length} earlier{' '}
                {parents.length === 1 ? 'feature' : 'features'}
              </summary>
              {parents.length ? (
                <ul>{parents.map(link)}</ul>
              ) : (
                <p className="muted">Earlier inputs could not be resolved.</p>
              )}
            </details>
          )}
          {downstream.length === 0 ? (
            <p className="muted">Nothing later depends on it.</p>
          ) : (
            <details open>
              <summary>
                Affects {downstream.length} later{' '}
                {downstream.length === 1 ? 'feature' : 'features'}
              </summary>
              <ul>{downstream.map(link)}</ul>
            </details>
          )}
          {downstream.length > 0 && (
            <p className="muted">
              Deleting or suppressing this feature can break these later
              features. Undo restores the previous history.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
