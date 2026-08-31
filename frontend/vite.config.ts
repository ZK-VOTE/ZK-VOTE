/// <reference types="vitest" />
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file from frontend directory
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    // Cross-origin isolation for in-browser proving (#92).
    //
    // Without COOP+COEP the browser coarsens `performance.now()` but also
    // leaves the page sharing a process with cross-origin frames, so a
    // co-resident context can time the proof. With them the page is
    // `crossOriginIsolated`, which is what makes the timing masking in
    // lib/proofTiming.ts meaningful rather than something an attacker can
    // simply measure around.
    //
    // COEP: require-corp means every cross-origin subresource must opt in via
    // CORP/CORS. Anything third-party the app loads has to send those headers,
    // which is the trade for isolation.
    //
    // These cover the dev server and preview only; production must send the
    // same two headers from whatever fronts the built assets, or the app
    // silently loses isolation. `isCrossOriginIsolated()` surfaces that.
    server: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    preview: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
    worker: {
      format: "es",
    },
    css: {
      postcss: "./postcss.config.js",
    },
    define: {
      // Add Node.js global polyfill for browser
      global: "globalThis",
      // Explicitly inject env vars for import.meta.env
      "import.meta.env.VITE_RELAYER_URL": JSON.stringify(
        env.VITE_RELAYER_URL || "http://localhost:3001",
      ),
    },
    resolve: {
      alias: {
        // Polyfill Node.js built-ins for browser
        buffer: "buffer",
        process: "process/browser",
      },
    },
    optimizeDeps: {
      include: ["@stellar/stellar-sdk", "snarkjs", "circomlibjs"],
      esbuildOptions: {
        // Node.js global to browser globalThis
        define: {
          global: "globalThis",
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            zk: ['snarkjs', 'circomlibjs'],
            react: ['react', 'react-dom'],
            stellar: ['@stellar/stellar-sdk']
          }
        }
      }
    },
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      testTimeout: 15000,
      coverage: {
        reporter: ["text", "json", "html"],
        include: ["src/**/*.{ts,tsx}"],
        exclude: ["src/test/**", "src/**/*.test.{ts,tsx}", "src/contracts/**"],
      },
    },
  };
});
