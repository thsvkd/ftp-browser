/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  // 테마는 OS를 따른다(H3). 색은 globals.css의 토큰이 바꾸고, `dark:` 변형도 같은 미디어 쿼리다.
  darkMode: 'media',
  theme: {
    extend: {
      keyframes: {
        drop: { from: { opacity: '0', transform: 'translateY(-4px)' } },
        pop: { from: { opacity: '0', transform: 'translateY(6px) scale(0.985)' } },
        indeterminate: {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(300%)' }
        }
      },
      animation: {
        drop: 'drop 0.14s ease-out',
        pop: 'pop 0.18s cubic-bezier(0.2, 0.9, 0.3, 1)',
        indeterminate: 'indeterminate 1.1s ease-in-out infinite'
      }
    }
  },
  plugins: []
}
