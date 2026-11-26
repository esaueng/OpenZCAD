import { describe, expect, it } from 'vitest';
import {
  chooseSimulator,
  parseRunnerArguments,
  simulatorFamily
} from '../scripts/run-ipad-simulator.mjs';

const ios = (major: number, minor: number) =>
  `com.apple.CoreSimulator.SimRuntime.iOS-${major}-${minor}`;
const device = (
  name: string,
  udid: string,
  type: string,
  state = 'Shutdown'
) => ({
  name,
  udid,
  state,
  isAvailable: true,
  deviceTypeIdentifier: `com.apple.CoreSimulator.SimDeviceType.${type}`
});

// Mirrors Xcode 27.2: no iPad Pro 11-inch (M4) and two runtimes.
const inventory = {
  devices: {
    [ios(26, 5)]: [
      device('iPhone 17', 'old-iphone', 'iPhone-17'),
      device('iPad Pro 11-inch (M5)', 'old-pro', 'iPad-Pro-11-inch-M5-12GB')
    ],
    [ios(27, 2)]: [
      device('iPad (A16)', 'a16', 'iPad-A16'),
      device('iPad Air 11-inch (M4)', 'air', 'iPad-Air-11-inch-M4'),
      device('iPad Pro 11-inch (M5)', 'pro', 'iPad-Pro-11-inch-M5-12GB'),
      device('iPhone 17', 'iphone', 'iPhone-17'),
      device('iPhone Air', 'air-phone', 'iPhone-Air', 'Booted'),
      device('Team QA phone', 'qa', 'iPhone-18-Pro', 'Booted')
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-26-0': [
      device('Apple Watch', 'watch', 'Apple-Watch-Series-11-46mm')
    ]
  }
};

describe('iPad and iPhone simulator selection', () => {
  it('accepts --test and --iphone only', () => {
    expect(parseRunnerArguments([])).toEqual({ test: false, iphone: false });
    expect(parseRunnerArguments(['--iphone', '--test'])).toEqual({
      test: true,
      iphone: true
    });
    expect(() => parseRunnerArguments(['--ipad'])).toThrow(/Usage/);
  });

  it('classifies simulators by device type before name', () => {
    expect(
      simulatorFamily({
        name: 'Team QA phone',
        deviceTypeIdentifier:
          'com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro'
      })
    ).toBe('iphone');
    expect(simulatorFamily({ name: 'iPad mini (A17 Pro)' })).toBe('ipad');
    expect(simulatorFamily({ name: 'Apple Watch' })).toBeUndefined();
  });

  it('falls back from the missing default iPad to the newest iPad Pro 11-inch', () => {
    expect(chooseSimulator(inventory)).toMatchObject({
      device: { udid: 'pro' },
      family: 'ipad',
      fellBack: true
    });
  });

  it('targets the newest iPhone 17 with --iphone', () => {
    expect(chooseSimulator(inventory, { iphone: true })).toMatchObject({
      device: { udid: 'iphone' },
      family: 'iphone',
      fellBack: false
    });
  });

  it('runs on an iPhone named in OPENZCAD_IPAD_SIMULATOR, by name or UDID', () => {
    expect(
      chooseSimulator(inventory, { requested: 'iPhone Air' })
    ).toMatchObject({
      device: { udid: 'air-phone' },
      family: 'iphone',
      fellBack: false
    });
    expect(chooseSimulator(inventory, { requested: 'old-pro' })).toMatchObject({
      device: { udid: 'old-pro', name: 'iPad Pro 11-inch (M5)' },
      family: 'ipad'
    });
  });

  it('keeps a missing named simulator within its family', () => {
    expect(
      chooseSimulator(inventory, { requested: 'iPhone 17 Pro' })
    ).toMatchObject({
      device: { udid: 'iphone' },
      family: 'iphone',
      fellBack: true
    });
    expect(
      chooseSimulator(inventory, { requested: 'iPad mini (A17 Pro)' })
    ).toMatchObject({
      device: { udid: 'pro' },
      family: 'ipad',
      fellBack: true
    });
  });

  it('refuses --iphone with an iPad name and reports an empty family', () => {
    expect(() =>
      chooseSimulator(inventory, {
        requested: 'iPad Air 11-inch (M4)',
        iphone: true
      })
    ).toThrow(/--iphone/);
    expect(() =>
      chooseSimulator({ devices: { [ios(27, 2)]: [] } }, { iphone: true })
    ).toThrow(/No iPhone simulator/);
  });
});
