import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toArtifactId, type ProjectSummary } from '@openzcad/shared';
import { PartThumbnail } from './PartThumbnail';
import {
  allowKeySession,
  blockKeySession,
  getKeySessionRevision
} from '../lib/e2ee/keySession';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: `project_${Math.random().toString(36).slice(2)}`,
    name: 'Bright Penguin',
    updatedAt: '2026-08-06T19:22:15.000Z',
    ...overrides
  } as ProjectSummary;
}

describe('PartThumbnail', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', undefined);
    vi.spyOn(HTMLImageElement.prototype, 'decode').mockResolvedValue(undefined);
    allowKeySession(getKeySessionRevision());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the same image node through metadata, artifact and document refreshes until decoding completes', async () => {
    const project = summary({ thumbnailArtifactId: toArtifactId('old') });
    const replacement = deferred<string>();
    const decoding = deferred<void>();
    const load = vi
      .fn()
      .mockResolvedValueOnce('data:image/webp;base64,AA')
      .mockReturnValue(replacement.promise);
    const publish = vi.fn();
    const view = render(
      <PartThumbnail
        project={project}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    await waitFor(() =>
      expect(view.container.querySelector('img')).toBeTruthy()
    );
    const image = view.container.querySelector('img');
    view.rerender(
      <PartThumbnail
        project={{ ...project, name: 'Verified name' }}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    expect(load).toHaveBeenCalledTimes(1);
    vi.mocked(HTMLImageElement.prototype.decode).mockReturnValueOnce(
      decoding.promise
    );
    view.rerender(
      <PartThumbnail
        project={{
          ...project,
          updatedAt: '2026-10-28',
          thumbnailArtifactId: toArtifactId('new')
        }}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    expect(view.container.querySelector('img')).toBe(image);
    await act(async () => replacement.resolve('data:image/webp;base64,BB'));
    expect(image).toHaveAttribute('src', 'data:image/webp;base64,AA');
    await act(async () => decoding.resolve());
    expect(view.container.querySelector('img')).toBe(image);
    expect(image).toHaveAttribute('src', 'data:image/webp;base64,BB');
  });

  it.each(['miss', 'network failure', 'decode failure'])(
    'retains a usable preview after a refresh %s',
    async (failure) => {
      const project = summary({ thumbnailArtifactId: toArtifactId('old') });
      const load = vi.fn().mockResolvedValue('data:image/webp;base64,AA');
      const publish = vi.fn().mockResolvedValue(undefined);
      const view = render(
        <PartThumbnail
          project={project}
          loadThumbnail={load}
          publishThumbnail={publish}
        />
      );
      await waitFor(() =>
        expect(view.container.querySelector('img')).toBeTruthy()
      );
      const image = view.container.querySelector('img');
      if (failure === 'miss') load.mockResolvedValue(undefined);
      else if (failure === 'network failure')
        load.mockRejectedValue(new Error('offline'));
      else {
        load.mockResolvedValue('invalid-image');
        vi.mocked(HTMLImageElement.prototype.decode).mockRejectedValueOnce(
          new Error('corrupt image')
        );
      }
      view.rerender(
        <PartThumbnail
          project={{ ...project, documentVersion: 2 }}
          loadThumbnail={load}
          publishThumbnail={publish}
        />
      );
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      await act(async () => undefined);
      expect(view.container.querySelector('img')).toBe(image);
      expect(image).toHaveAttribute('src', 'data:image/webp;base64,AA');
    }
  );

  it('renders the decoded preview synchronously when returning to the library', async () => {
    const project = summary({ thumbnailArtifactId: toArtifactId('existing') });
    const load = vi.fn().mockResolvedValue('data:image/webp;base64,AA');
    const publish = vi.fn();
    const first = render(
      <PartThumbnail
        project={project}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    await waitFor(() =>
      expect(first.container.querySelector('img')).toBeTruthy()
    );
    first.unmount();
    const second = render(
      <PartThumbnail
        project={project}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    expect(second.container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/webp;base64,AA'
    );
    expect(second.container.querySelector('svg')).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shows a real empty result and retries it when the document changes', async () => {
    const project = summary({ thumbnailArtifactId: toArtifactId('existing') });
    const load = vi
      .fn()
      .mockResolvedValueOnce('data:image/webp;base64,AA')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('data:image/webp;base64,BB');
    const publish = vi.fn();
    const view = render(
      <PartThumbnail
        project={project}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    await waitFor(() =>
      expect(view.container.querySelector('img')).toBeTruthy()
    );
    view.rerender(
      <PartThumbnail
        project={{ ...project, documentVersion: 2 }}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    await waitFor(() =>
      expect(view.container).toHaveTextContent('No geometry')
    );
    view.rerender(
      <PartThumbnail
        project={{ ...project, documentVersion: 3 }}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    await waitFor(() =>
      expect(view.container.querySelector('img')).toHaveAttribute(
        'src',
        'data:image/webp;base64,BB'
      )
    );
  });

  it('preserves a device preview when the account identifies the same project as encrypted', async () => {
    const project = summary({ thumbnailArtifactId: toArtifactId('existing') });
    const load = vi
      .fn()
      .mockResolvedValueOnce('data:image/webp;base64,AA')
      .mockReturnValue(new Promise(() => undefined));
    const publish = vi.fn();
    const view = render(
      <PartThumbnail
        project={project}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    await waitFor(() =>
      expect(view.container.querySelector('img')).toBeTruthy()
    );
    const image = view.container.querySelector('img');
    view.rerender(
      <PartThumbnail
        accountId="account-a"
        project={{ ...project, storageFormat: 2 }}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    expect(view.container.querySelector('img')).toBe(image);
    act(() => blockKeySession());
    expect(view.container.querySelector('img')).toBeNull();
  });

  it.each(['account', 'key session', 'unsupported format'])(
    'invalidates protected previews on %s changes and refuses late results',
    async (change) => {
      const project = summary({
        storageFormat: 2,
        thumbnailArtifactId: toArtifactId('existing')
      });
      const late = deferred<string>();
      const load = vi
        .fn()
        .mockResolvedValueOnce('data:image/webp;base64,AA')
        .mockReturnValueOnce(late.promise)
        .mockResolvedValue(undefined);
      const publish = vi.fn().mockResolvedValue(undefined);
      const view = render(
        <PartThumbnail
          accountId="account-a"
          project={project}
          loadThumbnail={load}
          publishThumbnail={publish}
        />
      );
      await waitFor(() =>
        expect(view.container.querySelector('img')).toBeTruthy()
      );
      const updated = { ...project, documentVersion: 2 };
      view.rerender(
        <PartThumbnail
          accountId="account-a"
          project={updated}
          loadThumbnail={load}
          publishThumbnail={publish}
        />
      );
      await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
      if (change === 'key session') act(() => blockKeySession());
      else
        view.rerender(
          <PartThumbnail
            accountId={change === 'account' ? 'account-b' : 'account-a'}
            project={
              change === 'unsupported format'
                ? { ...updated, storageFormat: 3 }
                : updated
            }
            loadThumbnail={load}
            publishThumbnail={publish}
          />
        );
      expect(view.container.querySelector('img')).toBeNull();
      await act(async () => late.resolve('data:image/webp;base64,BB'));
      expect(view.container.querySelector('img')).toBeNull();
    }
  );

  it('does not let an older request replace a newer preview in the remount cache', async () => {
    const project = summary({ thumbnailArtifactId: toArtifactId('existing') });
    const old = deferred<string>();
    const load = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce('data:image/webp;base64,BB');
    const publish = vi.fn();
    const view = render(
      <PartThumbnail
        project={project}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    const updated = { ...project, documentVersion: 2 };
    view.rerender(
      <PartThumbnail
        project={updated}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    await waitFor(() =>
      expect(view.container.querySelector('img')).toHaveAttribute(
        'src',
        'data:image/webp;base64,BB'
      )
    );
    await act(async () => old.resolve('data:image/webp;base64,AA'));
    view.unmount();
    const remount = render(
      <PartThumbnail
        project={updated}
        loadThumbnail={load}
        publishThumbnail={publish}
      />
    );
    expect(remount.container.querySelector('img')).toHaveAttribute(
      'src',
      'data:image/webp;base64,BB'
    );
  });

  it('defers offscreen previews until they approach the viewport and disconnects on unmount', async () => {
    const observers: Array<{
      callback: IntersectionObserverCallback;
      observe: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor(callback: IntersectionObserverCallback) {
          observers.push({
            callback,
            observe: this.observe,
            disconnect: this.disconnect
          });
        }
      }
    );
    const project = summary();
    const loadThumbnail = vi.fn().mockResolvedValue(undefined);
    const publishThumbnail = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <PartThumbnail
        project={project}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );
    const observer = observers[0];
    if (!observer) throw new Error('Preview observer was not created');
    expect(observer.observe).toHaveBeenCalledWith(
      view.container.querySelector('svg')
    );
    expect(loadThumbnail).not.toHaveBeenCalled();
    act(() =>
      observer.callback(
        [{ isIntersecting: false }] as IntersectionObserverEntry[],
        {} as IntersectionObserver
      )
    );
    expect(loadThumbnail).not.toHaveBeenCalled();
    act(() =>
      observer.callback(
        [{ isIntersecting: true }] as IntersectionObserverEntry[],
        {} as IntersectionObserver
      )
    );
    await waitFor(() => expect(publishThumbnail).toHaveBeenCalledWith(project));
    expect(loadThumbnail).toHaveBeenCalledTimes(1);
    expect(observer.disconnect).toHaveBeenCalled();
    view.unmount();
    expect(observer.disconnect).toHaveBeenCalledTimes(2);
  });

  it('renders the cached image without asking for anything else', async () => {
    const project = summary({
      thumbnailArtifactId: toArtifactId('artifact_cached')
    });
    const loadThumbnail = vi
      .fn()
      .mockResolvedValue('data:image/webp;base64,AA');
    const publishThumbnail = vi.fn();

    render(
      <PartThumbnail
        project={project}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    const image = await screen.findByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('src', 'data:image/webp;base64,AA');
    expect(loadThumbnail).toHaveBeenCalledTimes(1);
    expect(loadThumbnail).toHaveBeenCalledWith(project);
    expect(publishThumbnail).not.toHaveBeenCalled();
  });

  it('publishes a device-only cached image in the background', async () => {
    const project = summary();
    const loadThumbnail = vi
      .fn()
      .mockResolvedValue('data:image/webp;base64,AA');
    const publishThumbnail = vi.fn().mockResolvedValue(undefined);

    render(
      <PartThumbnail
        project={project}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    expect(
      await screen.findByRole('presentation', { hidden: true })
    ).toHaveAttribute('src', 'data:image/webp;base64,AA');
    await waitFor(() => expect(publishThumbnail).toHaveBeenCalledWith(project));
  });

  it('renders a preview the cold cache had to produce', async () => {
    // The shelf that matters: every project predates the cache, so a tile with
    // no cached image has to be able to ask for one or it never gets a picture.
    const project = summary();
    const loadThumbnail = vi.fn().mockResolvedValue(undefined);
    const publishThumbnail = vi
      .fn()
      .mockResolvedValue('data:image/webp;base64,BB');

    render(
      <PartThumbnail
        project={project}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    const image = await screen.findByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('src', 'data:image/webp;base64,BB');
    expect(publishThumbnail).toHaveBeenCalledWith(project);
  });

  it('falls back to the placeholder when there is nothing to render from', async () => {
    // The case that keeps a project too large to open reachable: nothing this
    // device holds, and no attempt to fetch it, so the shelf still paints.
    const loadThumbnail = vi.fn().mockResolvedValue(undefined);
    const publishThumbnail = vi.fn().mockResolvedValue(undefined);

    render(
      <PartThumbnail
        project={summary()}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    await waitFor(() => expect(publishThumbnail).toHaveBeenCalled());
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText('No geometry')).toBeNull();
  });

  it('reports a genuinely empty part differently from a missing preview', async () => {
    const loadThumbnail = vi.fn().mockResolvedValue(null);
    const publishThumbnail = vi.fn();

    const view = render(
      <PartThumbnail
        project={summary()}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    expect(await screen.findByText('No geometry')).toBeVisible();
    // One placeholder for both: an empty part keeps the wire cube a missing
    // preview shows, captioned, rather than swapping it for text alone.
    expect(view.container.querySelector('svg')).toBeInTheDocument();
    // A cached "empty" is an answer, not a miss — re-deriving it every visit
    // would defeat the cache for exactly the parts that render to nothing.
    expect(publishThumbnail).not.toHaveBeenCalled();
  });

  it('keeps the empty caption out of the name of the tile that holds it', async () => {
    // The preview sits first inside the tile's open button, so its caption
    // used to open every empty part's name: "No geometry Bright Penguin …".
    const project = summary();

    render(
      <button type="button">
        <PartThumbnail
          project={project}
          loadThumbnail={vi.fn().mockResolvedValue(null)}
          publishThumbnail={vi.fn()}
        />
        {project.name}
      </button>
    );

    expect(await screen.findByText('No geometry')).toBeVisible();
    expect(screen.getByRole('button')).toHaveAccessibleName(project.name);
  });

  it('survives a rejected read without throwing', async () => {
    const loadThumbnail = vi.fn().mockRejectedValue(new Error('idb closed'));
    const publishThumbnail = vi.fn();

    render(
      <PartThumbnail
        project={summary()}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    await waitFor(() => expect(loadThumbnail).toHaveBeenCalled());
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('survives a rejected backfill without throwing', async () => {
    const loadThumbnail = vi.fn().mockResolvedValue(undefined);
    const publishThumbnail = vi
      .fn()
      .mockRejectedValue(new Error('no webgl context'));

    render(
      <PartThumbnail
        project={summary()}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    await waitFor(() => expect(publishThumbnail).toHaveBeenCalled());
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('retries a miss when the same project listing gains a cloud artifact', async () => {
    const project = summary();
    const loadThumbnail = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('data:image/webp;base64,CC');
    const publishThumbnail = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <PartThumbnail
        project={project}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );
    await waitFor(() => expect(publishThumbnail).toHaveBeenCalledTimes(1));

    rerender(
      <PartThumbnail
        project={{
          ...project,
          thumbnailArtifactId: toArtifactId('artifact_thumbnail')
        }}
        loadThumbnail={loadThumbnail}
        publishThumbnail={publishThumbnail}
      />
    );

    const image = await screen.findByRole('presentation', { hidden: true });
    expect(image).toHaveAttribute('src', 'data:image/webp;base64,CC');
    expect(loadThumbnail).toHaveBeenCalledTimes(2);
  });
});
