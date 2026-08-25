import { defineConfig } from "vite";
import { resolve } from "node:path";

// PASS B of the build: the content script, alone, as a single IIFE.
//
// Why it can't ride along in pass A: Manifest V3 content scripts are not
// modules. Vite's normal multi-entry output is ES modules with shared chunks,
// so a content script built that way ships `import` statements that Chrome
// refuses to execute -- with no error in any console, which is the worst
// possible failure mode. Library mode with a single entry and `formats: ["iife"]`
// guarantees one self-contained file with no imports and no code splitting.
//
// No react() plugin here on purpose: the content script is plain DOM code and
// must stay small and dependency-free. UI belongs in the panel iframe.
export default defineConfig({
  build: {
    outDir: "dist",

    // CRITICAL. Pass A already wrote dist/ and runs first; emptying it here
    // would delete the panel and the service worker and leave a broken folder
    // that still loads, which is confusing to debug.
    emptyOutDir: false,

    // Same reasoning as vite.config.js: never published, so keep dist/
    // readable for the content-script console rather than squeezing bytes.
    minify: false,

    lib: {
      entry: resolve(import.meta.dirname, "src/content/content.js"),
      formats: ["iife"],
      // Required for iife output. Never referenced -- content.js exports
      // nothing, it just runs.
      name: "watchPartyContent",
      // manifest.json's content_scripts entry names exactly this file.
      fileName: () => "content.js",
    },
  },
});
