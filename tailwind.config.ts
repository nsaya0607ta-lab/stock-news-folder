import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 業務利用を想定した白・グレー・青の基調色
        surface: {
          DEFAULT: '#ffffff',
          sub: '#f4f6f8',
          raised: '#ffffff',
        },
        ink: {
          DEFAULT: '#1b2430',
          sub: '#5a6572',
          faint: '#8b949e',
        },
        line: {
          DEFAULT: '#dfe3e8',
          strong: '#c6ccd4',
        },
        brand: {
          50: '#eef4fd',
          100: '#d8e6fa',
          200: '#b0cbf4',
          300: '#7fabe9',
          400: '#4b87da',
          500: '#2767c4',
          600: '#1d51a3',
          700: '#183f80',
          800: '#132f60',
          900: '#0e2245',
        },
        folder: {
          DEFAULT: '#e8a917',
          dark: '#c98f0d',
          light: '#f6cf5f',
        },
        pdf: {
          DEFAULT: '#c8342b',
          dark: '#9d2820',
        },
      },
      borderRadius: {
        // 角は丸めすぎない
        card: '6px',
        sheet: '12px',
      },
      fontSize: {
        // 文字を小さくしすぎない（最小 13px）
        xs: ['13px', { lineHeight: '18px' }],
        sm: ['14px', { lineHeight: '20px' }],
        base: ['15px', { lineHeight: '22px' }],
        lg: ['17px', { lineHeight: '24px' }],
        xl: ['19px', { lineHeight: '26px' }],
        '2xl': ['22px', { lineHeight: '30px' }],
      },
      spacing: {
        tap: '44px',
      },
      boxShadow: {
        sheet: '0 -8px 28px rgba(15, 23, 32, 0.18)',
        pop: '0 8px 24px rgba(15, 23, 32, 0.16)',
        fab: '0 6px 18px rgba(29, 81, 163, 0.35)',
      },
    },
  },
  plugins: [],
};

export default config;
