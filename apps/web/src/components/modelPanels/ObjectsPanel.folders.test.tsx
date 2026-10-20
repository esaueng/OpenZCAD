import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import { COLLAPSED_FOLDERS_STORAGE_KEY } from '../../lib/objectFolderView';
import {
  ObjectsPanel,
  useObjectsView,
  type ObjectFolderActions
} from './ObjectsPanel';

type PanelProps = Omit<ComponentProps<typeof ObjectsPanel>, 'view'>;

/** Three boxes in a real document; the panel's actions run real commands. */
function model() {
  const manager = new CommandManager(
    createProjectDocument('Folders', toUserId('user_objects_folders'))
  );
  for (const name of ['Base', 'Lug', 'Pin']) {
    manager.execute(
      commandFactories.addPrimitive({
        name,
        bodyName: name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
  }
  return manager;
}

function representations(document: ProjectDocument) {
  return Object.fromEntries(
    Object.values(document.nodes).flatMap((node) =>
      node.kind === 'body'
        ? [
            [
              node.bodyId,
              {
                bodyId: node.bodyId,
                name: node.name,
                consumed: false
              } as unknown as BodyRepresentation
            ]
          ]
        : []
    )
  );
}

function Harness({
  manager,
  selected = [],
  spy
}: {
  manager: CommandManager;
  selected?: BodyId[];
  spy: Partial<ObjectFolderActions>;
}) {
  const [document, setDocument] = useState(manager.document);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const run = (command: Parameters<CommandManager['execute']>[0]) => {
    manager.execute(command);
    setDocument(manager.document);
    return true;
  };
  const actions: ObjectFolderActions = {
    create: (input) => run(commandFactories.createObjectFolder(input)),
    rename: (folderId, name) =>
      void run(commandFactories.renameObjectFolder({ folderId, name })),
    remove: (folderId) =>
      void run(commandFactories.deleteObjectFolder({ folderId })),
    move: (input) => void run(commandFactories.moveToObjectFolder(input)),
    setBodiesHidden(bodyIds, hide) {
      spy.setBodiesHidden?.(bodyIds, hide);
      setHidden((current) => {
        const next = new Set(current);
        for (const id of bodyIds) {
          if (hide) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    selectBodies: (bodyIds, additive) => spy.selectBodies?.(bodyIds, additive)
  };
  const props: PanelProps = {
    features: listFeaturesInOrder(document),
    representations: representations(document),
    document,
    parameterValues: {},
    selectedFeatureNodeId: null,
    selectedSketchProfileId: null,
    selectedBodyIds: selected,
    hiddenBodyIds: hidden,
    hiddenSketchIds: new Set(),
    onSelectFeature: vi.fn(),
    onSelectBody: vi.fn(),
    onToggleBodyVisibility: vi.fn(),
    onToggleSketchVisibility: vi.fn(),
    objectFolderActions: actions
  };
  return <ObjectsPanel {...props} view={useObjectsView()} />;
}

const list = () => within(screen.getByRole('list', { name: 'Objects' }));
const rowNames = () =>
  list()
    .getAllByRole('listitem')
    .map((row) => row.querySelector('.feature-name')?.textContent ?? '');

/** HTML5 drag and drop as the browser fires it, with one shared transfer. */
function dragOnto(source: HTMLElement, target: HTMLElement) {
  const data = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: 'all',
    dropEffect: 'none',
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? ''
  };
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
  fireEvent.dragEnd(source, { dataTransfer });
}

afterEach(() => {
  localStorage.clear();
});

describe('Objects folders (U06, ZC-128)', () => {
  it('makes a folder of the selected bodies and names it in place', async () => {
    const user = userEvent.setup();
    const manager = model();
    const [, lug, pin] = manager.document.bodyOrder;
    render(<Harness manager={manager} selected={[lug!, pin!]} spy={{}} />);

    await user.click(screen.getByRole('button', { name: 'New folder' }));
    const field = list().getByRole('textbox', {
      name: 'Rename folder Folder 1'
    });
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, 'Hardware{Enter}');
    expect(rowNames()).toEqual(['Hardware', 'Lug', 'Pin', 'Base']);
    expect(manager.document.objectFolders?.folders).toEqual([
      expect.objectContaining({ name: 'Hardware', parentId: null })
    ]);
    // Two steps: the folder with its bodies, then its name.
    expect(manager.document.editHistory?.entries).toHaveLength(5);
  });

  it('files every selected body, including those a search hides', async () => {
    const user = userEvent.setup();
    const manager = model();
    const [, lug, pin] = manager.document.bodyOrder as BodyId[];
    render(<Harness manager={manager} selected={[lug!, pin!]} spy={{}} />);
    await user.type(
      screen.getByRole('searchbox', { name: 'Find an object by name' }),
      'lug'
    );
    expect(rowNames()).toEqual(['Lug']);

    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.keyboard('{Enter}');
    // Both selected bodies went in, and the cleared search shows them there.
    expect(rowNames()).toEqual(['Folder 1', 'Lug', 'Pin', 'Base']);
    expect(manager.document.objectFolders?.placements).toEqual({
      [lug!]: expect.any(String),
      [pin!]: expect.any(String)
    });
  });

  it('drags the whole selection, including bodies a search hides', () => {
    const manager = model();
    const [, lug, pin] = manager.document.bodyOrder as BodyId[];
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'Frame',
        parentId: null
      })
    );
    render(<Harness manager={manager} selected={[lug!, pin!]} spy={{}} />);
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Find an object by name' }),
      { target: { value: 'lug' } }
    );
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'all',
      dropEffect: 'none',
      setData: (type: string, value: string) => void data.set(type, value),
      getData: (type: string) => data.get(type) ?? ''
    };
    const lugRow = list()
      .getByRole('button', { name: /^Lug/ })
      .closest('[role="listitem"]') as HTMLElement;
    fireEvent.dragStart(lugRow, { dataTransfer });
    fireEvent.change(
      screen.getByRole('searchbox', { name: 'Find an object by name' }),
      { target: { value: '' } }
    );
    const frame = list()
      .getByRole('button', { name: /^Frame/ })
      .closest('[role="listitem"]') as HTMLElement;
    fireEvent.dragOver(frame, { dataTransfer });
    fireEvent.drop(frame, { dataTransfer });
    expect(manager.document.objectFolders?.placements).toEqual({
      [lug!]: 'folder_a',
      [pin!]: 'folder_a'
    });
  });

  it('collapses a folder, remembered on this device per project', async () => {
    const user = userEvent.setup();
    const manager = model();
    const [base] = manager.document.bodyOrder;
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'Frame',
        parentId: null,
        bodyIds: [base!]
      })
    );
    const { unmount } = render(<Harness manager={manager} spy={{}} />);
    const toggle = list().getByRole('button', {
      name: 'Collapse folder Frame'
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(rowNames()).toEqual(['Frame', 'Lug', 'Pin']);
    expect(
      JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_STORAGE_KEY)!)
    ).toEqual({ [manager.document.projectId]: ['folder_a'] });
    unmount();

    render(<Harness manager={manager} spy={{}} />);
    expect(rowNames()).toEqual(['Frame', 'Lug', 'Pin']);
    await user.click(
      list().getByRole('button', { name: 'Expand folder Frame' })
    );
    expect(rowNames()).toEqual(['Frame', 'Base', 'Lug', 'Pin']);
  });

  it('drags bodies into a folder and out to the top level', () => {
    const manager = model();
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'Frame',
        parentId: null
      })
    );
    render(<Harness manager={manager} spy={{}} />);
    const rowOf = (name: string) =>
      list()
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .closest('[role="listitem"]') as HTMLElement;

    dragOnto(rowOf('Lug'), rowOf('Frame'));
    expect(rowNames()).toEqual(['Frame', 'Lug', 'Base', 'Pin']);
    expect(list().queryByText('Move to top level')).toBeNull();

    // The top-level target appears only while something is dragged.
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'all',
      dropEffect: 'none',
      setData: (type: string, value: string) => void data.set(type, value),
      getData: (type: string) => data.get(type) ?? ''
    };
    fireEvent.dragStart(rowOf('Lug'), { dataTransfer });
    const root = list().getByText('Move to top level');
    fireEvent.dragOver(root, { dataTransfer });
    expect(root).toHaveClass('drop-target');
    fireEvent.drop(root, { dataTransfer });
    expect(rowNames()).toEqual(['Frame', 'Base', 'Lug', 'Pin']);
    // One undoable move each way.
    manager.undo();
    expect(manager.document.objectFolders?.placements).toEqual({
      [manager.document.bodyOrder[1]!]: 'folder_a'
    });
  });

  it('refuses to drop a folder into a folder inside it', () => {
    const manager = model();
    for (const [folderId, parentId] of [
      ['folder_a', null],
      ['folder_b', 'folder_a']
    ] as const) {
      manager.execute(
        commandFactories.createObjectFolder({
          folderId,
          name: folderId === 'folder_a' ? 'Outer' : 'Inner',
          parentId
        })
      );
    }
    render(<Harness manager={manager} spy={{}} />);
    const outer = list()
      .getByRole('button', { name: /^Outer/ })
      .closest('[role="listitem"]') as HTMLElement;
    const inner = list()
      .getByRole('button', { name: /^Inner/ })
      .closest('[role="listitem"]') as HTMLElement;
    const version = manager.document.version;
    dragOnto(outer, inner);
    expect(manager.document.version).toBe(version);
    expect(inner).not.toHaveClass('drop-target');
  });

  it("hides, shows and selects a folder's bodies, nested folders included", async () => {
    const user = userEvent.setup();
    const manager = model();
    const [base, lug] = manager.document.bodyOrder;
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'Frame',
        parentId: null,
        bodyIds: [base!]
      })
    );
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_b',
        name: 'Lugs',
        parentId: 'folder_a',
        bodyIds: [lug!]
      })
    );
    const setBodiesHidden = vi.fn();
    const selectBodies = vi.fn();
    render(
      <Harness manager={manager} spy={{ setBodiesHidden, selectBodies }} />
    );
    await user.click(list().getByRole('button', { name: 'Hide folder Frame' }));
    expect(setBodiesHidden).toHaveBeenLastCalledWith([base, lug], true);
    // Every body inside hidden: the folder reads hidden too.
    expect(
      list().getByRole('button', { name: 'Show folder Frame' })
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      list().getByRole('button', { name: 'Show folder Lugs' })
    ).toBeInTheDocument();
    await user.click(list().getByRole('button', { name: 'Show folder Lugs' }));
    expect(setBodiesHidden).toHaveBeenLastCalledWith([lug], false);

    await user.click(list().getByRole('button', { name: /^Frame/ }));
    expect(selectBodies).toHaveBeenLastCalledWith([base, lug], false);
  });

  it('renames with F2 and deletes a folder without losing what it held', async () => {
    const user = userEvent.setup();
    const manager = model();
    const [base] = manager.document.bodyOrder;
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'Frame',
        parentId: null,
        bodyIds: [base!]
      })
    );
    render(<Harness manager={manager} spy={{}} />);
    list()
      .getByRole('button', { name: /^Frame/ })
      .focus();
    await user.keyboard('{F2}');
    await user.type(
      list().getByRole('textbox', { name: 'Rename folder Frame' }),
      ' parts{Enter}'
    );
    expect(rowNames()[0]).toBe('Frame parts');
    await act(async () => {
      await user.click(
        list().getByRole('button', { name: 'Delete folder Frame parts' })
      );
    });
    expect(rowNames()).toEqual(['Base', 'Lug', 'Pin']);
    expect(manager.document.bodyOrder).toHaveLength(3);
  });

  it('lists matches flat while searching, and the tree comes back when cleared', async () => {
    const user = userEvent.setup();
    const manager = model();
    const [base] = manager.document.bodyOrder;
    manager.execute(
      commandFactories.createObjectFolder({
        folderId: 'folder_a',
        name: 'Frame',
        parentId: null,
        bodyIds: [base!]
      })
    );
    render(<Harness manager={manager} spy={{}} />);
    const before = rowNames();
    const search = screen.getByRole('searchbox', {
      name: 'Find an object by name'
    });
    await user.type(search, 'ba');
    expect(rowNames()).toEqual(['Base']);
    await user.clear(search);
    expect(rowNames()).toEqual(before);
  });
});
