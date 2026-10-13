import { configDefaults, defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const apiEnvDirectory = fileURLToPath(new URL('../api/', import.meta.url));

export default defineConfig(({ mode }) => {
  const apiEnvironment = loadEnv(mode, apiEnvDirectory, '');
  const apiPort = process.env.PORT ?? apiEnvironment.PORT ?? '3001';
  const apiTarget = process.env.TEAMVAULT_API_ORIGIN ?? `http://localhost:${apiPort}`;

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target: apiTarget, changeOrigin: false, ws: true },
        '/socket.io': { target: apiTarget, changeOrigin: false, ws: true },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test-setup.js',
      clearMocks: true,
      exclude: [...configDefaults.exclude, 'e2e/**'],
    },
  };
});
