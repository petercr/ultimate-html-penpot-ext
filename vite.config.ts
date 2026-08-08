import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    cors: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: "index.html",
        plugin: "src/plugin.ts"
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "plugin" ? "plugin.js" : "assets/[name]-[hash].js")
      }
    }
  },
  test: {
    environment: "jsdom"
  }
});
