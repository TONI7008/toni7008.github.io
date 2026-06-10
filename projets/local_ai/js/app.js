/* ════════════════════════════════════════════════════════════════════════
 * app.js — wires every module to the DOM and boots the app.
 *
 * Load order (see index.html, all `defer`): api → markdown → attachments →
 * sidebar → settings → chat → app. Each earlier module only exposes a
 * class/namespace on `window`; this file is the only place that actually
 * instantiates them and connects their callbacks to one another.
 * ════════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // Theme must be applied before first paint settles — do it first.
  ThemeManager.init();

  const appEl = document.getElementById('app');
  const isMobile = () => window.matchMedia?.('(max-width: 760px)')?.matches;

  /* ── Sidebar collapse / expand ─────────────────────────────────────── */
  const collapseBtn = document.getElementById('collapseSidebarBtn');
  const expandBtn   = document.getElementById('expandSidebarBtn');
  const sidebarEl   = document.getElementById('sidebar');

  const setSidebarCollapsed = (collapsed) => appEl.classList.toggle('sidebar-collapsed', collapsed);
  collapseBtn?.addEventListener('click', () => setSidebarCollapsed(true));
  expandBtn?.addEventListener('click', () => setSidebarCollapsed(false));
  if (isMobile()) setSidebarCollapsed(true);

  // On narrow screens the sidebar overlays the chat (see layout.css's
  // `::before` scrim) — tapping outside it should close it, ChatGPT-style.
  appEl.addEventListener('click', (e) => {
    if (!isMobile() || appEl.classList.contains('sidebar-collapsed')) return;
    if (sidebarEl.contains(e.target) || collapseBtn?.contains(e.target) || expandBtn?.contains(e.target)) return;
    setSidebarCollapsed(true);
  });

  /* ── Core wrapper, fed from whatever was last saved in Settings ───── */
  const api = new ApiWrapper(SettingsStore.load());

  /* ── Session history (sidebar) ─────────────────────────────────────── */
  const sidebar = new Sidebar({
    listEl: document.getElementById('historyList'),
    onSelect: (id) => {
      chat.openSession(id);
      if (isMobile()) setSidebarCollapsed(true);
    },
    onDelete: (id) => chat.handleSessionDeleted(id),
  });

  /* ── Image attachments (paperclip, drag & drop, paste) ──────────────── */
  const attachments = new AttachmentManager({
    previewEl:    document.getElementById('attachmentsPreview'),
    fileInputEl:  document.getElementById('fileInput'),
    attachBtn:    document.getElementById('attachBtn'),
    dropTargetEl: document.querySelector('.composer-box'),
    textareaEl:   document.getElementById('messageInput'),
    onChange:     () => chat.syncSendEnabled(),
  });

  /* ── Conversation controller ────────────────────────────────────────── */
  const chat = new ChatController({
    api,
    attachments,
    sidebar,
    els: {
      appEl,
      chatScroll: document.getElementById('chatScroll'),
      chatColumn: document.getElementById('chatColumn'),
      emptyState: document.getElementById('emptyState'),
      form:       document.getElementById('composerForm'),
      textarea:   document.getElementById('messageInput'),
      sendBtn:    document.getElementById('sendBtn'),
      modelPill:  document.getElementById('modelPill'),
      statusDot:  document.getElementById('statusDot'),
      modelLabel: document.getElementById('modelLabel'),
    },
  });

  /* ── Settings drawer (also owns the theme toggle button) ────────────── */
  new SettingsPanel({
    api,
    appEl,
    onSaved: () => chat.checkConnection(),
  });

  /* ── Sidebar action buttons ─────────────────────────────────────────── */
  document.getElementById('newChatBtn')?.addEventListener('click', () => {
    chat.newChat();
    if (isMobile()) setSidebarCollapsed(true);
  });

  document.getElementById('clearHistoryBtn')?.addEventListener('click', () => {
    if (!SessionStore.list().length) return;
    if (!window.confirm('Delete all saved chats? This cannot be undone.')) return;
    SessionStore.clearAll();
    chat.newChat();
  });

  /* ── Go ───────────────────────────────────────────────────────────────── */
  chat.checkConnection();
})();
