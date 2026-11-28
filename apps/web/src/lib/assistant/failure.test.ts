import { describe, expect, it } from 'vitest';
import {
  failureParts,
  isPreflightFailure,
  latestReplySummary,
  smallerFilletRetry
} from './failure';
import type { AssistantEntry } from './conversation';
import { withoutFeatureLead } from '../inPlace/sizeRefusal';

const PREFLIGHT =
  'This verified recipe did not pass exact geometry preflight. Nothing was changed.\n\n' +
  'Feature "All-edge fillet 2": Fillet could not be created on 126 selected edges with radius 2. ' +
  'Edges that end on an existing fillet or chamfer usually cannot be rounded afterwards.';

describe('failureParts', () => {
  it('leads a preflight failure with what failed, not the gate', () => {
    const parts = failureParts(PREFLIGHT);
    // Without the feature name the kernel opens with.
    expect(parts.headline).toBe(
      'Fillet could not be created on 126 selected edges with radius 2.'
    );
    // With the document's unit after the size, once the panel has removed
    // the lead as the attributed feature's name (`withoutFeatureLead`).
    const attributed = PREFLIGHT.replace('Feature "All-edge fillet 2": ', '');
    expect(failureParts(attributed, 'mm').headline).toBe(
      'Fillet could not be created on 126 selected edges with radius 2 mm.'
    );
    // A lead nobody removed as a known name gets no unit: a name can read
    // like the refusal (re-check of #2405).
    expect(failureParts(PREFLIGHT, 'mm').headline).toBe(
      'Fillet could not be created on 126 selected edges with radius 2.'
    );
    expect(parts.detail).toContain('Edges that end on an existing fillet');
    // "Nothing was changed" is still said.
    expect(parts.detail).toContain('Nothing was changed.');
    expect(isPreflightFailure(PREFLIGHT)).toBe(true);
  });

  it('does not end a sentence inside a decimal', () => {
    const parts = failureParts(
      'The proposed change did not pass exact geometry preflight. Nothing was changed.\n\nRadius 2.5 mm is too large here. Try less.'
    );
    expect(parts.headline).toBe('Radius 2.5 mm is too large here.');
    expect(parts.detail?.startsWith('Try less.')).toBe(true);
  });

  it('keeps any other failure’s first paragraph as its headline', () => {
    expect(failureParts('Select one part.')).toEqual({
      headline: 'Select one part.',
      detail: null
    });
    expect(failureParts('Network failed.\n\nCheck the connection.')).toEqual({
      headline: 'Network failed.',
      detail: 'Check the connection.'
    });
    expect(isPreflightFailure('Network failed.')).toBe(false);
  });
});

describe('smallerFilletRetry', () => {
  it('halves the named radius in the named unit', () => {
    expect(
      smallerFilletRetry('Fillet all edges with radius 3 mm', 'mm')
    ).toEqual({ label: 'Try 1.5 mm', text: 'Fillet all edges at 1.5 mm' });
    expect(smallerFilletRetry('fillet every edge at 0.5 in', 'mm')).toEqual({
      label: 'Try 0.25 in',
      text: 'Fillet all edges at 0.25 in'
    });
  });

  it('halves the recipe default when no radius is named', () => {
    expect(smallerFilletRetry('Fillet all edges', 'mm')).toEqual({
      label: 'Try 1 mm',
      text: 'Fillet all edges at 1 mm'
    });
  });

  it('keeps the named part, and its retry parses as the same recipe', () => {
    const retry = smallerFilletRetry('Fillet all edges of bracket by 4', 'cm');
    expect(retry).toEqual({
      label: 'Try 2 cm',
      text: 'Fillet all edges of bracket at 2 cm'
    });
    // Asked again it halves again: the retry is an ask the recipe reads.
    expect(smallerFilletRetry(retry!.text, 'cm')?.label).toBe('Try 1 cm');
  });

  it('takes the radius the kernel proved builds over halving', () => {
    const refusal =
      'This verified recipe did not pass exact geometry preflight. Nothing was changed.\n\n' +
      'Feature "All-edge fillet": Fillet could not be created on 12 selected edges with radius 40. ' +
      'Try a smaller radius: radius 8.75 builds here.';
    // The kernel's sizes are in document units, whatever the ask said.
    expect(
      smallerFilletRetry('Fillet all edges by 4 cm', 'mm', refusal)
    ).toEqual({ label: 'Try 8.75 mm', text: 'Fillet all edges at 8.75 mm' });
  });

  it('offers nothing for any other ask', () => {
    expect(smallerFilletRetry('Add a 10 mm cube', 'mm')).toBeNull();
  });
});

describe('latestReplySummary', () => {
  const at = 1;
  it('names the newest reply, and nothing after the user’s own ask', () => {
    const user: AssistantEntry = {
      kind: 'user',
      id: 'u',
      text: 'Fillet all edges',
      at,
      attachments: [],
      answers: []
    };
    const failure: AssistantEntry = {
      kind: 'message',
      id: 'm',
      text: PREFLIGHT,
      tone: 'error',
      at
    };
    expect(latestReplySummary([])).toBeNull();
    expect(latestReplySummary([user])).toBeNull();
    expect(latestReplySummary([user, failure])).toEqual({
      tone: 'error',
      text: failureParts(PREFLIGHT).headline
    });
    expect(
      latestReplySummary([
        user,
        { kind: 'message', id: 'i', text: 'Done.', tone: 'info', at }
      ])
    ).toEqual({ tone: 'reply', text: 'New reply' });
  });
});

// Re-check of #2405: a feature named `Rough": Chamfer could not be created
// … with distance 2.` read as the refusal, and the assistant's preflight
// formatter put the unit after the name's 2.
describe('a preflight refusal whose feature name reads like the refusal', () => {
  const name =
    'Rough": Chamfer could not be created on 1 selected edge with distance 2.';
  const reason = `Feature "${name}": Chamfer could not be created on 1 selected edge with distance 1.5. Try a smaller distance: distance 0.985 builds here.`;
  const gate =
    'The proposed change did not pass exact geometry preflight. Nothing was changed.\n\n';

  it('writes the unit after the refused size once the lead is removed as the name', () => {
    // As the panel builds the failure from the preview's attributed name.
    const text = gate + withoutFeatureLead(reason, name).text;
    expect(failureParts(text, 'in').headline).toBe(
      'Chamfer could not be created on 1 selected edge with distance 1.5 in.'
    );
  });

  it('writes no unit without the name', () => {
    const { headline, detail } = failureParts(gate + reason, 'in');
    expect(`${headline} ${detail}`).not.toMatch(/\d in\b/);
  });
});
