import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["./src/testSetup.js"] },
  server: { proxy: { "/api": "http://127.0.0.1:4317" } },
  build: { outDir: "dist", emptyOutDir: true },
});
