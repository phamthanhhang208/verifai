import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          bg: "#0A0A0B",
          card: "#141517",
          panel: "#1A1C20",
        },
      },
    },
  },
  plugins: [],
};
export default config;
