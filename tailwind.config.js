// Pinned to Tailwind 3.x. The app previously loaded cdn.tailwindcss.com, which redirects
// to 3.4.17, so staying on 3 keeps the rendering identical. Tailwind 4 moved the default
// palette to OKLCH and replaced this config format; adopting it would restyle every
// surface and needs to be its own change with its own visual check.
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: { extend: {} },
  plugins: [],
};
