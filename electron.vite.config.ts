import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const shared = resolve(__dirname, 'src/shared');

/**
 * Production CSP: no inline anything, no remote anything. Cached artwork is served from the
 * app-owned onelaunch-art: scheme (src/main/services/artwork-url.ts), the only non-self image source.
 */
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: onelaunch-art:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Dev-only relaxations: Vite HMR needs a websocket, and the React Fast Refresh preamble plus
 * Vite's style injection are inline. Never shipped.
 */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: onelaunch-art:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'one-launch:csp',
    transformIndexHtml: {
      order: 'pre',
      handler(_html, ctx) {
        return [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: ctx.server ? DEV_CSP : PROD_CSP },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      // Not minified: it never leaves the machine, and readable stack traces in onelaunch.log matter more than a few kB.
      minify: false,
      // boot.ts switches Node's compile cache on and then imports index.ts, which must therefore stay its own chunk.
      rollupOptions: { input: { boot: resolve(__dirname, 'src/main/boot.ts'), index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        // sandbox: true renderers require a CommonJS preload.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss(), cspPlugin()],
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    build: {
      // electron-vite leaves bundles unminified by default; minified JS parses faster at cold start.
      minify: 'esbuild',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
