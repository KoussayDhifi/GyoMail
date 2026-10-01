import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,

    rollupOptions: {
      input: {
        content: resolve(__dirname, "src/content/index.ts"),
        popup: resolve(__dirname, "src/popup/index.html"),
      },

      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "content") {
            return "content.js";
          }

          return "assets/[name].js";
        },
      },
    },
  },
});