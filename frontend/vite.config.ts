import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// `vite build --mode demo` (see .env.demo) builds the static GitHub Pages demo: the console
// reads the responses recorded by scripts/record_demo.py from public/demo/ instead of the API.
// The normal build has no public dir, so the recordings never ship with the real service.
export default defineConfig(({ mode }) => {
  const demo = loadEnv(mode, process.cwd(), "VITE_").VITE_DEMO === "1";
  return {
    base: demo ? "/proofbi/" : "/",
    publicDir: demo ? "public" : false,
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { "/api": "http://127.0.0.1:8000" },
    },
  };
});
