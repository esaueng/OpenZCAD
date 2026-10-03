import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { setPersonalInfoVisible } from '../components/PersonalInfoToggle';

afterEach(() => {
  cleanup();
  setPersonalInfoVisible(false);
});
