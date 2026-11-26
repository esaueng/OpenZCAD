export interface SimulatorDevice {
  name: string;
  udid: string;
  state?: string;
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
}

export interface SimulatorInventory {
  devices: Record<string, SimulatorDevice[]>;
}

export const PREFERRED_SIMULATORS: { ipad: string; iphone: string };

export function parseRunnerArguments(argv: readonly string[]): {
  test: boolean;
  iphone: boolean;
};

export function simulatorFamily(
  device: Pick<SimulatorDevice, 'name' | 'deviceTypeIdentifier'>
): 'iphone' | 'ipad' | undefined;

export function chooseSimulator(
  inventory: SimulatorInventory,
  options?: { requested?: string; iphone?: boolean }
): {
  device: SimulatorDevice & { runtime: string; version: number[] };
  family: 'iphone' | 'ipad';
  fellBack: boolean;
};
