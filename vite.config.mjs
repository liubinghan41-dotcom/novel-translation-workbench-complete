import { defineConfig } from "vite";

export default defineConfig({
  appType: "spa",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022"
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
