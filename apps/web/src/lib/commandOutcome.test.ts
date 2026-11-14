import { describe, expect, it } from 'vitest';
import { commandOutcomeMessage, historyStepMessage } from './commandOutcome';

describe('command outcome messages', () => {
  it('turns an imperative command label into the sentence that happened', () => {
    expect(commandOutcomeMessage('Add box')).toBe('Added box.');
    expect(commandOutcomeMessage('Drill hole')).toBe('Drilled hole.');
    expect(commandOutcomeMessage('Transform body')).toBe('Moved body.');
    expect(commandOutcomeMessage('Fillet edges')).toBe('Filleted edges.');
    expect(commandOutcomeMessage('Sweep profile')).toBe('Swept profile.');
    expect(commandOutcomeMessage('Helical sweep profile')).toBe(
      'Coiled the profile.'
    );
  });

  it('reports history and parameter commands as what happened, not as additions', () => {
    expect(commandOutcomeMessage('Set parameter w')).toBe('Set parameter w.');
    expect(commandOutcomeMessage('Roll back after Extrude')).toBe(
      'Rolled back after Extrude.'
    );
    expect(commandOutcomeMessage('Resume full history')).toBe(
      'Resumed full history.'
    );
    expect(commandOutcomeMessage('Suppress Hole')).toBe('Suppressed Hole.');
    expect(commandOutcomeMessage('Boolean subtract')).toBe(
      'Subtracted bodies.'
    );
  });

  it('reports parameter curation and toggle commands as what happened', () => {
    // These labels read "Hide parameter w in Tweak added." until they had
    // past tenses of their own.
    expect(commandOutcomeMessage('Hide parameter w in Tweak')).toBe(
      'Hid parameter w in Tweak.'
    );
    expect(commandOutcomeMessage('Show parameter w in Tweak')).toBe(
      'Showed parameter w in Tweak.'
    );
    expect(commandOutcomeMessage('Describe parameter h')).toBe(
      'Described parameter h.'
    );
    expect(commandOutcomeMessage('Configure on/off parameter show_lid')).toBe(
      'Configured on/off parameter show_lid.'
    );
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

describe('history step messages', () => {
  it('says what Undo and Redo did rather than naming the command', () => {
    // 13 November review I22: the toast read "Undo Add box" after Ctrl+Z.
    expect(historyStepMessage('undo', 'Add box')).toBe('Undid Add box.');
    expect(historyStepMessage('redo', 'Delete Boss.')).toBe(
      'Redid Delete Boss.'
    );
    expect(historyStepMessage('undo', null)).toBe('Undid the last change.');
    expect(historyStepMessage('redo', ' ')).toBe('Redid the last change.');
  });
});
