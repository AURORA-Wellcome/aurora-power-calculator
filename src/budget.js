// Budget figures for the Aim 2.2 cost and budget-fit estimates. This re-exports the
// public placeholders. vite.config.js redirects imports of this file to
// src/budget.local.js, the internal figures, when that file exists and
// AURORA_PUBLIC_BUILD is not set. Node scripts always get the placeholders.
export * from "./budget.example.js";
