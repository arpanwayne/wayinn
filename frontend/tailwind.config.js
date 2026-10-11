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
        // Clean neutrals: text, borders, page background
        ink: { 50: '#f7f7f8', 100: '#ececee', 200: '#dcdce0', 300: '#b4b4bb', 400: '#85858f', 500: '#62626c', 600: '#47474f', 700: '#33333a', 800: '#222227', 900: '#141417' },
        // Green is kept only for "all good" states (available, paid, done)
        brand: { 50: '#e8f9f2', 100: '#c8f0e0', 200: '#96e0c4', 300: '#5acaa4', 400: '#2ab088', 500: '#0f9471', 600: '#0b7a5d', 700: '#0a654e', 800: '#0b4f3f', 900: '#0a4135' },
        // Signal red: the brand colour — hero panels, primary buttons, active states
        night: { 50: '#fff1f2', 100: '#ffe3e5', 200: '#ffd0d4', 300: '#ffb0b6', 400: '#ff8790', 600: '#ee0f33', 700: '#c40024', 800: '#cf0026', 900: '#de0a2c', 950: '#8f0019' },
        // Yellow: highlights on red, and warnings
        amber: { 50: '#fff8eb', 100: '#feeac6', 200: '#fdd98f', 300: '#fbc457', 400: '#f6a723', 500: '#e48a0c', 600: '#c26908' },
      },
      boxShadow: {
        card: '0 1px 2px rgba(20,20,23,.05), 0 10px 28px -16px rgba(20,20,23,.16)',
        lift: '0 2px 4px rgba(20,20,23,.06), 0 18px 40px -18px rgba(222,10,44,.45)',
      },
    },
  },
  plugins: [],
};
