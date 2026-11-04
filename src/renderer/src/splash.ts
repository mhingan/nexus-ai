const minimumVisibleMs = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 600 : 5300

// The splash lives in index.html so it paints on the very first frame and animates on the
// compositor while JavaScript loads. React calls this once the workspace has rendered.
export function dismissSplash() {
  const splash = document.getElementById('splash')
  if (!splash || splash.dataset.leaving) return
  splash.dataset.leaving = 'true'
  window.setTimeout(() => requestAnimationFrame(() => {
    splash.classList.add('sp-exit')
    document.body.classList.add('app-ready')
    window.setTimeout(() => { splash.remove(); void import('./monaco') }, 750)
  }), Math.max(0, minimumVisibleMs - performance.now()))
}
