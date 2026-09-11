import { describe, expect, it } from 'vitest';
import { commandOutcomeMessage } from './commandOutcome';

describe('command outcome messages', () => {
  it('turns an imperative command label into the sentence that happened', () => {
    expect(commandOutcomeMessage('Add box')).toBe('Added box.');
    expect(commandOutcomeMessage('Drill hole')).toBe('Drilled hole.');
    expect(commandOutcomeMessage('Transform body')).toBe('Moved body.');
    expect(commandOutcomeMessage('Fillet edges')).toBe('Filleted edges.');
    expect(commandOutcomeMessage('Sweep profile')).toBe('Swept profile.');
  });

  it('describes a feature named by what it is as added', () => {
    expect(commandOutcomeMessage('Linear pattern')).toBe(
      'Linear pattern added.'
    );
    expect(commandOutcomeMessage('Union')).toBe('Union added.');
  });

  it('leaves a message that is already a sentence alone', () => {
    expect(commandOutcomeMessage('Filleted 1 edge at 1 mm.')).toBe(
      'Filleted 1 edge at 1 mm.'
    );
    expect(commandOutcomeMessage('')).toBe('');
  });
});
