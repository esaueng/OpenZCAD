import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getActivityLogSnapshot,
  recordActivity,
  resetActivityLogForTests,
  setActivityContext
} from '../lib/activityLog';
import { ActivityLogSettings } from './ActivityLogSettings';

const messages = () =>
  within(screen.getByRole('region', { name: 'Activity log' }))
    .queryAllByRole('listitem')
    .map((item) => item.querySelector('.activity-log-message')?.textContent);

describe('ActivityLogSettings', () => {
  beforeEach(() => {
    resetActivityLogForTests();
    setActivityContext({ workspace: 'Build', project: 'Bracket' });
    recordActivity({ level: 'ready', source: 'status', message: 'Added box.' });
    recordActivity({
      level: 'warning',
      source: 'status',
      message: 'Edit not applied.',
      detail: 'kept_face_16_is_not_cylinder_surface'
    });
    recordActivity({
      level: 'running',
      source: 'geometry',
      message: 'Rebuilding the model…'
    });
    recordActivity({
      level: 'error',
      source: 'error',
      message: 'TypeError: x'
    });
  });

  it('lists every entry newest first with its detail and context', () => {
    render(<ActivityLogSettings />);
    expect(messages()).toEqual([
      'TypeError: x',
      'Rebuilding the model…',
      'Edit not applied.',
      'Added box.'
    ]);
    const log = screen.getByRole('region', { name: 'Activity log' });
    expect(log).toHaveTextContent('kept_face_16_is_not_cylinder_surface');
    expect(log).toHaveTextContent('Bracket · Build');
    expect(screen.getByText('4 entries')).toBeTruthy();
  });

  it('filters by text, level and source, and clears the filters', async () => {
    const user = userEvent.setup();
    render(<ActivityLogSettings />);

    await user.type(screen.getByLabelText('Filter entries'), 'cylinder');
    expect(messages()).toEqual(['Edit not applied.']);
    expect(screen.getByText('1 of 4 entries')).toBeTruthy();
    await user.clear(screen.getByLabelText('Filter entries'));

    const levels = screen.getByRole('group', { name: 'Levels' });
    await user.click(within(levels).getByRole('button', { name: /Warning/ }));
    await user.click(within(levels).getByRole('button', { name: /Error/ }));
    expect(messages()).toEqual(['TypeError: x', 'Edit not applied.']);

    const sources = screen.getByRole('group', { name: 'Sources' });
    await user.click(within(sources).getByRole('button', { name: 'Status' }));
    expect(messages()).toEqual(['Edit not applied.']);

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(messages()).toHaveLength(4);
  });

  it('shows entries recorded while it is open', () => {
    render(<ActivityLogSettings />);
    act(() =>
      recordActivity({ level: 'ready', source: 'notice', message: 'Saved.' })
    );
    expect(messages()[0]).toBe('Saved.');
  });

  it('copies the shown entries as text and clears the log', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    render(<ActivityLogSettings />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]![0] as string;
    // Oldest first in the copy, whatever order the list shows.
    expect(text.split('\n')[0]).toContain(
      'INFO [Status] (Bracket · Build) Added box.'
    );
    expect(text).toContain('    kept_face_16_is_not_cylinder_surface');
    expect(screen.getByRole('status')).toHaveTextContent('Copied 4 entries.');

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    // "Confirm destructive actions" is on by default: Clear asks first.
    const dialog = screen.getByRole('alertdialog', {
      name: 'Clear the activity log?'
    });
    expect(dialog).toHaveTextContent('4 entries are removed.');
    expect(
      within(dialog).getByRole('button', { name: 'Cancel' })
    ).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Clear log' }));
    expect(getActivityLogSnapshot().entries).toHaveLength(0);
    expect(screen.getByText('Nothing logged yet.')).toBeTruthy();
  });

  it('keeps the log when Clear is cancelled', async () => {
    const user = userEvent.setup();
    render(<ActivityLogSettings />);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(getActivityLogSnapshot().entries).toHaveLength(4);
  });

  it('clears without asking when confirmations are off', async () => {
    const user = userEvent.setup();
    render(<ActivityLogSettings confirmDestructive={false} />);
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(getActivityLogSnapshot().entries).toHaveLength(0);
  });
});
