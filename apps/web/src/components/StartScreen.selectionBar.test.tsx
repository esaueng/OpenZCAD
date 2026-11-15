import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toProjectId, type ProjectSummary } from '@openzcad/shared';
import { ErrorBoundary } from './ErrorBoundary';
import type * as PreloadableSlotModule from './PreloadableSlot';

/**
 * The library's selection bar loads on demand. `StartScreen.test.tsx` loads it
 * up front; these cases take the cold path, with its chunk held back by hand
 * (a selection that beats the idle warm-up) or refused (a deploy removed it).
 */
const chunk = vi.hoisted(() => {
  const held: {
    release(): void;
    refuse(error: unknown): void;
    gate: Promise<void>;
  } = {
    release: () => undefined,
    refuse: () => undefined,
    gate: Promise.resolve()
  };
  return held;
});

// Every on-demand slot the library makes waits on the gate before loading.
vi.mock('./PreloadableSlot', async (importOriginal) => {
  const actual = await importOriginal<typeof PreloadableSlotModule>();
  return {
    ...actual,
    preloadableSlot: ((label, load, options) =>
      actual.preloadableSlot(
        label,
        async () => {
          await chunk.gate;
          return load();
        },
        options
      )) as typeof actual.preloadableSlot
  };
});

function holdChunk() {
  chunk.gate = new Promise<void>((resolve, reject) => {
    chunk.release = resolve;
    chunk.refuse = reject;
  });
}

const parts: ProjectSummary[] = ['Alpha', 'Bravo'].map((name, index) => ({
  projectId: toProjectId(`project_${name.toLowerCase()}`),
  name: `${name} plate`,
  revisionCount: 1,
  updatedAt: `2026-10-0${index + 1}T12:00:00.000Z`,
  organization: { status: 'active', pinned: false, sortOrder: index }
}));

async function renderLibrary() {
  // A fresh module graph each time: the bar's loaded state is module-wide.
  vi.resetModules();
  const { StartScreen } = await import('./StartScreen');
  const props: ComponentProps<typeof StartScreen> = {
    projects: parts,
    status: '',
    busy: false,
    demos: [],
    defaultUnits: 'mm',
    onCreate: vi.fn(),
    onOpen: vi.fn(),
    onOpenDemo: vi.fn(),
    onOpenSettings: vi.fn(),
    onDuplicate: vi.fn(),
    loadProperties: vi.fn().mockResolvedValue(null),
    cloudProjectIds: new Set(),
    accountProjectListReached: true,
    conflictedProjectIds: new Set(),
    signedIn: true,
    onSaveToAccount: vi.fn(),
    onSaveAllToAccount: vi.fn(),
    syncRun: null,
    onRetrySync: vi.fn(),
    onDismissSyncRun: vi.fn(),
    onMoveToShelf: vi.fn(),
    onTogglePin: vi.fn(),
    onReorder: vi.fn(),
    onDeleteForever: vi.fn(),
    onEmptyTrash: vi.fn(),
    loadThumbnail: vi.fn().mockResolvedValue(undefined),
    publishThumbnail: vi.fn().mockResolvedValue(undefined)
  };
  render(
    <ErrorBoundary label="OpenZCAD" scope="page">
      <StartScreen {...props} />
    </ErrorBoundary>
  );
}

beforeEach(holdChunk);

afterEach(() => {
  sessionStorage.removeItem('openzcad.start.view');
  sessionStorage.removeItem('openzcad.start.scroll');
  sessionStorage.removeItem('openzcad.start.draft');
  vi.restoreAllMocks();
});

describe('the library selection bar, loaded cold', () => {
  it('appears for a selection made before its chunk arrives, and keeps it', async () => {
    await renderLibrary();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Alpha plate' })
    );
    expect(screen.queryByRole('toolbar')).toBeNull();
    // The selection is the library's, not the bar's: it holds while loading.
    expect(
      screen.getByRole('checkbox', { name: 'Select Alpha plate' })
    ).toBeChecked();
    await act(async () => chunk.release());
    expect(
      await screen.findByRole('toolbar', { name: '1 project selected' })
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Bravo plate' })
    );
    expect(
      screen.getByRole('toolbar', { name: '2 projects selected' })
    ).toBeInTheDocument();
  });

  it('keeps the library when the chunk cannot load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // The failed chunk is re-fetched past the cache for the Reload offered.
    const refetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(''));
    await renderLibrary();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Alpha plate' })
    );
    await act(async () =>
      chunk.refuse(
        new TypeError(
          'Failed to fetch dynamically imported module: /assets/LibrarySelectionBar-gone.js'
        )
      )
    );
    expect(
      await screen.findByText('Selection actions did not load.')
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Part of OpenZCAD could not load' })
    ).toBeNull();
    expect(refetch).toHaveBeenCalledWith(
      expect.stringContaining('/assets/LibrarySelectionBar-gone.js'),
      { cache: 'reload' }
    );
    expect(
      screen.getByRole('checkbox', { name: 'Select Bravo plate' })
    ).toBeInTheDocument();
  });
});
