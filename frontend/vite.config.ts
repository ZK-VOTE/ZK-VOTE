/// <reference types="vitest" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file from frontend directory
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    css: {
      postcss: './postcss.config.js',
    },
    define: {
      // Add Node.js global polyfill for browser
      global: 'globalThis',
      // Explicitly inject env vars for import.meta.env
      'import.meta.env.VITE_RELAYER_URL': JSON.stringify(env.VITE_RELAYER_URL || 'http://localhost:3001'),
    },
    resolve: {
      alias: {
        // Polyfill Node.js built-ins for browser
        buffer: 'buffer',
        process: 'process/browser',
      },
    },
    optimizeDeps: {
      include: [
        '@stellar/stellar-sdk',
        'snarkjs',
        'circomlibjs',
      ],
      esbuildOptions: {
        // Node.js global to browser globalThis
        define: {
          global: 'globalThis',
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      coverage: {
        reporter: ['text', 'json', 'html'],
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/test/**', 'src/**/*.test.{ts,tsx}', 'src/contracts/**'],
      },
    },
  }
})
