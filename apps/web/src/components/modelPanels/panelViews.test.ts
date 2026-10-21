import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useHistoryFind, useObjectsView } from './panelViews';

describe('model panel view state', () => {
  it('keeps the Objects view within a project and starts it afresh for another', () => {
    const { result, rerender } = renderHook(
      ({ scope }) => useObjectsView(scope),
      { initialProps: { scope: 'project-a' } }
    );
    act(() => {
      result.current.setQuery('rib');
      result.current.setFilter('sketches');
      result.current.setShowConsumed(true);
    });
    rerender({ scope: 'project-a' });
    expect(result.current.query).toBe('rib');

    // Home (no project) and then another project: nothing carries over.
    rerender({ scope: null as unknown as string });
    rerender({ scope: 'project-b' });
    expect(result.current.query).toBe('');
    expect(result.current.filter).toBe('all');
    expect(result.current.showConsumed).toBe(false);
  });

  it('closes the History Find field for another project', () => {
    const { result, rerender } = renderHook(
      ({ scope }) => useHistoryFind(scope),
      { initialProps: { scope: 'project-a' } }
    );
    act(() => result.current.toggle());
    expect(result.current.open).toBe(true);
    rerender({ scope: 'project-b' });
    expect(result.current.open).toBe(false);
  });
});
