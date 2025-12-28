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
          blue: "#3C81C3",
          "blue-light": "#5A9AD4",
          "blue-dark": "#2A6BA8",
          silver: "#B0BEC5",
          "silver-dark": "#78909C",
          navy: "#0D1B2A",
          "navy-light": "#1B2838",
          gray: "#606364",
          "gray-light": "#787A7B",
          "gray-dark": "#484A4B",
        }
      },
      borderRadius: { xl: "14px" },
    },
  },
  plugins: [],
};
