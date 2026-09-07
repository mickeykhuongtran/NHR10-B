/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './index.tsx',
    './App.tsx',
    './components/**/*.{ts,tsx}',
    './hooks/**/*.{ts,tsx}',
    './services/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'Inter', 'sans-serif'],
        mono: ['SFMono-Regular', 'SF Mono', 'Roboto Mono', 'Roboto', 'monospace'],
      },
      colors: {
        ui: {
          bg: '#F9FAFB',
          card: '#FFFFFF',
          cardHover: '#F3F4F6',
          border: '#E2E8F0',
          text: '#0F172A',
          subtext: '#64748B',
        },
      },
      boxShadow: {
        soft: '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03)',
        'soft-lg': '0 10px 15px -3px rgba(0, 0, 0, 0.05), 0 4px 6px -2px rgba(0, 0, 0, 0.025)',
      },
    },
  },
  plugins: [],
};
