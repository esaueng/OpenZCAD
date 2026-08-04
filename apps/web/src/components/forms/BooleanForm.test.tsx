import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { toBodyId } from '@openzcad/shared';
import { BooleanForm, type BodyOption } from './FeatureForms';

const bodies: BodyOption[] = [
  { bodyId: toBodyId('body_left'), name: 'Left', consumed: false },
  { bodyId: toBodyId('body_right'), name: 'Right', consumed: false }
];

describe('Boolean form guidance', () => {
  it('explains that Union cannot fill a gap', () => {
    const markup = renderToStaticMarkup(
      <BooleanForm
        bodies={bodies}
        presetOperation="union"
        submitLabel="Create"
        onSubmit={() => undefined}
      />
    );

    expect(markup).toContain(
      'Union joins solids that touch or overlap. It does not fill empty gaps.'
    );
  });
});
