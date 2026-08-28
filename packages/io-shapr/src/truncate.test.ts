import { describe, expect, it } from 'vitest';
import { truncateCodeUnits } from './truncate';

/** Any astral character is two UTF-16 code units; this one is a rocket. */
const ROCKET = '\u{1F680}';

describe('truncating a name to a code-unit budget', () => {
  it('leaves anything within budget exactly as it was', () => {
    expect(truncateCodeUnits('Bracket', 200)).toBe('Bracket');
    expect(truncateCodeUnits('', 200)).toBe('');
  });

  it('cuts at the budget when the boundary falls between characters', () => {
    expect(truncateCodeUnits('abcdef', 3)).toBe('abc');
    expect(truncateCodeUnits('a'.repeat(300), 200)).toHaveLength(200);
  });

  /**
   * The defect. `slice(0, n)` counts code units, so a boundary landing inside
   * a surrogate pair used to keep the high half on its own — an ill-formed
   * string that renders as the replacement character everywhere the name is
   * shown, and is persisted that way in the migration record.
   */
  it('does not cut a surrogate pair in half', () => {
    // 'ab' + rocket: the rocket occupies units 2 and 3, so a budget of 3
    // lands between its halves.
    const name = `ab${ROCKET}`;
    const cut = truncateCodeUnits(name, 3);
    expect(cut).toBe('ab');
    expect(cut).not.toContain('\uD83D');
    expect(isWellFormed(cut)).toBe(true);
  });

  it('keeps a pair that fits whole', () => {
    expect(truncateCodeUnits(`ab${ROCKET}cd`, 4)).toBe(`ab${ROCKET}`);
  });

  it('never returns more than the budget, whatever the input', () => {
    // The bound is what protects the byte ceiling downstream, so widening it
    // to fit a whole character would be a limit change rather than a fix.
    for (const filler of ['a', ROCKET, `a${ROCKET}`]) {
      const cut = truncateCodeUnits(filler.repeat(400), 200);
      expect(cut.length).toBeLessThanOrEqual(200);
      expect(isWellFormed(cut)).toBe(true);
    }
  });
});

/** `String.prototype.isWellFormed` is ES2024; this is the same predicate. */
function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
