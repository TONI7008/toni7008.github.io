// toni.dev: theme toggle, scroll reveal, copy-to-clipboard.
// The inline script in <head> sets data-theme before first paint; this file
// only handles changes after load.
(() => {
  const root = document.documentElement;
  // The theme follows the system. The toggle's choice lasts for this tab only
  // (sessionStorage), and a change of the system setting drops it. Every page
  // reads the same key: Minesweeper, the Newton solver, the chat, Sentinel V1.
  const THEME_KEY = 'portfolioTheme';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const darkScheme = matchMedia('(prefers-color-scheme: dark)');
  const toggle = document.querySelector('.theme-toggle');
  const themeMetas = document.querySelectorAll('meta[name="theme-color"]');

  function applyTheme(theme) {
    root.dataset.theme = theme;
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    themeMetas.forEach(meta => meta.setAttribute('content', bg));
    if (toggle) {
      toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    }
  }

  applyTheme(root.dataset.theme === 'dark' ? 'dark' : 'light');

  // Links to the Sentinel V1 tour carry the toggle's choice (?theme=), so the
  // tour opens in it even in a new tab, where sessionStorage starts empty.
  // The tour reads the parameter, keeps it for its tab and drops it from the URL.
  const tourLinks = document.querySelectorAll('a[href*="sentinel_v1/"]');
  let chosen = null;
  try { chosen = sessionStorage.getItem(THEME_KEY); } catch {}

  function syncTourLinks() {
    tourLinks.forEach(link => {
      const url = new URL(link.href);
      if (chosen === 'light' || chosen === 'dark') url.searchParams.set('theme', chosen);
      else url.searchParams.delete('theme');
      link.href = url.href;
    });
  }
  syncTourLinks();

  toggle?.addEventListener('click', () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    chosen = next;
    try { sessionStorage.setItem(THEME_KEY, next); } catch {}
    syncTourLinks();
    if (document.startViewTransition && !reduceMotion.matches) {
      document.startViewTransition(() => applyTheme(next));
    } else {
      applyTheme(next);
    }
  });

  // The system setting changed: drop the toggle's choice and follow it.
  darkScheme.addEventListener('change', event => {
    chosen = null;
    try { sessionStorage.removeItem(THEME_KEY); } catch {}
    syncTourLinks();
    applyTheme(event.matches ? 'dark' : 'light');
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
