import { defineConfig } from "vite";

/** Penpot executes `code` as a classic plugin script, not as an ES module. */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: "src/plugin.ts",
      formats: ["iife"],
      name: "UltimateHtmlToPenpot",
      fileName: () => "plugin.js"
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true
      }
    }
  }
});
