import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  // Tauri: dev server must bind to a fixed port
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // tell vite to ignore watching src-tauri
      ignored: ["**/src-tauri/**"],
    },
  },
  // Web Workers for the reporting engine
  worker: {
    format: "es",
  },
}));
