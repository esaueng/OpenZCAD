/**
 * Per-frame text for overlay chips and HUDs, written without replacing nodes.
 *
 * `element.textContent = text` removes the element's children and inserts a
 * new text node, even when the text is unchanged. The workspace stylesheets
 * carry many `:has()` rules anchored on `.viewer-area` and `.workspace`, and
 * a child-list mutation anywhere under them makes Chromium re-evaluate those
 * rules and restyle the workspace subtree: about 10 ms per write on a
 * dragged face's chip, every frame (docs/qa/2026-11-11/face-commit-hitches.md).
 * Changing an existing text node's data is a character-data mutation, which
 * no `:has()` rule observes, so it costs a local relayout only.
 */
export function setElementText(element: Element, text: string): void {
  const only = element.firstChild;
  if (
    only !== null &&
    only === element.lastChild &&
    only.nodeType === Node.TEXT_NODE
  ) {
    // An empty text node would stop `:empty` matching; clearing keeps
    // `textContent = ''` semantics.
    if (text === '') element.textContent = '';
    else if ((only as Text).data !== text) (only as Text).data = text;
    return;
  }
  if (text === '' && element.firstChild === null) return;
  element.textContent = text;
}

/**
 * Chip text split into prefix, number and units spans so the number can carry
 * the weight and the rest can recede ("Total 25.59 mm" reads back exactly as
 * written). An unchanged split reuses the existing spans and only updates
 * their text, for the same reason as `setElementText`.
 */
export function renderChipText(chip: HTMLElement, text: string): void {
  const match = /^(.*?)(-?\d[\d.,]*)(\s\S+)?$/.exec(text);
  if (!match) {
    setElementText(chip, text);
    return;
  }
  const [, prefix = '', number = '', units = ''] = match;
  const parts: [className: string, text: string][] = [];
  if (prefix) parts.push(['chip-prefix', prefix]);
  parts.push(['chip-number', number]);
  if (units) parts.push(['chip-units', units]);
  const children = chip.childNodes;
  const reusable =
    children.length === parts.length &&
    parts.every(([className], index) => {
      const child = children[index]!;
      return (
        child.nodeType === Node.ELEMENT_NODE &&
        (child as Element).tagName === 'SPAN' &&
        (child as Element).className === className
      );
    });
  if (reusable) {
    parts.forEach(([, part], index) =>
      setElementText(children[index] as Element, part)
    );
    return;
  }
  chip.replaceChildren(
    ...parts.map(([className, part]) => {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = part;
      return span;
    })
  );
}
