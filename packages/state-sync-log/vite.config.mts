import path from "path"
import { defineConfig } from "vite"
import dts from "vite-plugin-dts"

const resolvePath = (str: string) => path.resolve(__dirname, str)

export default defineConfig({
  build: {
    target: "node10",
    lib: {
      entry: resolvePath("./src/index.ts"),
      name: "state-sync-log",
    },
    sourcemap: "inline",
    minify: false,

    rollupOptions: {
      output: [
        {
          format: "esm",
          entryFileNames: "state-sync-log.esm.mjs",
        },
        {
          name: "state-sync-log",
          format: "umd",
        },
      ],
    },
  },
  plugins: [
    dts({
      tsconfigPath: resolvePath("./tsconfig.json"),
      outDir: resolvePath("./dist/types"),
    }),
  ],
})
