import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"] ,
  theme: {
    extend: {
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"]
      },
      colors: {
        ink: "#1b1b1f",
        sand: "#f7f4ee",
        marine: "#251B9F",
        citrus: "#FF491B"
      },
      boxShadow: {
        glow: "0 18px 45px -24px rgba(37, 27, 159, 0.45)"
      }
    }
  },
  plugins: []
};

export default config;
