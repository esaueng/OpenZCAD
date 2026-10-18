import { useEffect, useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLazyPanel } from './LazyPanel';

describe('lazy panels', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps View tools in its rail while loading and retains offline guidance', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    let finish!: (module: { default: () => React.JSX.Element }) => void;
    const Tools = createLazyPanel<object>(
      'View tools',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      'view-tools'
    );
    render(<Tools />);
    const status = await screen.findByRole('status');
    expect(status).toHaveClass('view-mode-bar', 'view-tools-loading');
    expect(status).not.toHaveClass('error-boundary');
    expect(status).toHaveTextContent('Loading view tools…');
    online.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(status).toHaveTextContent('View tools is not loaded yet.');
    expect(status).toHaveTextContent(
      'Connect to the internet to load this panel.'
    );
    await act(async () =>
      finish({ default: () => <p>View controls ready</p> })
    );
    expect(screen.getByText('View controls ready')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('waits offline and reconnects without losing workspace state or starting duplicate downloads', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const load = vi
      .fn()
      .mockResolvedValue({ default: () => <p>Saved feature history</p> });
    const Drawer = createLazyPanel('Model drawer', load);
    function Workspace() {
      const [features, setFeatures] = useState(1);
      return (
        <>
          <button onClick={() => setFeatures((n) => n + 1)}>
            Model features: {features}
          </button>
          <Drawer />
        </>
      );
    }
    render(<Workspace />);
    await screen.findByText('Connect to the internet to load this panel.');
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByText(/updated|new version/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Model features: 1' }));
    // A spurious notification while still offline must not start the import.
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(load).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
    });
    await screen.findByText('Saved feature history');
    expect(load).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: 'Model features: 2' })
    ).toBeTruthy();
  });

  it('keeps a real download rejection local with an honest reload action', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Drawer = createLazyPanel<object>('Model drawer', () =>
      Promise.reject(
        new TypeError('Failed to fetch dynamically imported module: /drawer.js')
      )
    );
    render(
      <>
        <p>Model remains available</p>
        <Drawer />
      </>
    );
    await screen.findByText('Model drawer could not be rendered.');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Check your connection'
    );
    expect(
      screen.getByRole('button', { name: 'Reload workspace' })
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry panel' })).toBeNull();
    expect(screen.getByText('Model remains available')).toBeTruthy();
    expect(screen.queryByText(/updated|new version/i)).toBeNull();
  });

  it('retains loaded identity across updates and reopens a cached panel offline', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const mount = vi.fn();
    function Panel({ value }: { value: string }) {
      useEffect(() => {
        mount();
      }, []);
      return <p>{value}</p>;
    }
    const load = vi.fn().mockResolvedValue({ default: Panel });
    const Drawer = createLazyPanel<{ value: string }>('Model drawer', load);
    const { rerender } = render(<Drawer value="First feature" />);
    await screen.findByText('First feature');
    rerender(<Drawer value="Second feature" />);
    expect(screen.getByText('Second feature')).toBeTruthy();
    expect(mount).toHaveBeenCalledOnce();
    rerender(<></>);
    online.mockReturnValue(false);
    rerender(<Drawer value="Cached offline history" />);
    expect(screen.getByText('Cached offline history')).toBeTruthy();
    expect(load).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Connect to the internet/)).toBeNull();
  });
});
