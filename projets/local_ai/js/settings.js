/* ════════════════════════════════════════════════════════════════════════
 * ThemeManager — dark/light switcheroo, persisted, with the highlight.js
 * stylesheet swapped to match (the one piece of UI that can't be themed
 * with custom properties alone, since it ships as a full CSS file).
 *
 * SettingsStore — persists the connection form (server, key, model, system
 * prompt) the same way SessionStore persists chat history.
 *
 * SettingsPanel — the slide-in drawer: open/close, theme toggle, "fetch
 * models" probe, save → reconfigure the live ApiWrapper and reconnect.
 * ════════════════════════════════════════════════════════════════════════ */

const ThemeManager = (() => {
  const STORAGE_KEY = 'chatgui.theme';
  const root = document.documentElement;
  let current = 'dark';

  function applyHljsStylesheet() {
    const link = document.getElementById('hljs-theme');
    if (!link) return;
    const raw = getComputedStyle(root).getPropertyValue('--hljs-theme-href').trim();
    const href = raw.replace(/^["']|["']$/g, '');
    if (href && link.getAttribute('href') !== href) link.setAttribute('href', href);
  }

  function syncToggleUi() {
    const label = document.getElementById('themeToggleLabel');
    const btn = document.getElementById('themeToggleBtn');
    if (label) label.textContent = current === 'dark' ? 'Light mode' : 'Dark mode';
    if (btn) btn.title = current === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  }

  function set(theme, { persist = true } = {}) {
    current = theme === 'light' ? 'light' : 'dark';
    root.setAttribute('data-theme', current);
    applyHljsStylesheet();
    syncToggleUi();
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, current); } catch { /* storage unavailable */ }
    }
  }

  function init() {
    let stored = null;
    try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* storage unavailable */ }

    if (stored === 'light' || stored === 'dark') {
      set(stored, { persist: false });
    } else {
      const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)')?.matches;
      set(prefersLight ? 'light' : 'dark', { persist: false });
    }
  }

  function toggle() { set(current === 'dark' ? 'light' : 'dark'); }

  return { init, toggle, set, get: () => current };
})();

/* ── SettingsStore — connection + model + prompt, persisted ────────────── */
const SettingsStore = (() => {
  const KEY = 'chatgui.settings.v1';

  function defaults() {
    return {
      serverIp: '127.0.0.1',
      serverPort: 1234,
      useHttps: false,
      apiKey: '',
      modelName: '',
      systemPrompt: 'You are a helpful, concise assistant.',
    };
  }

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY));
      return raw && typeof raw === 'object' ? { ...defaults(), ...raw } : defaults();
    } catch { return defaults(); }
  }

  function save(settings) {
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage unavailable */ }
  }

  return { defaults, load, save };
})();

/* ── SettingsPanel — the drawer's behaviour ─────────────────────────────── */
class SettingsPanel {
  constructor({ api, appEl, onSaved } = {}) {
    this.api    = api;
    this.appEl  = appEl ?? document.getElementById('app');
    this.onSaved = onSaved ?? (() => {});
    this.modelDetails = new Map(); // id -> /api/v0/models entry (state, type, …)

    this.els = {
      panel:          document.getElementById('settingsPanel'),
      overlay:        document.getElementById('overlay'),
      openBtn:        document.getElementById('settingsBtn'),
      closeBtn:       document.getElementById('closeSettingsBtn'),
      cancelBtn:      document.getElementById('cancelSettingsBtn'),
      form:           document.getElementById('settingsForm'),
      serverIp:       document.getElementById('serverIp'),
      serverPort:     document.getElementById('serverPort'),
      useHttps:       document.getElementById('useHttps'),
      apiKey:         document.getElementById('apiKey'),
      modelName:      document.getElementById('modelName'),
      modelSelect:    document.getElementById('modelSelect'),
      refreshBtn:     document.getElementById('refreshModelsBtn'),
      modelStatus:     document.getElementById('modelStatus'),
      modelStatusDot:  document.getElementById('modelStatusDot'),
      modelStatusText: document.getElementById('modelStatusText'),
      loadModelBtn:    document.getElementById('loadModelBtn'),
      systemPrompt:   document.getElementById('systemPrompt'),
      status:         document.getElementById('settingsStatus'),
      themeToggleBtn: document.getElementById('themeToggleBtn'),
    };

    this._wireOpenClose();
    this._wireThemeToggle();
    this._wireModelFetch();
    this._wireForm();

    this.populate(SettingsStore.load());
  }

  /* ── Drawer visibility ─────────────────────────────────────────────── */

  open() {
    this.appEl.classList.add('settings-open');
    this.els.panel.setAttribute('aria-hidden', 'false');
    this._setStatus('');
    this.els.serverIp?.focus({ preventScroll: true });
  }

  close() {
    this.appEl.classList.remove('settings-open');
    this.els.panel.setAttribute('aria-hidden', 'true');
  }

  _wireOpenClose() {
    this.els.openBtn?.addEventListener('click', () => this.open());
    this.els.closeBtn?.addEventListener('click', () => this.close());
    this.els.cancelBtn?.addEventListener('click', () => this.close());
    this.els.overlay?.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.appEl.classList.contains('settings-open')) this.close();
    });
  }

  _wireThemeToggle() {
    this.els.themeToggleBtn?.addEventListener('click', () => ThemeManager.toggle());
  }

  /* ── Form population / reading ─────────────────────────────────────── */

  populate(settings) {
    this.els.serverIp.value     = settings.serverIp;
    this.els.serverPort.value   = settings.serverPort || '';
    this.els.useHttps.checked   = !!settings.useHttps;
    this.els.apiKey.value       = settings.apiKey;
    this.els.modelName.value    = settings.modelName;
    this.els.systemPrompt.value = settings.systemPrompt;
  }

  _readForm() {
    return {
      serverIp:     this.els.serverIp.value.trim(),
      serverPort:   Number(this.els.serverPort.value) || 0,
      useHttps:     this.els.useHttps.checked,
      apiKey:       this.els.apiKey.value.trim(),
      modelName:    this.els.modelName.value.trim(),
      systemPrompt: this.els.systemPrompt.value,
    };
  }

  _setStatus(message, kind) {
    const status = this.els.status;
    if (!status) return;
    status.textContent = message;
    status.classList.remove('ok', 'fail');
    if (kind) status.classList.add(kind);
  }

  /* ── "Fetch models" probe — uses the form's current (unsaved) values ─ */

  _wireModelFetch() {
    this.els.refreshBtn?.addEventListener('click', async () => {
      const probe = new ApiWrapper(this._readForm());
      this.els.refreshBtn.disabled = true;
      this.els.refreshBtn.textContent = 'Fetching…';
      this._setStatus('Contacting server…');

      try {
        const [models, details] = await Promise.all([probe.listModels(), probe.listModelsDetailed()]);
        this.modelDetails = details;
        this._populateModelSelect(models);
        this._refreshModelStatus();
        this._setStatus(
          models.length ? `Found ${models.length} model${models.length === 1 ? '' : 's'}.`
                        : 'Server reachable, but it reported no models.',
          models.length ? 'ok' : 'fail',
        );
      } catch (err) {
        this.els.modelSelect.hidden = true;
        this.modelDetails = new Map();
        this._refreshModelStatus();
        this._setStatus(err.message || 'Could not reach the server.', 'fail');
      } finally {
        this.els.refreshBtn.disabled = false;
        this.els.refreshBtn.textContent = 'Fetch models';
      }
    });

    this.els.modelSelect?.addEventListener('change', () => {
      if (this.els.modelSelect.value) this.els.modelName.value = this.els.modelSelect.value;
      this._refreshModelStatus();
    });
    this.els.modelName?.addEventListener('input', () => this._refreshModelStatus());
    this._wireModelLoad();
  }

  /* ── "Loaded?" badge — only meaningful for LM Studio's /api/v0 extension;
   *  silently hides itself for any other OpenAI-compatible server ───────── */

  _refreshModelStatus() {
    const { modelStatus, modelStatusDot, modelStatusText, loadModelBtn } = this.els;
    if (!modelStatus) return;

    const id = this.els.modelName.value.trim();
    const info = id ? this.modelDetails.get(id) : null;
    if (!info) { modelStatus.hidden = true; return; }

    const loaded = info.state === 'loaded';
    modelStatus.hidden = false;
    modelStatusDot.className = `status-dot ${loaded ? 'online' : 'offline'}`;
    modelStatusText.textContent = loaded ? 'Loaded on server' : 'Not loaded on server';
    loadModelBtn.hidden = loaded;
    loadModelBtn.disabled = false;
    loadModelBtn.textContent = 'Load model';
  }

  _wireModelLoad() {
    this.els.loadModelBtn?.addEventListener('click', async () => {
      const id = this.els.modelName.value.trim();
      const info = this.modelDetails.get(id);
      if (!id || !info) return;

      const probe = new ApiWrapper(this._readForm());
      this.els.loadModelBtn.disabled = true;
      this.els.loadModelBtn.textContent = 'Loading…';
      this.els.modelStatusDot.className = 'status-dot pending';
      this.els.modelStatusText.textContent = 'Loading model — this can take a while for large models…';

      try {
        await probe.loadModel(id, info.type);
        const details = await probe.listModelsDetailed();
        if (details.size) this.modelDetails = details;
        this._refreshModelStatus();
        if (this.modelDetails.get(id)?.state !== 'loaded') {
          this._setStatus(`Sent a load request for "${id}" — recheck status if it's still showing as not loaded.`, 'ok');
        }
      } catch (err) {
        this._refreshModelStatus();
        this._setStatus(err.message || 'Could not load the model.', 'fail');
      }
    });
  }

  _populateModelSelect(models) {
    const select = this.els.modelSelect;
    select.innerHTML = '';
    if (!models.length) { select.hidden = true; return; }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `${models.length} model${models.length === 1 ? '' : 's'} found — choose one…`;
    select.append(placeholder);

    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.id;
      if (model.id === this.els.modelName.value) opt.selected = true;
      select.append(opt);
    }
    select.hidden = false;
  }

  /* ── Save → reconfigure the live wrapper, persist, reconnect ───────── */

  _wireForm() {
    this.els.form?.addEventListener('submit', (e) => {
      e.preventDefault();
      const settings = this._readForm();

      if (!settings.serverIp) {
        this._setStatus('Server address is required.', 'fail');
        this.els.serverIp.focus();
        return;
      }

      SettingsStore.save(settings);
      this.api.configure(settings);
      this.close();
      this.onSaved(settings);
    });
  }
}

window.ThemeManager   = ThemeManager;
window.SettingsStore  = SettingsStore;
window.SettingsPanel  = SettingsPanel;
