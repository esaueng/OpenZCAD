import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPreviewVerdictStore,
  usePreviewVerdict
} from './usePreviewVerdict';

afterEach(cleanup);

describe('preview verdict subscriptions', () => {
  it('keeps drag ticks out of React and exposes the latest verdict on keypad open', () => {
    let update: ReturnType<typeof usePreviewVerdict>[1];
    const renders = vi.fn();
    function Harness({ open }: { open: boolean }) {
      const [verdict, set] = usePreviewVerdict(open);
      update = set;
      renders();
      return (
        <output>
          {verdict ? `${verdict.value}:${verdict.status}` : 'closed'}
        </output>
      );
    }
    const view = render(<Harness open={false} />);
    const before = renders.mock.calls.length;
    act(() => {
      for (let value = 0; value < 120; value++)
        update({ value, status: 'unchecked' });
      update({ value: 119, status: 'refused' });
    });
    expect(renders).toHaveBeenCalledTimes(before);
    view.rerender(<Harness open />);
    expect(screen.getByRole('status')).toHaveTextContent('119:refused');
    act(() => update({ value: 120, status: 'built' }));
    expect(screen.getByRole('status')).toHaveTextContent('120:built');
    view.rerender(<Harness open={false} />);
    const closed = renders.mock.calls.length;
    act(() => update(null));
    expect(renders).toHaveBeenCalledTimes(closed);
    view.rerender(<Harness open />);
    expect(screen.getByRole('status')).toHaveTextContent('closed');
  });

  it('notifies only changed verdicts, with unsubscribe and clear', () => {
    const store = createPreviewVerdictStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set({ value: 3, status: 'built' });
    store.set({ value: 3, status: 'built' });
    expect(listener).toHaveBeenCalledTimes(1);
    store.set({ value: 3, status: 'refused' });
    store.set(null);
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    store.set({ value: 4, status: 'unchecked' });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
