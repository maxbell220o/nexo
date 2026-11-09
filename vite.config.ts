import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

export default defineConfig({
  base: "/nexo/",
  build: {
    outDir: "docs",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@supabase/")) return "supabase";
        },
      },
    },
  },
  plugins: [
    react(),
    {
      name: "github-pages-spa-fallback",
      writeBundle() {
        copyFileSync(resolve("docs/index.html"), resolve("docs/404.html"));
      },
    },
  ],
});
