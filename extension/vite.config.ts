
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
        background: resolve(__dirname, "src/background.ts"),
      },

      output: {
        entryFileNames: (chunk) => {
          if (
            chunk.name === "content" ||
            chunk.name === "background"
          ) {
            return "[name].js";
          }

          return "assets/[name].js";
        },
      },
    },
  },
});
