/* ════════════════════════════════════════════════════════════════════════
 * AttachmentManager — image uploads for vision-capable models.
 *
 * Wires the paperclip button, drag & drop onto the composer, and clipboard
 * paste, converts each image to a base64 data: URL (the format the OpenAI
 * vision payload — and api.js's `image_url` content blocks — expect), and
 * renders removable thumbnail previews above the input box.
 * ════════════════════════════════════════════════════════════════════════ */

class AttachmentManager {
  static MAX_ITEMS = 6;
  static MAX_BYTES = 8 * 1024 * 1024; // 8 MB — generous for a local vision model

  constructor({ previewEl, fileInputEl, attachBtn, dropTargetEl, textareaEl, onChange }) {
    this.items = [];
    this.previewEl   = previewEl;
    this.fileInputEl = fileInputEl;
    this.onChange    = onChange ?? (() => {});

    attachBtn?.addEventListener('click', () => fileInputEl.click());

    fileInputEl.addEventListener('change', () => {
      this.addFiles(fileInputEl.files);
      fileInputEl.value = ''; // allow re-selecting the same file later
    });

    if (dropTargetEl) this._wireDragAndDrop(dropTargetEl);
    if (textareaEl)   this._wirePaste(textareaEl);
  }

  get count() { return this.items.length; }

  /* ── Ingest ────────────────────────────────────────────────────────── */

  async addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/'));
    for (const file of files) {
      if (this.items.length >= AttachmentManager.MAX_ITEMS) break;
      if (file.size > AttachmentManager.MAX_BYTES) continue;

      try {
        const dataUrl = await this._readAsDataUrl(file);
        const item = { id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file, dataUrl };
        this.items.push(item);
        this._renderThumb(item);
      } catch { /* unreadable file — skip silently */ }
    }
    this.onChange(this);
  }

  remove(id) {
    this.items = this.items.filter((i) => i.id !== id);
    document.getElementById(id)?.remove();
    this.onChange(this);
  }

  clear() {
    this.items = [];
    this.previewEl.innerHTML = '';
    this.onChange(this);
  }

  /** Shape consumed by ApiWrapper#chat / #buildMessages. */
  toApiAttachments() {
    return this.items.map((i) => ({ dataUrl: i.dataUrl }));
  }

  /** Shape persisted into session history / replayed into a message bubble. */
  toMessageAttachments() {
    return this.items.map((i) => ({ dataUrl: i.dataUrl, name: i.file.name }));
  }

  /* ── Rendering ─────────────────────────────────────────────────────── */

  _renderThumb({ id, dataUrl, file }) {
    const thumb = document.createElement('div');
    thumb.className = 'attachment-thumb';
    thumb.id = id;
    thumb.title = file.name;

    const img = document.createElement('img');
    img.src = dataUrl;
    img.alt = file.name;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove-btn';
    removeBtn.title = 'Remove';
    removeBtn.innerHTML = '<svg viewBox="0 0 24 24" class="icon"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>';
    removeBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.remove(id); });

    thumb.append(img, removeBtn);
    this.previewEl.append(thumb);
  }

  /* ── Input sources: drag & drop, paste ─────────────────────────────── */

  _wireDragAndDrop(target) {
    let depth = 0;
    const activate = (on) => target.classList.toggle('drag-over', on);

    target.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      depth++;
      activate(true);
    });
    target.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
    });
    target.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) activate(false);
    });
    target.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      depth = 0;
      activate(false);
      this.addFiles(e.dataTransfer.files);
    });
  }

  _wirePaste(textarea) {
    textarea.addEventListener('paste', (e) => {
      const files = Array.from(e.clipboardData?.items || [])
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter(Boolean);
      if (files.length) this.addFiles(files);
    });
  }

  /* ── Helpers ───────────────────────────────────────────────────────── */

  _readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
}

window.AttachmentManager = AttachmentManager;
