/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Figtree Variable"', 'system-ui', 'sans-serif'],
        display: ['"Bricolage Grotesque Variable"', '"Figtree Variable"', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Indigo-tinted neutrals: text, borders, page background
        ink: { 50: '#f5f5fb', 100: '#e9eaf4', 200: '#d3d5e6', 300: '#a9acc8', 400: '#7d81a3', 500: '#5c6083', 600: '#444767', 700: '#313450', 800: '#21233d', 900: '#15172c' },
        // Jade: primary actions and "all good"
        brand: { 50: '#e8f9f2', 100: '#c8f0e0', 200: '#96e0c4', 300: '#5acaa4', 400: '#2ab088', 500: '#0f9471', 600: '#0b7a5d', 700: '#0a654e', 800: '#0b4f3f', 900: '#0a4135' },
        // Midnight: sidebar and the hero panels
        night: { 100: '#e4e5f7', 200: '#bfc2e6', 300: '#9498cc', 400: '#6a6fae', 700: '#2a2e5e', 800: '#1f2249', 900: '#171a3a', 950: '#101229' },
        // Marigold: the one warm accent (matches the logo)
        amber: { 50: '#fff8eb', 100: '#feeac6', 200: '#fdd98f', 300: '#fbc457', 400: '#f6a723', 500: '#e48a0c', 600: '#c26908' },
      },
      boxShadow: {
        card: '0 1px 2px rgba(23,26,58,.05), 0 10px 28px -16px rgba(23,26,58,.18)',
        lift: '0 2px 4px rgba(23,26,58,.06), 0 18px 40px -18px rgba(23,26,58,.28)',
      },
    },
  },
  plugins: [],
};
