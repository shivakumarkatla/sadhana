/** @type {import('tailwindcss').Config} */
// Colour and font values live in src/index.css (:root). This file only exposes them as utilities.
const token = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: Object.fromEntries([
        'primary', 'primary-deep', 'primary-soft', 'primary-tint', 'primary-tint-strong',
        'secondary', 'secondary-ink', 'tertiary', 'tertiary-tint',
        'ink', 'ink-soft', 'muted', 'faint',
        'danger', 'danger-tint', 'danger-soft',
        'page', 'page-deep', 'surface', 'tint', 'tint-strong', 'line', 'line-soft', 'line-strong',
      ].map((name) => [name, token(name)])),
      fontFamily: {
        heading: ['var(--font-heading)'],
        body: ['var(--font-body)'],
      },
    },
  },
  plugins: [],
};
