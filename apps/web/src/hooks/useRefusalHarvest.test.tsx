import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  listParameters,
  setParameter
} from '@openzcad/document-core';
import {
  toUserId,
  type DerivedState,
  type FeatureWarning
} from '@openzcad/shared';
import { useRefusalHarvest } from './useRefusalHarvest';
import { ParameterRow } from '../components/ParameterRows';
import { ToolCard } from '../components/ToolCard';
import { splitRefusal } from '../lib/featureValidation';
import { buildRefusalReproduction } from '../lib/refusalReproduction';
import type { DirectEditFixture } from '../lib/directEditFixture';
import type { RefusalCapture } from '../lib/refusalHarvest';

function scene() {
  const document = addPrimitiveFeature(
    setParameter(createProjectDocument('Private', toUserId('local')), {
      name: 'height',
      expression: '10'
    }),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, depth: 10, height: 'height' }
    }
  );
  const warning: FeatureWarning = {
    featureId: listFeaturesInOrder(document)[0]!.featureId,
    featureName: 'Box',
    kind: 'build-failed',
    message: 'Feature "Box": The height must be positive.\nKernel detail'
  };
  const derived: DerivedState = {
    ...document.derived,
    warnings: [warning.message],
    featureWarnings: [warning]
  };
  return { document, warning, derived };
}

describe('edit refusal ownership', () => {
  it('connects edit rebuilds to the matching row and exported reproduction, without background interference', async () => {
    const user = userEvent.setup();
    const { document, warning, derived } = scene();
    const track = vi.fn();
    const saved = vi.fn<(fixture: DirectEditFixture) => void>();
    const rebuild = vi.fn(async () => derived);
    const prospective = setParameter(document, {
      name: 'height',
      expression: '-1'
    });
    function Workspace() {
      const harvest = useRefusalHarvest({
        document,
        currentDocument: () => document,
        warnings: [],
        rebuild,
        track
      });
      const saveCapture = (capture: RefusalCapture) =>
        saved(
          buildRefusalReproduction({
            ...capture,
            kernel: {
              adapter: 'remus',
              packageVersion: 'test',
              sourceCommit: 'test'
            }
          })
        );
      const diagnostic = splitRefusal(
        warning.message.replace(/^Feature "[^"]+":\s*/, '')
      );
      const toolSave = harvest.reproductionFor(
        'operation',
        diagnostic,
        saveCapture
      );
      return (
        <>
          <ParameterRow
            parameter={listParameters(document)[0]!}
            value={10}
            onSet={async () => {
              await harvest.syncParameterCandidate('height', prospective);
              return warning.message;
            }}
            reproductionFor={(message) =>
              harvest.reproductionFor('parameter:height', message, saveCapture)
            }
          />
          <ToolCard
            model={{
              icon: 'extrude',
              title: 'Extrude',
              eyebrow: 'create',
              hint: 'Edit',
              error: diagnostic
            }}
            onClose={vi.fn()}
            {...(toolSave ? { onSaveReproduction: toolSave } : {})}
          />
          <button onClick={() => void rebuild()}>Background copy</button>
          <button onClick={() => void harvest.syncCandidate(prospective)}>
            Tool attempt
          </button>
        </>
      );
    }
    render(<Workspace />);
    const input = screen.getByLabelText('Expression for height');
    await user.clear(input);
    await user.type(input, '-1{Enter}');
    const save = await screen.findByRole('button', {
      name: 'Save reproduction'
    });
    expect(save.closest('.parameter-feedback')).not.toBeNull();
    expect(track).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Background copy' }));
    expect(track).toHaveBeenCalledOnce();
    await user.click(save);
    const fixture = saved.mock.calls[0]![0];
    expect(fixture.document).not.toBeNull();
    expect(listParameters(fixture.document!)[0]!.expression).toBe('-1');
    expect(fixture.observed.warningKind).toBe('build-failed');
    await user.click(screen.getByRole('button', { name: 'Tool attempt' }));
    // The old row error cannot offer another surface's latest capture.
    expect(
      screen
        .getByRole('button', { name: 'Save reproduction' })
        .closest('.parameter-feedback')
    ).toBeNull();
  });

  it('ignores another project and late replies after a switch or commit', async () => {
    const { document, warning, derived } = scene();
    let current = document;
    let finish!: (value: DerivedState) => void;
    const rebuild = vi.fn(
      () =>
        new Promise<DerivedState>((resolve) => {
          finish = resolve;
        })
    );
    const track = vi.fn();
    const { result, rerender } = renderHook(() =>
      useRefusalHarvest({
        document: current,
        currentDocument: () => current,
        warnings: [],
        rebuild,
        track
      })
    );
    let pending!: Promise<DerivedState>;
    act(() => {
      pending = result.current.syncCandidate(document);
    });
    current = { ...document, version: document.version + 1 };
    rerender();
    await act(async () => {
      finish(derived);
      await pending;
    });
    expect(track).not.toHaveBeenCalled();
    expect(result.current.captureFor('operation', warning.message)).toBeNull();

    act(() => {
      pending = result.current.syncCandidate(current);
    });
    current = createProjectDocument('Another', toUserId('local'));
    rerender();
    await act(async () => {
      finish(derived);
      await pending;
    });
    expect(track).not.toHaveBeenCalled();

    await act(async () => {
      pending = result.current.syncCandidate(document);
      finish(derived);
      await pending;
    });
    expect(track).not.toHaveBeenCalled();
  });

  it('keeps the latest-started attempt and invalidates old save callbacks', async () => {
    const { document, warning, derived } = scene();
    const finish: Array<(value: DerivedState) => void> = [];
    const rebuild = vi.fn(
      () => new Promise<DerivedState>((resolve) => finish.push(resolve))
    );
    const track = vi.fn();
    const saved = vi.fn();
    const { result } = renderHook(() =>
      useRefusalHarvest({
        document,
        currentDocument: () => document,
        warnings: [],
        rebuild,
        track
      })
    );
    let first!: Promise<DerivedState>;
    let second!: Promise<DerivedState>;
    act(() => {
      first = result.current.syncParameterCandidate('height', document);
    });
    await act(async () => {
      finish[0]!(derived);
      await first;
    });
    const oldSave = result.current.reproductionFor(
      'parameter:height',
      warning.message,
      saved
    )!;
    expect(oldSave).toBeTypeOf('function');
    act(() => {
      first = result.current.syncParameterCandidate('height', document);
      second = result.current.syncParameterCandidate('width', document);
    });
    oldSave();
    expect(saved).not.toHaveBeenCalled();
    await act(async () => {
      finish[2]!(derived);
      await second;
    });
    await act(async () => {
      finish[1]!({ ...derived, featureWarnings: [] });
      await first;
    });
    expect(
      result.current.captureFor('parameter:width', warning.message)
    ).not.toBeNull();
    expect(
      result.current.captureFor('parameter:height', warning.message)
    ).toBeNull();
    expect(
      result.current.captureFor('parameter:width', 'An older error')
    ).toBeNull();
    oldSave();
    expect(saved).not.toHaveBeenCalled();
    // A later successful edit withdraws the capture.
    act(() => {
      first = result.current.syncCandidate(document);
    });
    await act(async () => {
      finish[3]!({ ...derived, featureWarnings: [] });
      await first;
    });
    expect(
      result.current.captureFor('parameter:width', warning.message)
    ).toBeNull();
  });
});
