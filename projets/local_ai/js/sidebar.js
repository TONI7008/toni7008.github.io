/* ════════════════════════════════════════════════════════════════════════
 * SessionStore + Sidebar — the web counterpart of the .cbor history files
 * and ChatHistoryItem/listSessions() in the native app.
 *
 * Each session is its own localStorage entry (mirrors "one file per
 * session"), plus a small index for fast listing/sorting/preview — same
 * separation of concerns as CWrapper::listSessions() vs. loadSessionFromPath().
 * Empty sessions are never persisted, exactly like CWrapper's destructor guard.
 * ════════════════════════════════════════════════════════════════════════ */

const SessionStore = (() => {
  const INDEX_KEY = 'chatgui.sessions.index.v1';
  const sessionKey = (id) => `chatgui.session.${id}`;

  function loadIndex() {
    try { return JSON.parse(localStorage.getItem(INDEX_KEY)) || []; }
    catch { return []; }
  }
  function saveIndex(index) {
    try { localStorage.setItem(INDEX_KEY, JSON.stringify(index)); } catch { /* storage full/unavailable */ }
  }

  function makeId() {
    return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /** n=0 → all sessions, newest first (mirrors CWrapper::listSessions). */
  function list(n = 0) {
    const sorted = loadIndex().slice().sort((a, b) => b.createdAt - a.createdAt);
    return n > 0 ? sorted.slice(0, n) : sorted;
  }

  function load(id) {
    try { return JSON.parse(localStorage.getItem(sessionKey(id))); }
    catch { return null; }
  }

  function save(session) {
    if (!session.messages.length) return; // no ghost entries for empty chats
    try { localStorage.setItem(sessionKey(session.id), JSON.stringify(session)); }
    catch { return; }

    const index = loadIndex().filter((e) => e.id !== session.id);
    index.push({ id: session.id, createdAt: session.createdAt, preview: session.preview });
    saveIndex(index);
  }

  function remove(id) {
    localStorage.removeItem(sessionKey(id));
    saveIndex(loadIndex().filter((e) => e.id !== id));
  }

  function clearAll() {
    for (const entry of loadIndex()) localStorage.removeItem(sessionKey(entry.id));
    saveIndex([]);
  }

  return { makeId, list, load, save, remove, clearAll };
})();

/* ── Timestamp formatting — "06 Jun 14:35", same shape as the Qt build ──── */
function formatSessionTimestamp(ms) {
  const d = new Date(ms);
  const day   = String(d.getDate()).padStart(2, '0');
  const month = d.toLocaleString(undefined, { month: 'short' });
  const hh    = String(d.getHours()).padStart(2, '0');
  const mm    = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${hh}:${mm}`;
}

/* ── Sidebar — renders the session list & owns selection/deletion UI ───── */
class Sidebar {
  static PREVIEW_MAX_LEN = 42;

  constructor({ listEl, onSelect, onDelete }) {
    this.listEl   = listEl;
    this.onSelect = onSelect ?? (() => {});
    this.onDelete = onDelete ?? (() => {});
    this.activeId = null;
  }

  refresh(activeId = this.activeId) {
    this.activeId = activeId;
    this.listEl.innerHTML = '';

    const sessions = SessionStore.list(50);
    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = 'No saved chats yet — send a message to start one.';
      this.listEl.append(empty);
      return;
    }
    sessions.forEach((info, i) => this._renderItem(info, i));
  }

  setActive(id) {
    this.activeId = id;
    this.listEl.querySelectorAll('.history-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === id);
    });
  }

  _renderItem(info, index) {
    let preview = info.preview || '(empty chat)';
    if (preview.length > Sidebar.PREVIEW_MAX_LEN) {
      preview = preview.slice(0, Sidebar.PREVIEW_MAX_LEN - 1) + '…';
    }

    const item = document.createElement('div');
    item.className = 'history-item' + (info.id === this.activeId ? ' active' : '');
    item.dataset.id = info.id;
    item.style.animationDelay = `${Math.min(index, 10) * 28}ms`;
    item.title = info.preview || '';

    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = formatSessionTimestamp(info.createdAt);

    const previewEl = document.createElement('span');
    previewEl.className = 'preview';
    previewEl.textContent = preview;

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'delete-btn';
    deleteBtn.title = 'Delete this chat';
    deleteBtn.innerHTML =
      '<svg viewBox="0 0 24 24" class="icon"><polyline points="3 6 5 6 21 6"/>' +
      '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      SessionStore.remove(info.id);
      this.onDelete(info.id);
      this.refresh(this.activeId === info.id ? null : this.activeId);
    });

    item.append(when, previewEl, deleteBtn);
    item.addEventListener('click', () => this.onSelect(info.id));
    this.listEl.append(item);
  }
}

window.SessionStore = SessionStore;
window.Sidebar = Sidebar;
