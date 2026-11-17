import { describe, expect, it } from 'vitest';
import { commandFactories, importMeshLabel } from './index';

describe('mesh import undo labels (#1637)', () => {
  it('names the format the file was imported from', () => {
    expect(importMeshLabel('scan.stl')).toBe('Import STL mesh');
    expect(importMeshLabel('QA-mobile-plate.3mf')).toBe('Import 3MF mesh');
    expect(importMeshLabel('part.OBJ')).toBe('Import OBJ mesh');
    expect(importMeshLabel('cloud.ply')).toBe('Import PLY mesh');
    expect(importMeshLabel('model.glb')).toBe('Import glTF mesh');
    expect(importMeshLabel('no-extension')).toBe('Import mesh');
    expect(importMeshLabel('archive.zip')).toBe('Import mesh');
  });

  it('labels the import command with it', () => {
    const command = commandFactories.importMesh({
      name: 'Plate',
      artifactId: 'artifact_plate',
      sourceName: 'plate.3mf',
      triangleCount: 1,
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2]
    });
    expect(command.label).toBe('Import 3MF mesh');
  });
});
