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

const objectTags = (model: string) =>
  [...model.matchAll(/<object\b[^>]*>/g)].map(([tag]) => tag);

describe('labelThreeMfObjects', () => {
  it('names every object and colours it through one core basematerials group', () => {
    const model = labelThreeMfObjects(MODEL, [
      { name: 'Plate', color: '#12abef' },
      { name: 'Upper', color: '#a2a6ae' },
      { name: 'Label', color: '#12ABEF' }
    ]);
    expect(objectTags(model)).toEqual([
      '<object name="Plate" pid="4" pindex="0" id="1" type="model">',
      '<object name="Upper" pid="4" pindex="1" id="2" type="model">',
      '<object name="Label" pid="4" pindex="0" id="3" type="model">'
    ]);
    // One base per distinct colour, whatever its case, and the group is
    // defined before the objects that reference it.
    expect(model).toContain(
      '<resources>\n  <basematerials id="4">\n   <base name="#12ABEF" displaycolor="#12ABEF"/>\n   <base name="#A2A6AE" displaycolor="#A2A6AE"/>\n  </basematerials>'
    );
    expect(model.indexOf('<basematerials')).toBeLessThan(
      model.indexOf('<object')
    );
    // No extension namespace: this is the core format alone.
    expect(model).not.toMatch(/xmlns:|requiredextensions|colorgroup/);
    // The geometry and build are untouched.
    expect(model.replace(/ name="[^"]*" pid="4" pindex="\d"/g, '')).toBe(
      MODEL.replace(
        '<resources>',
        '<resources>\n  <basematerials id="4">\n   <base name="#12ABEF" displaycolor="#12ABEF"/>\n   <base name="#A2A6AE" displaycolor="#A2A6AE"/>\n  </basematerials>'
      )
    );
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
      labelThreeMfObjects(MODEL.replace(/<\/?resources>/g, ''), labels)
    ).toThrow(/without <resources>/);
  });
});
