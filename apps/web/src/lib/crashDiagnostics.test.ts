import { describe, expect, it } from 'vitest';
import { trimComponentStack } from './crashDiagnostics';
import { environmentDescription } from './crashEnvironment';
import { explainReactError, formatCrashReport } from './crashReport';

describe('explainReactError', () => {
  it('reads the production code a render loop throws', () => {
    expect(
      explainReactError(
        'Minified React error #185; visit https://react.dev/errors/185 for the full message'
      )
    ).toBe(
      'React error #185: Maximum update depth exceeded: a component kept setting state from an effect or update, in a loop.'
    );
  });

  it('names an unlisted code and leaves other errors alone', () => {
    expect(explainReactError('Minified React error #999; visit …')).toBe(
      'React error #999.'
    );
    expect(explainReactError('Cannot read properties of undefined')).toBeNull();
    expect(explainReactError(undefined)).toBeNull();
  });
});

describe('trimComponentStack', () => {
  it('keeps the innermost lines without blanks or indentation', () => {
    expect(
      trimComponentStack('\n    at A (a.js:1:1)\n\n    at B (b.js:2:2)\n', 1)
    ).toBe('at A (a.js:1:1)');
    expect(trimComponentStack('\n  \n')).toBeUndefined();
    expect(trimComponentStack(null)).toBeUndefined();
  });
});

describe('environmentDescription', () => {
  it('says the browser, the window and the device', () => {
    expect(
      environmentDescription({
        navigator: {
          userAgent: 'Mozilla/5.0 Firefox/140.0',
          hardwareConcurrency: 10,
          language: 'en-US',
          deviceMemory: 8
        },
        innerWidth: 1990,
        innerHeight: 1480,
        devicePixelRatio: 2
      })
    ).toEqual([
      'Browser Mozilla/5.0 Firefox/140.0',
      'Window 1990×1480 @2x',
      'Device 10 cores, 8 GB memory'
    ]);
  });

  it('leaves out what the browser does not say', () => {
    expect(environmentDescription({})).toEqual([]);
  });
});

describe('formatCrashReport', () => {
  it('puts the message, its reading, the build, the browser and both stacks in one paste', () => {
    const report = formatCrashReport(
      {
        label: '3D viewer',
        message: 'Minified React error #185',
        componentStack:
          '\n    at Loop (index.js:1:2)\n    at ViewerShell (index.js:3:4)\n',
        errorStack: 'Error: Minified React error #185\n    at x (react.js:9:9)',
        at: Date.UTC(2026, 10, 16, 9, 10)
      },
      ['Browser Firefox/140']
    );
    const lines = report.split('\n');
    expect(lines[0]).toBe('3D viewer crashed: Minified React error #185');
    expect(lines[1]).toMatch(/^React error #185: Maximum update depth/);
    expect(lines[2]).toBe('Time 2026-11-16T09:10:00.000Z');
    expect(lines[3]).toMatch(/^OpenZCAD .+ · Remus /);
    expect(lines[4]).toBe('Browser Firefox/140');
    expect(report).toContain(
      'Component stack:\nat Loop (index.js:1:2)\nat ViewerShell (index.js:3:4)'
    );
    expect(report).toContain('Error stack:\nError: Minified React error #185');
  });

  it('omits the sections it has nothing for', () => {
    const report = formatCrashReport(
      { label: 'Inspector', message: 'boom', at: 0 },
      []
    );
    expect(report).not.toContain('React error');
    expect(report).not.toContain('Component stack:');
    expect(report).not.toContain('Error stack:');
  });
});
