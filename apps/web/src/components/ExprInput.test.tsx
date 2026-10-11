import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ExprInput } from './ExprInput';
import {
  ParameterDefinitionProvider,
  type ParameterDefinition
} from './forms/parameterDefinition';

describe('ExprInput', () => {
  it('says nothing under a blank optional field', () => {
    const { container } = render(
      <ExprInput
        label="End radius (blank = constant)"
        value=""
        scope={{}}
        optional
        onChange={vi.fn()}
      />
    );
    const input = screen.getByRole('textbox', {
      name: 'End radius (blank = constant)'
    });
    expect(container.querySelector('.expr-preview')).toBeNull();
    expect(screen.queryByText('required')).toBeNull();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('still flags a blank required field', () => {
    render(<ExprInput label="Radius" value="" scope={{}} onChange={vi.fn()} />);
    expect(screen.getByText('required')).toHaveClass('expr-preview', 'error');
    expect(screen.getByRole('textbox', { name: 'Radius' })).toHaveAttribute(
      'aria-invalid',
      'true'
    );
  });

  it('previews an optional expression once one is typed', () => {
    render(
      <ExprInput
        label="End radius (blank = constant)"
        value="r * 2"
        scope={{ r: 3 }}
        optional
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText('= 6')).toHaveClass('expr-preview');
  });

  it('takes an accessible name that says more than its visible label', () => {
    render(
      <ExprInput
        label="dX"
        ariaLabel="Move X in mm"
        value="r * 2"
        scope={{ r: 3 }}
        onChange={vi.fn()}
      />
    );
    const input = screen.getByRole('textbox', { name: 'Move X in mm' });
    expect(screen.getByText('dX')).toBeVisible();
    // The preview stays a description, never part of the name.
    expect(input).toHaveAccessibleDescription('= 6');
  });
});

describe('ExprInput defines a parameter where it is first used (G5)', () => {
  /**
   * A field over a small parameter table, the way the workspace wires one:
   * defining a name adds it to the scope the field evaluates against.
   */
  function Harness({
    initial = '80',
    table = {},
    broken = [],
    define,
    renderFirst = false
  }: {
    initial?: string;
    table?: Record<string, number>;
    broken?: string[];
    define?: ParameterDefinition['define'];
    renderFirst?: boolean;
  }) {
    const [value, setValue] = useState(initial);
    const [scope, setScope] = useState(table);
    const definition: ParameterDefinition = {
      has: (name) => name in scope || broken.includes(name),
      define: async (name, expression) => {
        const refusal = (await define?.(name, expression)) ?? null;
        if (!refusal) setScope((current) => ({ ...current, [name]: 80 }));
        // The workspace renders the new parameter before the definition
        // returns: the prompt is gone by the time it does.
        if (renderFirst) await new Promise((done) => setTimeout(done, 0));
        return refusal;
      }
    };
    return (
      <ParameterDefinitionProvider value={definition}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitted();
          }}
        >
          <ExprInput
            label="Width (X)"
            value={value}
            scope={scope}
            onChange={setValue}
          />
        </form>
      </ParameterDefinitionProvider>
    );
  }
  const submitted = vi.fn();

  async function typeName(name: string) {
    const field = screen.getByRole('textbox', { name: 'Width (X)' });
    fireEvent.change(field, { target: { value: name } });
    return {
      field,
      value: await screen.findByRole('textbox', {
        name: `Value for new parameter ${name}`
      })
    };
  }

  it('offers to define an unknown name with the value it replaced', async () => {
    render(<Harness />);
    const { field, value } = await typeName('width');
    expect(screen.getByText('is not defined yet')).toBeVisible();
    expect(value).toHaveValue('80');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('width is not defined yet');
    // The bare error is replaced, not repeated.
    expect(screen.queryByText(/Unknown identifier/)).toBeNull();
  });

  it('defines it on Enter without submitting the card, then evaluates', async () => {
    const define = vi.fn(async () => null);
    submitted.mockClear();
    render(<Harness define={define} />);
    const { field, value } = await typeName('width');
    fireEvent.change(value, { target: { value: '120 / 1.5' } });
    await act(async () => {
      fireEvent.keyDown(value, { key: 'Enter' });
    });
    expect(define).toHaveBeenCalledWith('width', '120 / 1.5');
    expect(submitted).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('= 80')).toBeVisible());
    expect(
      screen.queryByRole('textbox', { name: 'Value for new parameter width' })
    ).toBeNull();
    expect(field).not.toHaveAttribute('aria-invalid');
    // Focus is back in the field, ready for Enter to create.
    expect(field).toHaveFocus();
  });

  it('takes focus back even when the prompt is gone before it returns', async () => {
    render(<Harness renderFirst />);
    const { field, value } = await typeName('width');
    await act(async () => {
      fireEvent.keyDown(value, { key: 'Enter' });
    });
    await waitFor(() => expect(field).toHaveFocus());
    expect(screen.getByText('= 80')).toBeVisible();
  });

  it('defines it from the button', async () => {
    const define = vi.fn(async () => null);
    render(<Harness define={define} />);
    await typeName('width');
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Define parameter width' })
      );
    });
    expect(define).toHaveBeenCalledWith('width', '80');
    await waitFor(() => expect(screen.getByText('= 80')).toBeVisible());
  });

  it('keeps the prompt and shows a refusal', async () => {
    const define = vi.fn(async () => 'width already exists.');
    render(<Harness define={define} />);
    const { value } = await typeName('width');
    await act(async () => {
      fireEvent.keyDown(value, { key: 'Enter' });
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'width already exists.'
    );
    expect(value).toHaveAttribute('aria-invalid', 'true');
  });

  it('asks for a value rather than defining an empty one', async () => {
    const define = vi.fn(async () => null);
    render(<Harness initial="w" define={define} />);
    // The field never evaluated, so there is no value to offer.
    const value = await screen.findByRole('textbox', {
      name: 'Value for new parameter w'
    });
    expect(value).toHaveValue('');
    await act(async () => {
      fireEvent.keyDown(value, { key: 'Enter' });
    });
    expect(define).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a value for w.');
  });

  it('keeps the plain error for an invalid expression', () => {
    // Defining `width` would not make it evaluate, so the field keeps the
    // evaluator's own error and offers nothing.
    render(<Harness initial="width +" />);
    expect(screen.getByText(/Unknown identifier "width"/)).toHaveClass(
      'expr-preview',
      'error'
    );
    expect(screen.queryByText('is not defined yet')).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: 'Value for new parameter width' })
    ).toBeNull();
  });

  it('never offers to redefine a parameter whose expression is broken', () => {
    // A broken parameter is absent from the scope but present in the table.
    render(<Harness initial="width" broken={['width']} />);
    expect(screen.getByText(/Unknown identifier "width"/)).toBeVisible();
    expect(screen.queryByText('is not defined yet')).toBeNull();
  });

  it('only reports the name where no document can take a parameter', () => {
    render(
      <ExprInput
        label="Width (X)"
        value="width"
        scope={{}}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText(/Unknown identifier "width"/)).toBeVisible();
  });
});
