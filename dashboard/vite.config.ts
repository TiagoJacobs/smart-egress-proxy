import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dashboard is served as a static SPA from the same origin as the JSON API
// in production (Express serves dashboard/dist). `base: "./"` makes the built
// asset URLs relative so they work regardless of mount path.
//
// In dev (`npm run dev`), Vite serves the SPA and proxies `/api/*` to the
// running Node server on the dashboard port (default 443).
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:443",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
