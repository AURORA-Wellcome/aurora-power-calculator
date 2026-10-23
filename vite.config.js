import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Internal budget figures live in src/budget.local.js, which is gitignored. When it exists
// (a study-team machine), imports of src/budget.js resolve to it; otherwise, and always in
// CI, they get the public placeholders in src/budget.example.js. AURORA_PUBLIC_BUILD=1
// forces the placeholders, e.g. to check locally what the public site will show.
const budgetLocal = fileURLToPath(
  new URL("./src/budget.local.js", import.meta.url),
);
const useInternalBudget =
  existsSync(budgetLocal) && !process.env.AURORA_PUBLIC_BUILD;

// base must match the GitHub Pages project path. It replaces the "homepage" field that
// react-scripts used to read; getting it wrong ships a build whose asset URLs 404 on
// Pages but work fine locally, so it is the one setting to check after any move.
export default defineConfig({
  base: "/aurora-power-calculator/",
  plugins: [react()],
  resolve: {
    alias: useInternalBudget
      ? [{ find: /^\.\/budget\.js$/, replacement: budgetLocal }]
      : [],
  },
  build: { outDir: "dist", sourcemap: true },
});
