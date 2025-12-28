/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#0b0f14",
        panel: "#121821",
        line: "#1e2a3a",
        text: "#eaf2ff",
        muted: "#8ea0b3",
        good: "#2ecc71",
        soon: "#f1c40f",
        bad:  "#ff5c5c",
        accent:"#66b2ff",
        mos: {
          blue: "#1976D2",
          "blue-light": "#42A5F5",
          "blue-dark": "#0D47A1",
          silver: "#B0BEC5",
          "silver-dark": "#78909C",
          navy: "#0D1B2A",
          "navy-light": "#1B2838",
        }
      },
      borderRadius: { xl: "14px" },
    },
  },
  plugins: [],
};
