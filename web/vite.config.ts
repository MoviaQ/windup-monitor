import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// S1: dev i preview nasłuchują na 0.0.0.0 (podgląd w LAN/kontenerze).
// allowedHosts celowo wąskie — tylko lokalne nazwy; wdrożenie produkcyjne
// serwuje gotowy build przez Core, nie przez Vite.
const localHosts = ["localhost", "127.0.0.1", "::1"];

// Cel proxy /api: domyślnie lokalny Core; gdy port zajęty przez inną usługę
// albo Core działa gdzie indziej, nadpisz env, np.
// API_PROXY_TARGET=http://127.0.0.1:18081 npm run dev
const apiProxyTarget = process.env.API_PROXY_TARGET || "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: localHosts,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    allowedHosts: localHosts,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
