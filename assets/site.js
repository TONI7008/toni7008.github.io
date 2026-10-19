// toni.dev: theme toggle, scroll reveal, copy-to-clipboard.
// The inline script in <head> sets data-theme before first paint; this file
// only handles changes after load.
(() => {
  const root = document.documentElement;
  // Same key the Minesweeper and Newton Solver pages read.
  const THEME_KEY = 'portfolioTheme';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const darkScheme = matchMedia('(prefers-color-scheme: dark)');
  const toggle = document.querySelector('.theme-toggle');
  const themeMetas = document.querySelectorAll('meta[name="theme-color"]');

  function storedTheme() {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
  }

  function applyTheme(theme) {
    root.dataset.theme = theme;
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    themeMetas.forEach(meta => meta.setAttribute('content', bg));
    if (toggle) {
      toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }
  }

  applyTheme(root.dataset.theme === 'dark' ? 'dark' : 'light');

  toggle?.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    if (document.startViewTransition && !reduceMotion.matches) {
      document.startViewTransition(() => applyTheme(next));
    } else {
      applyTheme(next);
    }
  });

  // Follow the OS setting until the visitor picks a theme themselves.
  darkScheme.addEventListener('change', event => {
    const saved = storedTheme();
    if (saved !== 'light' && saved !== 'dark') applyTheme(event.matches ? 'dark' : 'light');
  });

  // Scroll reveal, once per element.
  const revealItems = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.dataset.visible = '';
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px' });
    revealItems.forEach(el => observer.observe(el));
  } else {
    revealItems.forEach(el => { el.dataset.visible = ''; });
  }

  // Copy email address. Falls back to opening the mail client.
  document.querySelectorAll('[data-copy]').forEach(button => {
    const label = button.querySelector('.copy-label');
    let resetTimer;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
      } catch {
        location.href = `mailto:${button.dataset.copy}`;
        return;
      }
      button.dataset.copied = '';
      label.textContent = 'Copied';
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        delete button.dataset.copied;
        label.textContent = 'Copy';
      }, 2000);
    });
  });
})();
