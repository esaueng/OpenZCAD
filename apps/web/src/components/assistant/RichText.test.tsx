import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RichText } from './RichText';

describe('RichText', () => {
  it('numbers a loose list 1, 2, 3 rather than 1, 1, 1', () => {
    const { container } = render(
      <RichText text={'1. Sketch\n\n2. Draw\n\n3. Cut'} />
    );
    const lists = container.querySelectorAll('ol');
    expect(lists).toHaveLength(1);
    expect(lists[0]!.querySelectorAll('li')).toHaveLength(3);
  });

  it('starts a list split by prose at its source number', () => {
    const { container } = render(
      <RichText text={'1. Sketch\n\nThen:\n\n2. Draw\n3. Cut'} />
    );
    const lists = container.querySelectorAll('ol');
    expect(lists).toHaveLength(2);
    expect(lists[0]!.hasAttribute('start')).toBe(false);
    expect(lists[1]!.getAttribute('start')).toBe('2');
  });

  it('renders snake_case names without italics', () => {
    const { container } = render(
      <RichText text="Set plate_length to 2*3*4 and keep _this_ in italics." />
    );
    expect(
      Array.from(container.querySelectorAll('em')).map((em) => em.textContent)
    ).toEqual(['this']);
    expect(container.textContent).toContain('plate_length to 2*3*4');
  });
});
