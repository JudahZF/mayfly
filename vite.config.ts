import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Keep the Host header: the API guard checks that Origin and Host match.
const server = `http://127.0.0.1:${process.env.MAYFLY_PORT ?? 4747}`;

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/web/routes",
      generatedRouteTree: "./src/web/routeTree.gen.ts",
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    proxy: {
      "/api": { target: server },
      "/mcp": { target: server },
    },
  },
  build: { outDir: "dist/web", emptyOutDir: true },
});
