/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: { sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'] },
      colors: {
        ink: { 50: '#f4f6f6', 100: '#e3e8e8', 200: '#c6d0d0', 300: '#9aabab', 400: '#6b8282', 500: '#4d6464', 600: '#3a4f4f', 700: '#2c3d3d', 800: '#1d2a2a', 900: '#111a1a' },
        brand: { 50: '#eefaf6', 100: '#d4f2e8', 200: '#a9e4d1', 300: '#72cfb4', 400: '#3fb495', 500: '#1f977a', 600: '#147a63', 700: '#126151', 800: '#124e42', 900: '#114137' },
        amber: { 50: '#fff8eb', 100: '#feeac6', 400: '#f6a723', 500: '#e48a0c', 600: '#c26908' },
      },
    },
  },
  plugins: [],
};
