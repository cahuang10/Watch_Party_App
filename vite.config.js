import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// PASS A of a two-pass build. Produces the ES-module half of the extension:
// the panel page and the service worker, both of which are allowed to be
// modules (the worker declares `"type": "module"` in the manifest).
//
// The content script CANNOT be an ES module -- that's a hard Manifest V3 rule,
// and a bundle with `import` in it is silently refused by Chrome rather than
// erroring. So it gets its own IIFE pass in vite.config.content.js, run second.
//
// Full command: `npm run build`. Order matters -- this pass empties dist/.
export default defineConfig({
  plugins: [react()],

  build: {
    outDir: "dist",
    emptyOutDir: true,

    // This extension is never published (CLAUDE.md: loads from disk, secrets
    // are already readable in the bundle) so there's no real reason to
    // minify -- and a real reason not to: the "three consoles" workflow this
    // project leans on means errors regularly get read straight out of
    // dist/*.js, and Terser's single-line output makes a stack trace useless.
    // Bundling/tree-shaking still happen; only the byte-squeezing pass is off.
    minify: false,

    rollupOptions: {
      // Listed explicitly, which is also what stops the old web-app entry
      // (index.html -> src/main.jsx) from being built. Those files still exist;
      // Session 3E adapts App.jsx and CameraBox.jsx into the panel.
      input: {
        panel: resolve(import.meta.dirname, "panel.html"),
        background: resolve(import.meta.dirname, "src/background/background.js"),
      },

      output: {
        // manifest.json names "background.js" at the extension root. Vite's
        // default hashed filenames would break that reference on every build,
        // so entry points get stable names. Only entries need this -- shared
        // chunks and assets are referenced by generated code, so they keep
        // their cache-busting hashes.
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});

// Note: `public/` is copied to dist/ verbatim by Vite, which is how
// manifest.json reaches the extension root without a plugin.
