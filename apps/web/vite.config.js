import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const apiEnvDirectory = fileURLToPath(new URL('../api/', import.meta.url));

export default defineConfig(({ mode }) => {
  const apiEnvironment = loadEnv(mode, apiEnvDirectory, '');
  const apiPort = process.env.PORT ?? apiEnvironment.PORT ?? '3001';

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': `http://localhost:${apiPort}`,
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test-setup.js',
      clearMocks: true,
    },
  };
});
