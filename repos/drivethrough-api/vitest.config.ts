// Vitest config — `@/*` alias mirrors tsconfig so tests can import route handlers the same
// way Next resolves them (needed by the E2E contract test). Defaults otherwise.

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    testTimeout: 30_000, // the E2E suite (E2E_DRIVE=1) talks to real Drive + Neon
    include: ['tests/**/*.test.ts'],
  },
});
