import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useHistoryFind, useHistoryText, useObjectsView } from './panelViews';

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

  it('drops History as text and its edit for another project', () => {
    const { result, rerender } = renderHook(
      ({ scope }) => useHistoryText(scope),
      { initialProps: { scope: 'project-a' } }
    );
    act(() => {
      result.current.toggle();
      result.current.setDraft({
        text: 'edited',
        baseVersion: 3,
        baseText: 'printed'
      });
    });
    rerender({ scope: 'project-a' });
    expect(result.current.open).toBe(true);
    expect(result.current.draft).toMatchObject({
      text: 'edited',
      baseVersion: 3
    });
    rerender({ scope: 'project-b' });
    expect(result.current.open).toBe(false);
    expect(result.current.draft).toBeNull();
  });

  it('keeps an edit typed after an Apply began when that Apply commits', () => {
    const { result } = renderHook(() => useHistoryText('project-a'));
    let finish!: (applied: boolean) => void;
    act(() => {
      result.current.setDraft({
        text: 'applied',
        baseVersion: 3,
        baseText: 'printed'
      });
    });
    act(() => {
      finish = result.current.startApply('applied');
    });
    expect(result.current.applying).toBe(true);
    act(() => {
      result.current.setDraft({
        text: 'newer',
        baseVersion: 3,
        baseText: 'printed'
      });
    });
    act(() => finish(true));
    expect(result.current.applying).toBe(false);
    expect(result.current.draft?.text).toBe('newer');

    // An Apply of the text still shown clears it once it commits.
    act(() => {
      finish = result.current.startApply('newer');
    });
    act(() => finish(true));
    expect(result.current.draft).toBeNull();
  });

  it('ends an Apply of another project without touching this one', () => {
    const { result, rerender } = renderHook(
      ({ scope }) => useHistoryText(scope),
      { initialProps: { scope: 'project-a' } }
    );
    let finish!: (applied: boolean) => void;
    act(() => {
      finish = result.current.startApply('a');
    });
    rerender({ scope: 'project-b' });
    expect(result.current.applying).toBe(false);
    let current!: (applied: boolean) => void;
    act(() => {
      current = result.current.startApply('b');
    });
    act(() => finish(true));
    expect(result.current.applying).toBe(true);
    act(() => current(false));
    expect(result.current.applying).toBe(false);
  });
});
