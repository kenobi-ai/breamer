import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    container: "src/container.ts"
  },
  clean: true,
  dts: false,
  format: ["esm"],
  sourcemap: true,
  splitting: false,
  target: "node22"
});
