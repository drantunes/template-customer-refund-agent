import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    // The Mastra API server runs on :4111 (`npm run dev` in the project root).
    // Proxying avoids dealing with CORS during local development.
    proxy: {
      "/support": "http://127.0.0.1:4111",
    },
  },
});
