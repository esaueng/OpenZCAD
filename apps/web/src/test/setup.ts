import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { setPersonalInfoVisible } from '../components/PersonalInfo';

afterEach(() => {
  cleanup();
  setPersonalInfoVisible(false);
});
