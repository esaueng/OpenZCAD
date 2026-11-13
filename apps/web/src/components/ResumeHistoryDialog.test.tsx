import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResumeHistoryDialog } from './ResumeHistoryDialog';

describe('ResumeHistoryDialog', () => {
  it('names each failing feature with its reason and focuses Keep rolled back', () => {
    const onResume = vi.fn();
    const onKeep = vi.fn();
    render(
      <ResumeHistoryDialog
        action="Resume full history"
        failures={[
          {
            name: 'Offset top',
            reason:
              'Direct-edit face is stale: The selected face lineage no longer exists.'
          },
          { name: 'Fillet 3', reason: 'Fillet target is unavailable.' }
        ]}
        onKeep={onKeep}
        onResume={onResume}
      />
    );
    const dialog = screen.getByRole('alertdialog', {
      name: 'Resume full history?'
    });
    expect(dialog).toHaveTextContent('2 paused features would not rebuild:');
    const items = screen
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items[0]).toBe(
      'Offset top: Direct-edit face is stale: The selected face lineage no longer exists.'
    );
    expect(items[1]).toMatch(/^Fillet 3: /);
    expect(
      screen.getByRole('button', { name: 'Keep rolled back' })
    ).toHaveFocus();
    const confirm = screen.getByRole('button', { name: 'Resume anyway' });
    fireEvent.click(confirm);
    expect(onResume).toHaveBeenCalledOnce();
    expect(onKeep).not.toHaveBeenCalled();
  });

  it('keeps the rollback on Escape and on Keep rolled back, and counts the rest', () => {
    const onKeep = vi.fn();
    render(
      <ResumeHistoryDialog
        action="Roll back after Fillet 4"
        failures={Array.from({ length: 9 }, (_, index) => ({
          name: `Offset ${index + 1}`,
          reason: 'Offset target is unavailable.'
        }))}
        onKeep={onKeep}
        onResume={vi.fn()}
      />
    );
    expect(
      screen.getByRole('alertdialog', { name: 'Roll back after Fillet 4?' })
    ).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByText('and 3 more')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Keep rolled back' }));
    expect(onKeep).toHaveBeenCalledTimes(2);
  });

  it('uses the singular for one failure', () => {
    render(
      <ResumeHistoryDialog
        action="Resume full history"
        failures={[{ name: 'Chamfer', reason: 'Chamfer edges are stale.' }]}
        onKeep={vi.fn()}
        onResume={vi.fn()}
      />
    );
    expect(
      screen.getByText('1 paused feature would not rebuild:')
    ).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'resume anyway and repair it in place'
    );
  });

  it("words a row's own resume after the row and focuses Keep suppressed", () => {
    const onKeep = vi.fn();
    render(
      <ResumeHistoryDialog
        action="Resume Fillet 3"
        row={{ name: 'Fillet 3', state: 'suppressed' }}
        failures={[
          { name: 'Fillet 3', reason: 'Fillet edges are stale.' },
          { name: 'Offset top', reason: 'Offset target is unavailable.' }
        ]}
        onKeep={onKeep}
        onResume={vi.fn()}
      />
    );
    const dialog = screen.getByRole('alertdialog', {
      name: 'Resume Fillet 3?'
    });
    // The later feature was building, not paused.
    expect(dialog).toHaveTextContent('2 features would not rebuild:');
    expect(dialog).toHaveTextContent(
      'Keep Fillet 3 suppressed to change the model first, or resume anyway and repair them in place. Undo suppresses it again.'
    );
    const keep = screen.getByRole('button', { name: 'Keep suppressed' });
    expect(keep).toHaveFocus();
    fireEvent.click(keep);
    expect(onKeep).toHaveBeenCalledOnce();
  });

  it('calls a row a rollback paused "paused"', () => {
    render(
      <ResumeHistoryDialog
        action="Resume Chamfer"
        row={{ name: 'Chamfer', state: 'paused' }}
        failures={[{ name: 'Chamfer', reason: 'Chamfer edges are stale.' }]}
        onKeep={vi.fn()}
        onResume={vi.fn()}
      />
    );
    expect(
      screen.getByText('1 feature would not rebuild:')
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Keep paused' })
    ).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Undo pauses it again.'
    );
  });
});
