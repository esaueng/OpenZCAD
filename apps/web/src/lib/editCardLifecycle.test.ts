import { describe, expect, it } from 'vitest';
import { editCardFeatureId, EditCardSessions } from './editCardLifecycle';

describe('editCardFeatureId', () => {
  it('names the Inspector card while no tool runs', () => {
    expect(
      editCardFeatureId({
        tool: null,
        inspectorFeatureId: 'box',
        modelingEditFeatureId: null
      })
    ).toBe('box');
  });

  it('names the reopened modeling form while its tool runs', () => {
    expect(
      editCardFeatureId({
        tool: 'hole',
        inspectorFeatureId: 'hole',
        modelingEditFeatureId: 'hole'
      })
    ).toBe('hole');
  });

  it('names nothing under a create card, so a late edit Apply cannot close it', () => {
    // A Box edit still validating when the user starts a Hole must not close
    // the Hole create card it lands on.
    expect(
      editCardFeatureId({
        tool: 'hole',
        inspectorFeatureId: 'box',
        modelingEditFeatureId: null
      })
    ).toBeNull();
    expect(
      editCardFeatureId({
        tool: 'box',
        inspectorFeatureId: 'box',
        modelingEditFeatureId: null
      })
    ).toBeNull();
  });
});

describe('EditCardSessions', () => {
  it('keeps one session while the same card stays open', () => {
    const sessions = new EditCardSessions();
    const applied = sessions.observe('box');
    // Re-renders while the Apply validates, including rebuilt documents.
    expect(sessions.observe('box')).toBe(applied);
    expect(sessions.observe('box')).toBe(applied);
    expect(sessions.isOpen(applied)).toBe(true);
  });

  it('closing the card and reopening the same feature is a new session, so a late success leaves it open', () => {
    const sessions = new EditCardSessions();
    const applied = sessions.observe('hole');
    // The user closes the card while that Apply validates…
    sessions.observe(null);
    // …and reopens the same feature, typing new input.
    const reopened = sessions.observe('hole');
    expect(reopened).not.toBe(applied);
    expect(reopened?.featureId).toBe('hole');
    // The late success must not close the reopened card.
    expect(sessions.isOpen(applied)).toBe(false);
    expect(sessions.isOpen(reopened)).toBe(true);
  });

  it('moving to another feature and back is a new session too', () => {
    const sessions = new EditCardSessions();
    const applied = sessions.observe('box');
    sessions.observe('fillet');
    sessions.observe('box');
    expect(sessions.isOpen(applied)).toBe(false);
  });

  it('no card means no open session', () => {
    const sessions = new EditCardSessions();
    expect(sessions.observe(null)).toBeNull();
    expect(sessions.isOpen(null)).toBe(false);
  });
});
