import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StartupScreen } from './StartupScreen';

describe('startup screen', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function steps(container: HTMLElement) {
    return [...container.querySelectorAll('.startup-steps li')].map(
      (step) => step.className
    );
  }

  it('names the part and the real stage it is in', () => {
    const { container, rerender } = render(
      <StartupScreen projectName="Selected bracket" />
    );
    const status = screen.getByRole('status', { name: 'Opening project' });
    expect(status).toHaveTextContent('Selected bracket');
    expect(status).toHaveTextContent('Checking saved copies');
    expect(steps(container)).toEqual(['is-active', '', '']);

    rerender(<StartupScreen projectName="Selected bracket" stage="model" />);
    expect(
      screen.getByRole('status', { name: 'Restoring workspace' })
    ).toHaveTextContent('Building the model');
    expect(steps(container)).toEqual(['is-done', 'is-active', '']);

    rerender(<StartupScreen projectName="Selected bracket" stage="panels" />);
    expect(screen.getByText('Loading tools and panels')).toBeVisible();
    expect(steps(container)).toEqual(['is-done', 'is-done', 'is-active']);
  });

  it('restores without a name until the part is known', () => {
    render(<StartupScreen />);
    const status = screen.getByRole('status', { name: 'Restoring workspace' });
    expect(status).toHaveTextContent('Restoring workspace');
    expect(status).toHaveTextContent('Loading your last part');
  });

  it('shows the offline notice in place of the stage', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<StartupScreen stage="panels" loadingChunks />);
    expect(screen.getByText(/You’re offline/)).toHaveClass('is-offline');
    expect(screen.queryByText('Loading tools and panels')).toBeNull();
  });

  it('reassures only after a long model build', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<StartupScreen stage="model" />);
    await act(async () => vi.advanceTimersByTimeAsync(5900));
    expect(screen.queryByText(/take longer to rebuild/)).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(200));
    expect(screen.getByText(/take longer to rebuild/)).toBeVisible();
    rerender(<StartupScreen stage="panels" />);
    expect(screen.queryByText(/take longer to rebuild/)).toBeNull();
  });

  it('phase-locks the building mark to the page clock across remounts', () => {
    vi.spyOn(performance, 'now').mockReturnValue(7000);
    const { container, unmount } = render(<StartupScreen />);
    const phase = () =>
      container
        .querySelector<SVGElement>('.startup-mark')
        ?.style.getPropertyValue('--startup-phase');
    // 7000ms into the page is 600ms into the 3200ms build cycle.
    expect(phase()).toBe('-600ms');
    unmount();
    vi.spyOn(performance, 'now').mockReturnValue(7400);
    const next = render(<StartupScreen projectName="Part" />);
    expect(
      next.container
        .querySelector<SVGElement>('.startup-mark')
        ?.style.getPropertyValue('--startup-phase')
    ).toBe('-1000ms');
  });
});
