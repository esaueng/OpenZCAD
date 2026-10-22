import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  addReferenceImage,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type ArtifactId,
  type ReferenceImage,
  type ReferenceImageId
} from '@openzcad/shared';
import { ReferenceImageWorkspaceCard } from './ReferenceImageForm';

const stored: ReferenceImage = {
  imageId: 'rimg_one' as ReferenceImageId,
  name: 'Plan',
  contentType: 'image/png',
  source: {
    marker: 'openzcad-source-ref',
    version: 1,
    hashAlgorithm: 'sha256',
    checksumSha256: 'd'.repeat(64),
    logicalBytes: 10
  },
  artifactId: 'artifact_one' as ArtifactId,
  pixelWidth: 400,
  pixelHeight: 200,
  plane: { type: 'canonical', plane: 'XY', offset: 0 },
  center: { u: 0, v: 0 },
  rotationDeg: 0,
  width: 100,
  opacity: 0.6
};

let rerender: ReturnType<typeof render>['rerender'] = () => undefined;

function setup(
  extra: Partial<Parameters<typeof ReferenceImageWorkspaceCard>[0]> = {}
) {
  const document = addReferenceImage(
    createProjectDocument('Images', toUserId('test')),
    { image: stored }
  );
  const props = {
    document,
    image: document.referenceImages!.images[0]!,
    datumPlanes: [],
    selectedFacePlane: null,
    loadPicture: vi.fn(async () => new Blob([new Uint8Array([1])])),
    editDisabledReason: null,
    onDraft: vi.fn(),
    onApply: vi.fn(() => true),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...extra
  };
  rerender = render(<ReferenceImageWorkspaceCard {...props} />).rerender;
  return props;
}

describe('ReferenceImageWorkspaceCard', () => {
  it('drafts placement live and applies only what changed, as one edit', async () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText('Position U (mm)'), {
      target: { value: '12' }
    });
    fireEvent.change(screen.getByLabelText('Rotation (°)'), {
      target: { value: '30' }
    });
    fireEvent.change(screen.getByLabelText('Image opacity'), {
      target: { value: '0.25' }
    });
    // The viewport follows the draft before anything is applied.
    expect(props.onDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({
        center: { u: 12, v: 0 },
        rotationDeg: 30,
        opacity: 0.25
      })
    );
    expect(props.onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalled());
    expect(props.onApply).toHaveBeenCalledWith({
      imageId: 'rimg_one',
      center: { u: 12, v: 0 },
      rotationDeg: 30,
      opacity: 0.25
    });
    expect(props.onClose).toHaveBeenCalled();
  });

  it('restarts the draft when Undo or Redo moves the open image', async () => {
    const props = setup();
    // An unapplied edit, then Apply: the record now sits at U 12.
    fireEvent.change(screen.getByLabelText('Position U (mm)'), {
      target: { value: '12' }
    });
    const applied = { ...props.image, center: { u: 12, v: 0 } };
    rerender(<ReferenceImageWorkspaceCard {...props} image={applied} />);
    // Undo with the card still open reverts the record (U 0, and here a
    // lower opacity too): the card and the viewport draft follow it, not the
    // stale draft, so Done has nothing to reapply.
    rerender(
      <ReferenceImageWorkspaceCard
        {...props}
        image={{ ...props.image, opacity: 0.3 }}
      />
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Position U (mm)').value
    ).toBe('0');
    expect(screen.getByLabelText<HTMLInputElement>('Image opacity').value).toBe(
      '0.3'
    );
    await waitFor(() =>
      expect(props.onDraft).toHaveBeenLastCalledWith(
        expect.objectContaining({ center: { u: 0, v: 0 }, opacity: 0.3 })
      )
    );
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(props.onApply).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it('refuses a width that is not positive', () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText('Width (mm)'), {
      target: { value: '0' }
    });
    expect(screen.getByText('Width must be a positive number.')).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Done' }).disabled
    ).toBe(true);
    expect(props.onDraft).toHaveBeenLastCalledWith(null);
  });

  it('ignores an invalid offset left behind on a principal plane once the image moves off it', async () => {
    const face = {
      type: 'frame' as const,
      frame: {
        origin: { x: 0, y: 0, z: 9 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        zAxis: { x: 0, y: 0, z: 1 }
      }
    };
    const props = setup({ selectedFacePlane: face });
    fireEvent.change(screen.getByLabelText('Offset (mm)'), {
      target: { value: '' }
    });
    expect(screen.getByText('Offset needs a number.')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Plane' }), {
      target: { value: 'selected-face' }
    });
    // The offset field is gone, and so is its refusal.
    expect(screen.queryByLabelText('Offset (mm)')).toBeNull();
    expect(screen.queryByText('Offset needs a number.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalled());
    expect(props.onApply).toHaveBeenCalledWith({
      imageId: 'rimg_one',
      plane: face
    });
  });

  it('moves the image to a datum plane or the selected face', async () => {
    const face = {
      type: 'frame' as const,
      frame: {
        origin: { x: 0, y: 0, z: 9 },
        xAxis: { x: 1, y: 0, z: 0 },
        yAxis: { x: 0, y: 1, z: 0 },
        zAxis: { x: 0, y: 0, z: 1 }
      }
    };
    const props = setup({ selectedFacePlane: face });
    fireEvent.change(screen.getByLabelText('Plane'), {
      target: { value: 'selected-face' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalled());
    expect(props.onApply).toHaveBeenCalledWith({
      imageId: 'rimg_one',
      plane: face
    });
  });

  it('scales from two picked points and a known distance', async () => {
    setup();
    fireEvent.click(
      screen.getByRole('button', { name: 'Scale from two points…' })
    );
    const picture = await screen.findByRole<HTMLImageElement>('img');
    // Shown at half size: 200 × 100 CSS px for a 400 × 200 px picture.
    picture.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 100 }) as DOMRect;
    fireEvent.click(picture, { clientX: 10, clientY: 50 });
    fireEvent.click(picture, { clientX: 60, clientY: 50 });
    // 50 CSS px = 100 picture px apart; known to be 20 mm: 80 mm wide.
    expect(screen.getByText(/Picked 100 px apart/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Known distance (mm)'), {
      target: { value: '20' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Scale image' }));
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Width (mm)').value).toBe(
        '80'
      )
    );
    expect(screen.getByText(/Height 40 mm/)).toBeTruthy();
  });

  it('says so when the picture is not on this device, and retries when it is archived', async () => {
    const loadPicture = vi.fn(async (): Promise<Blob | null> => null);
    const props = setup({ loadPicture });
    fireEvent.click(
      screen.getByRole('button', { name: 'Scale from two points…' })
    );
    expect(
      await screen.findByText('The picture is not available on this device.')
    ).toBeTruthy();
    // The owner archives it: the image's artifact id changes under the open
    // scaler, which loads again and clears the error.
    loadPicture.mockResolvedValue(new Blob([new Uint8Array([1])]));
    rerender(
      <ReferenceImageWorkspaceCard
        {...props}
        image={{
          ...props.image,
          artifactId: 'artifact_cloud' as ArtifactId
        }}
      />
    );
    expect(await screen.findByRole('img')).toBeTruthy();
    expect(
      screen.queryByText('The picture is not available on this device.')
    ).toBeNull();
    expect(loadPicture).toHaveBeenCalledTimes(2);
  });

  it('deletes from its menu and closes on Escape', () => {
    const props = setup();
    fireEvent.click(screen.getByLabelText('More actions'));
    fireEvent.click(screen.getByText('Delete image'));
    expect(props.onDelete).toHaveBeenCalled();
    // The first Escape closes the open menu, the next one the card.
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalled();
  });
});
