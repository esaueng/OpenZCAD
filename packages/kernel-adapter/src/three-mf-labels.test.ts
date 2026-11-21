import { describe, expect, it } from 'vitest';
import { labelThreeMfObjects } from './three-mf-labels';

const MODEL = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter">',
  ' <resources>',
  '  <object id="1" type="model">',
  '   <mesh><vertices/><triangles/></mesh>',
  '  </object>',
  '  <object id="2" type="model">',
  '   <mesh><vertices/><triangles/></mesh>',
  '  </object>',
  '  <object id="3" type="model">',
  '   <mesh><vertices/><triangles/></mesh>',
  '  </object>',
  ' </resources>',
  ' <build><item objectid="1"/><item objectid="2"/><item objectid="3"/></build>',
  '</model>'
].join('\n');

const GROUPS = [
  '',
  '  <basematerials id="4">',
  '   <base name="#12ABEF" displaycolor="#12ABEF"/>',
  '   <base name="#A2A6AE" displaycolor="#A2A6AE"/>',
  '  </basematerials>',
  '  <m:colorgroup id="5">',
  '   <m:color color="#12ABEF"/>',
  '  </m:colorgroup>',
  '  <m:colorgroup id="6">',
  '   <m:color color="#A2A6AE"/>',
  '  </m:colorgroup>'
].join('\n');

const objectTags = (model: string) =>
  [...model.matchAll(/<object\b[^>]*>/g)].map(([tag]) => tag);

describe('labelThreeMfObjects', () => {
  it('names every object and colours it through basematerials and one m:colorgroup per colour', () => {
    const model = labelThreeMfObjects(MODEL, [
      { name: 'Plate', color: '#12abef' },
      { name: 'Upper', color: '#a2a6ae' },
      { name: 'Label', color: '#12ABEF' }
    ]);
    // Objects select their colour's own group, at its only entry.
    expect(objectTags(model)).toEqual([
      '<object name="Plate" pid="5" pindex="0" id="1" type="model">',
      '<object name="Upper" pid="6" pindex="0" id="2" type="model">',
      '<object name="Label" pid="5" pindex="0" id="3" type="model">'
    ]);
    // One base and one colour group per distinct colour, whatever its
    // case, all defined before the objects that reference them.
    expect(model).toContain(GROUPS);
    expect(model.indexOf('<m:colorgroup')).toBeLessThan(
      model.indexOf('<object')
    );
    // The extension is declared under `m` and not required.
    expect(model).toContain(
      '<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">'
    );
    expect(model).not.toMatch(/requiredextensions/);
    // The geometry and build are untouched.
    expect(
      model
        .replace(/ name="[^"]*" pid="\d+" pindex="0"/g, '')
        .replace(/ xmlns:m="[^"]*"/, '')
    ).toBe(MODEL.replace('<resources>', `<resources>${GROUPS}`));
  });

  it('escapes names for an XML attribute and writes no name for an unnamed body', () => {
    const model = labelThreeMfObjects(MODEL, [
      { name: `Owner's "A&B" <1>`, color: '#000000' },
      { name: '', color: '#000000' },
      {
        name: 'Cost $& more\ttab\u0001\ufffe\uffff\ud800 \u{1f527}',
        color: '#ffffff'
      }
    ]);
    const [first, second, third] = objectTags(model);
    expect(first).toContain(
      'name="Owner&apos;s &quot;A&amp;B&quot; &lt;1&gt;"'
    );
    expect(second).not.toContain('name=');
    // `$&` stays literal instead of being read as a replacement pattern, and
    // characters XML 1.0 cannot carry (a control, U+FFFE, U+FFFF, a lone
    // surrogate) are left out while an astral character is kept.
    expect(third).toContain('name="Cost $&amp; more&#9;tab \u{1f527}"');
  });

  it('refuses a part whose objects do not match the labels one to one', () => {
    expect(() =>
      labelThreeMfObjects(MODEL, [
        { name: 'Plate', color: '#12abef' },
        { name: 'Upper', color: '#12abef' }
      ])
    ).toThrow(/wrote 3 objects for 2 solids/);
  });

  it('refuses a colour that is not #rrggbb', () => {
    expect(() =>
      labelThreeMfObjects(MODEL, [
        { name: 'A', color: 'red' },
        { name: 'B', color: '#000000' },
        { name: 'C', color: '#000000' }
      ])
    ).toThrow(/"red" is not #rrggbb/);
  });

  it('refuses a part that already carries materials or has no resources', () => {
    const labels = [1, 2, 3].map(() => ({ name: 'A', color: '#000000' }));
    expect(() =>
      labelThreeMfObjects(
        MODEL.replace('<object id="1"', '<object id="1" pid="9"'),
        labels
      )
    ).toThrow(/already assigned materials/);
    expect(() =>
      labelThreeMfObjects(
        MODEL.replace('<resources>', '<resources><basematerials id="9"/>'),
        labels
      )
    ).toThrow(/already assigned materials/);
    expect(() =>
      labelThreeMfObjects(
        MODEL.replace('<resources>', '<resources><m:colorgroup id="9"/>'),
        labels
      )
    ).toThrow(/already assigned materials/);
    expect(() =>
      labelThreeMfObjects(
        MODEL.replace('unit="millimeter"', 'unit="millimeter" xmlns:m="urn:x"'),
        labels
      )
    ).toThrow(/already declared the m: namespace/);
    expect(() =>
      labelThreeMfObjects(MODEL.replace(/<\/?resources>/g, ''), labels)
    ).toThrow(/without <resources>/);
  });
});
