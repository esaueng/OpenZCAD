import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  getActivityLogSnapshot,
  resetActivityLogForTests
} from '../lib/activityLog';
import { StatusActivityLog } from './StatusActivityLog';

const logged = () =>
  getActivityLogSnapshot().entries.map((entry) => ({
    source: entry.source,
    message: entry.message,
    ...(entry.detail ? { detail: entry.detail } : {})
  }));

describe('StatusActivityLog', () => {
  beforeEach(() => resetActivityLogForTests());

  it('keeps the full diagnostic with its compact status entry', () => {
    render(
      <StatusActivityLog
        status="Parameter height was not changed."
        detail="move-face would change topology at face 9"
        tone="warning"
        workspace="Tweak"
        project="Bracket"
      />
    );

    expect(getActivityLogSnapshot().entries).toEqual([
      expect.objectContaining({
        level: 'warning',
        source: 'status',
        message: 'Parameter height was not changed.',
        detail: 'move-face would change topology at face 9',
        workspace: 'Tweak',
        project: 'Bracket'
      })
    ]);
  });

  it('logs a message set while the geometry line is up, not only the line', () => {
    const { rerender } = render(
      <StatusActivityLog
        status="Offline workspace"
        geometryStatus="Starting geometry worker · the model appears when it is ready"
        tone="running"
      />
    );
    rerender(
      <StatusActivityLog
        status="Cannot use Box: This shared project is read-only."
        geometryStatus="Starting geometry worker · the model appears when it is ready"
        tone="running"
      />
    );
    // The geometry settling changes the tone, but is not the message again.
    rerender(
      <StatusActivityLog
        status="Cannot use Box: This shared project is read-only."
        geometryStatus={null}
        tone="ready"
      />
    );

    expect(logged()).toEqual([
      { source: 'status', message: 'Offline workspace' },
      {
        source: 'geometry',
        message: 'Starting geometry worker · the model appears when it is ready'
      },
      {
        source: 'status',
        message: 'Cannot use Box: This shared project is read-only.'
      }
    ]);
  });

  it('leaves a lane-only message out of the log', () => {
    const { rerender } = render(
      <StatusActivityLog status="Added box." tone="ready" />
    );
    // A workspace switch says where the user is, not what the model did.
    rerender(
      <StatusActivityLog
        status="Build mode · modeling tools are back."
        logged={false}
        tone="ready"
      />
    );
    rerender(<StatusActivityLog status="Added cylinder." tone="ready" />);

    expect(logged().map((entry) => entry.message)).toEqual([
      'Added box.',
      'Added cylinder.'
    ]);
  });

  it('does not log the same line again when it remounts', () => {
    // The start screen and the workspace each mount a recorder; switching
    // between them carries the current line over.
    const first = render(<StatusActivityLog status="Saved." tone="ready" />);
    first.unmount();
    render(<StatusActivityLog status="Saved." tone="ready" />);

    expect(logged()).toEqual([{ source: 'status', message: 'Saved.' }]);
  });
});
