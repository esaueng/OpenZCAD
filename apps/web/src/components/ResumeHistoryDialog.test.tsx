import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResumeHistoryDialog } from './ResumeHistoryDialog';
import {
  MIRROR_SOURCE_UNAVAILABLE,
  TARGET_BODY_UNAVAILABLE
} from '../lib/refusalLanguage';

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

  // The dialog words a typed refusal from its code, as the command bar does,
  // rather than relaying the adapter's sentence (preview check of f4c7f13).
  it("words a failure from its typed code, whatever the feature's name", () => {
    render(
      <ResumeHistoryDialog
        action="Resume Body no longer exists"
        row={{ name: 'Body no longer exists', state: 'suppressed' }}
        failures={[
          {
            name: 'Body no longer exists',
            reason: 'Mirror target is unavailable.',
            kernelRefusal: {
              category: 'invalid_input',
              code: 'mirror_source_unavailable'
            }
          }
        ]}
        onKeep={vi.fn()}
        onResume={vi.fn()}
      />
    );
    expect(screen.getByRole('listitem').textContent).toBe(
      `Body no longer exists: ${MIRROR_SOURCE_UNAVAILABLE}`
    );
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

  // Resume read a chamfer's sizes bare ("0.5", "0.095"), where the command
  // bar puts the document's unit after them (preview re-check of #2278).
  it.each([
    ['mm', 'mm'],
    ['an inch', 'in']
  ])("puts %s document's unit after a refused chamfer's sizes", (_, unit) => {
    render(
      <ResumeHistoryDialog
        action="Resume Chamfer 1"
        row={{ name: 'Chamfer 1', state: 'suppressed' }}
        failures={[
          {
            name: 'Chamfer 1',
            reason:
              'Chamfer could not be created on 1 selected edge with distance 0.5. Try a smaller distance: distance 0.095 builds here.',
            kernelRefusal: {
              category: 'quality_refused',
              code: 'edge_modifier_refused'
            }
          }
        ]}
        unitLabel={unit}
        onKeep={vi.fn()}
        onResume={vi.fn()}
      />
    );
    expect(screen.getByRole('listitem').textContent).toBe(
      `Chamfer 1: Chamfer could not be created on 1 selected edge with distance 0.5 ${unit}. Try a smaller distance: distance 0.095 ${unit} builds here.`
    );
  });

  // K10: a missing target body is typed for every feature now, not only
  // Mirror, and the dialog words it from the code.
  it('words a missing target body from its code', () => {
    render(
      <ResumeHistoryDialog
        action="Resume Shell 1"
        row={{ name: 'Shell 1', state: 'suppressed' }}
        failures={[
          {
            name: 'Shell 1',
            reason: 'Shell target is unavailable.',
            kernelRefusal: {
              category: 'invalid_input',
              code: 'target_body_unavailable'
            }
          }
        ]}
        onKeep={vi.fn()}
        onResume={vi.fn()}
      />
    );
    expect(screen.getByRole('listitem').textContent).toBe(
      `Shell 1: ${TARGET_BODY_UNAVAILABLE}`
    );
  });
});
