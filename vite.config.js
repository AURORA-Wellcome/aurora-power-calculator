import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base must match the GitHub Pages project path. It replaces the "homepage" field that
// react-scripts used to read; getting it wrong ships a build whose asset URLs 404 on
// Pages but work fine locally, so it is the one setting to check after any move.
export default defineConfig({
  base: "/aurora-power-calculator/",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: true },
});
