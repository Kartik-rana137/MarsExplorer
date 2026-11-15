import { defineConfig, loadEnv } from "vite";

// During development the frontend runs on its own port and forwards API calls to the Python backend.
// Set VITE_API_BASE (in the environment or a .env file) to point at a backend somewhere else.
export default defineConfig(({ mode }) => {
  const backend = loadEnv(mode, ".", "VITE_").VITE_API_BASE || "http://localhost:8001";
  return {
    server: {
      port: 5173,
      proxy: {
        "/api": backend,
        "/overlays": backend,
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
