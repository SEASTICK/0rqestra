/* global document, window */
// Runs in <head>, before the first paint. Applies the saved theme so the window never shows the
// wrong colors for a moment, and makes sure the start screen cannot cover the window for long if
// the interface fails to load (then the window shows whatever state it is in).
(function () {
  var theme = 'light';
  try {
    var saved = localStorage.getItem('orqestra-theme');
    if (saved === 'light' || saved === 'dark' || saved === 'system') theme = saved;
  } catch {
    // Storage unavailable: light theme.
  }
  document.documentElement.setAttribute('data-theme', theme);
  window.setTimeout(function () {
    var boot = document.getElementById('boot');
    if (boot && !boot.dataset.leaving) {
      boot.dataset.leaving = '1';
      boot.classList.add('leaving');
      window.setTimeout(function () { boot.remove(); }, 450);
    }
  }, 6000);
})();
