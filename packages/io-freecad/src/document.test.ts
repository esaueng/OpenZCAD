import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { readFreecadShapes } from './document';
import { FREECAD_IMPORT_LIMITS } from './limits';
import { extractFreecadEntry, inspectFreecadArchive } from './zip';

const shape = (file: string) =>
  `<Property name="Shape" type="Part::PropertyPartShape"><Part file="${file}"/></Property>`;
const group = (name: string) =>
  `<Property name="Group"><LinkList><Link value="${name}"/></LinkList></Property>`;
const visible = (value: boolean) =>
  `<Property name="Visibility"><Bool value="${value}"/></Property>`;
function fixture(
  objects: { name: string; type: string; props?: string }[],
  entries: Record<string, string> = {},
  gui?: string
) {
  const document = `<Document SchemaVersion="4"><Objects>${objects.map((o) => `<Object name="${o.name}" type="${o.type}"/>`).join('')}</Objects><ObjectData>${objects.map((o) => `<Object name="${o.name}"><Properties>${o.props ?? ''}</Properties></Object>`).join('')}</ObjectData></Document>`;
  return zipSync(
    Object.fromEntries(
      Object.entries({
        'Document.xml': document,
        ...entries,
        ...(gui ? { 'GuiDocument.xml': gui } : {})
      }).map(([name, text]) => [name, strToU8(text)])
    )
  );
}
describe('FreeCAD saved-body selection', () => {
  it('imports the final Body, excluding its visible history and sketches', () => {
    const bytes = fixture(
      [
        {
          name: 'Body',
          type: 'PartDesign::Body',
          props: shape('Body.brp') + group('Pad')
        },
        {
          name: 'Pad',
          type: 'PartDesign::Pad',
          props: shape('Pad.brp') + visible(true)
        },
        {
          name: 'Sketch',
          type: 'Sketcher::SketchObject',
          props: shape('Sketch.brp')
        }
      ],
      {
        'Body.brp': 'finished geometry',
        'Pad.brp': 'old geometry',
        'Sketch.brp': 'wire'
      }
    );
    const saved = readFreecadShapes(bytes);
    expect(saved.map((s) => s.objectName)).toEqual(['Body']);
    expect(new TextDecoder().decode(saved[0]!.brep)).toBe('finished geometry');
  });
  it('uses GUI visibility for older documents and excludes hidden Part containers', () => {
    const bytes = fixture(
      [
        {
          name: 'Part',
          type: 'App::Part',
          props: group('Body') + visible(false)
        },
        { name: 'Body', type: 'PartDesign::Body', props: shape('a.brp') },
        {
          name: 'Other',
          type: 'Part::Feature',
          props: shape('b.brp') + visible(true)
        },
        { name: 'Shown', type: 'Part::Feature', props: shape('c.brp') }
      ],
      { 'a.brp': 'a', 'b.brp': 'b', 'c.brp': 'c' },
      '<GuiDocument><ViewProviderData><ViewProvider name="Other"><Properties>' +
        visible(false) +
        '</Properties></ViewProvider></ViewProviderData></GuiDocument>'
    );
    expect(readFreecadShapes(bytes).map((s) => s.objectName)).toEqual([
      'Shown'
    ]);
  });
  it('applies parent placements but does not double-apply the saved object placement', () => {
    const placement =
      '<Property name="Placement"><PropertyPlacement Px="10" Py="20" Pz="30" Q0="0" Q1="0" Q2="0" Q3="1"/></Property>';
    const saved = readFreecadShapes(
      fixture(
        [
          { name: 'Part', type: 'App::Part', props: group('Body') + placement },
          {
            name: 'Body',
            type: 'PartDesign::Body',
            props: shape('a.brp') + placement
          }
        ],
        { 'a.brp': 'body' }
      )
    );
    expect(saved[0]!.parentPlacements).toEqual([
      [1, 0, 0, 10, 0, 1, 0, 20, 0, 0, 1, 30]
    ]);
  });
  it.each([
    [shape('missing.brp'), {}, /missing shape/],
    [shape('empty.brp'), { 'empty.brp': '' }, /empty saved shape/],
    [shape(''), {}, /unsaved or unsupported/]
  ])(
    'refuses absent geometry without substituting an earlier stage',
    (props, entries, error) => {
      expect(() =>
        readFreecadShapes(
          fixture([{ name: 'Body', type: 'PartDesign::Body', props }], entries)
        )
      ).toThrow(error);
    }
  );
  it('rejects visible links and invalid or cyclic container placements', () => {
    expect(() =>
      readFreecadShapes(fixture([{ name: 'Link', type: 'App::Link' }]))
    ).toThrow(/linked instances/);
    expect(() =>
      readFreecadShapes(
        fixture(
          [
            {
              name: 'Part',
              type: 'App::Part',
              props: group('Body') + '<Property name="Placement"/>'
            },
            { name: 'Body', type: 'PartDesign::Body', props: shape('b.brp') }
          ],
          { 'b.brp': 'body' }
        )
      )
    ).toThrow(/placement/);
    expect(() =>
      readFreecadShapes(
        fixture(
          [
            { name: 'Part', type: 'App::Part', props: group('Nested') },
            {
              name: 'Nested',
              type: 'App::Part',
              props: group('Part') + group('Body')
            },
            { name: 'Body', type: 'PartDesign::Body', props: shape('b.brp') }
          ],
          { 'b.brp': 'body' }
        )
      )
    ).toThrow();
  });
});
describe('FreeCAD archive boundary', () => {
  const valid = () =>
    fixture(
      [{ name: 'Body', type: 'PartDesign::Body', props: shape('a.brp') }],
      { 'a.brp': 'body' }
    );
  it('refuses oversized archives, declared output and unsafe paths before decompression', () => {
    expect(() =>
      inspectFreecadArchive(valid(), {
        ...FREECAD_IMPORT_LIMITS,
        maxArchiveBytes: 1
      })
    ).toThrow(/limit/);
    expect(() =>
      inspectFreecadArchive(valid(), {
        ...FREECAD_IMPORT_LIMITS,
        maxDeclaredOutputBytes: 1
      })
    ).toThrow(/limit/);
    expect(() =>
      inspectFreecadArchive(
        fixture([], { '../escape': 'x' }),
        FREECAD_IMPORT_LIMITS
      )
    ).toThrow(/unsafe/);
  });
  it('rejects duplicate names, encrypted entries, truncated ZIP and local/central mismatches', () => {
    const duplicate = zipSync({
      'Document.xml': strToU8('xml'),
      'aaaaaaaa.xml': strToU8('xml')
    });
    const text = new TextDecoder('latin1').decode(duplicate);
    // Replace both local and central filenames while leaving record sizes intact.
    for (let i = 0; i < text.length; i++)
      if (text.slice(i, i + 12) === 'aaaaaaaa.xml')
        duplicate.set(strToU8('Document.xml'), i);
    expect(() =>
      inspectFreecadArchive(duplicate, FREECAD_IMPORT_LIMITS)
    ).toThrow(/duplicate/);
    const encrypted = valid();
    const view = new DataView(encrypted.buffer);
    for (let i = 0; i < encrypted.length - 46; i++)
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint16(i + 8, 1, true);
        break;
      }
    expect(() =>
      inspectFreecadArchive(encrypted, FREECAD_IMPORT_LIMITS)
    ).toThrow(/Encrypted/);
    expect(() =>
      inspectFreecadArchive(valid().slice(0, 10), FREECAD_IMPORT_LIMITS)
    ).toThrow(/truncated/);
    const mismatch = valid();
    mismatch[30] = 88;
    expect(() =>
      inspectFreecadArchive(mismatch, FREECAD_IMPORT_LIMITS)
    ).toThrow(/does not match/);
  });
  it('rejects doctypes, malformed XML and unsupported schemas', () => {
    for (const xml of [
      '<!DOCTYPE Document><Document/>',
      '<Document>',
      '<Document SchemaVersion="999"/>'
    ]) {
      expect(() =>
        readFreecadShapes(zipSync({ 'Document.xml': strToU8(xml) }))
      ).toThrow();
    }
  });
  it('checks selected-entry CRCs instead of accepting corrupted bytes', () => {
    const bytes = zipSync({ 'Document.xml': strToU8('payload') }, { level: 0 });
    const view = new DataView(bytes.buffer);
    const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
    bytes[start] = 120;
    expect(() => extractFreecadEntry(bytes, FREECAD_IMPORT_LIMITS)).toThrow(
      /checksum/
    );
  });
  it('bounds streamed output even when both size declarations lie', () => {
    const bytes = zipSync({ 'Document.xml': strToU8('x'.repeat(10000)) });
    const view = new DataView(bytes.buffer);
    view.setUint32(22, 1, true);
    for (let i = 0; i < bytes.length - 46; i++)
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 1, true);
        break;
      }
    expect(() => extractFreecadEntry(bytes, FREECAD_IMPORT_LIMITS)).toThrow(
      /expanded beyond/
    );
  });
});
