/* ════════════════════════════════════════════════════════════════════════
 * ChatController — owns the active conversation: rendering bubbles,
 * streaming the assistant's reply through MarkdownRenderer, persisting
 * turns into SessionStore, and driving the animated auto-scroll.
 *
 * Message history is kept in OpenAI wire format ({role, content}) end to
 * end — the same array is what gets sent back as context, what gets
 * persisted to localStorage, and what gets replayed when a session is
 * reopened (vision turns included, since `content` may be a block array).
 * ════════════════════════════════════════════════════════════════════════ */

const SEND_ICON =
  '<svg viewBox="0 0 24 24" class="icon"><line x1="12" y1="19" x2="12" y2="6"/><polyline points="6 12 12 6 18 12"/></svg>';
const STOP_ICON =
  '<svg viewBox="0 0 24 24" class="icon" style="fill:currentColor;stroke:none"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
const SPARK_ICON =
  '<svg viewBox="0 0 24 24" class="icon" style="width:15px;height:15px;fill:currentColor;stroke:none">' +
  '<path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>';
const TYPING_HTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
const COPY_ICON =
  '<svg viewBox="0 0 24 24" class="icon"><rect x="9" y="9" width="13" height="13" rx="2"/>' +
  '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" class="icon"><polyline points="20 6 9 17 4 12"/></svg>';

/** Splits an OpenAI-shaped user `content` (string or vision block array)
 *  back into displayable text + image URLs — the inverse of ApiWrapper.userMessage. */
function splitUserContent(content) {
  if (typeof content === 'string') return { text: content, images: [] };
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const images = blocks.filter((b) => b.type === 'image_url').map((b) => b.image_url?.url).filter(Boolean);
  return { text, images };
}

class ChatController {
  constructor({ api, attachments, sidebar, els }) {
    this.api = api;
    this.attachments = attachments;
    this.sidebar = sidebar;
    this.els = els;

    this.session = this._blankSession();
    this.busy = false;
    this.abortCtrl = null;
    this._scrollAnim = null;

    this._wireComposer();
    this._wireScrollTracking();

    this._autoGrow();
    this.syncSendEnabled();
    this.sidebar.refresh(this.session.id);
  }

  /* ── Session lifecycle ─────────────────────────────────────────────── */

  _blankSession() {
    return { id: SessionStore.makeId(), createdAt: Date.now(), preview: '', messages: [] };
  }

  newChat() {
    if (this.busy) this._abort();
    this.attachments.clear();
    this.session = this._blankSession();
    this._clearTranscript();
    this._showEmptyState(true);
    this.sidebar.refresh(this.session.id);
    this.els.textarea.value = '';
    this._autoGrow();
    this.syncSendEnabled();
    this.els.textarea.focus({ preventScroll: true });
  }

  openSession(id) {
    if (id === this.session.id) return;
    const stored = SessionStore.load(id);
    if (!stored) return;

    if (this.busy) this._abort();
    this.attachments.clear();
    this.session = stored;
    this._clearTranscript();

    if (stored.messages.length) {
      this._showEmptyState(false);
      for (const msg of stored.messages) this._renderStored(msg);
    } else {
      this._showEmptyState(true);
    }

    this.sidebar.refresh(this.session.id);
    this._scrollToBottom(false);
  }

  /** Called after the sidebar has deleted a session — bail out to a fresh
   *  chat if the one that vanished was the one currently open. */
  handleSessionDeleted(id) {
    if (id === this.session.id) this.newChat();
  }

  _clearTranscript() {
    this.els.chatColumn.querySelectorAll('.msg-row').forEach((el) => el.remove());
  }

  _showEmptyState(show) {
    this.els.emptyState.style.display = show ? '' : 'none';
  }

  /* ── Composer wiring ───────────────────────────────────────────────── */

  _wireComposer() {
    this.els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.busy) this._abort();
      else this._submit();
    });

    this.els.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!this.busy) this._submit();
      }
    });

    this.els.textarea.addEventListener('input', () => {
      this._autoGrow();
      this.syncSendEnabled();
    });
  }

  _autoGrow() {
    const ta = this.els.textarea;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }

  /** Re-evaluates whether the send button should be enabled. Exposed so the
   *  AttachmentManager's onChange hook can call it too (attaching an image
   *  with an empty composer should still allow sending). */
  syncSendEnabled() {
    if (this.busy) return;
    const hasText = this.els.textarea.value.trim().length > 0;
    this.els.sendBtn.disabled = !hasText && this.attachments.count === 0;
  }

  _setBusy(busy) {
    this.busy = busy;
    this.els.sendBtn.classList.toggle('is-busy', busy);
    this.els.sendBtn.innerHTML = busy ? STOP_ICON : SEND_ICON;
    this.els.sendBtn.title = busy ? 'Stop generating' : 'Send message';
    this.els.sendBtn.disabled = false;
    if (!busy) this.syncSendEnabled();
  }

  _abort() {
    this.abortCtrl?.abort();
  }

  /* ── Sending & streaming ───────────────────────────────────────────── */

  async _submit() {
    const text = this.els.textarea.value.trim();
    const apiAttachments = this.attachments.toApiAttachments();
    const imageUrls = this.attachments.items.map((i) => i.dataUrl);
    if (!text && !apiAttachments.length) return;

    this._showEmptyState(false);
    this._renderUserBubble(text, imageUrls);

    const priorTurns = this.session.messages.slice();
    this.session.messages.push(ApiWrapper.userMessage(text, apiAttachments));
    if (!this.session.preview) this.session.preview = text || 'Image attachment';

    this.els.textarea.value = '';
    this._autoGrow();
    this.attachments.clear();
    this._setBusy(true);
    this._scrollToBottom(true);

    const { row, bubble } = this._appendStreamingBubble();
    let buffer = '';
    let thinking = '';
    let thinkingFrame = null;
    let firstTokenSeen = false;
    const renderer = MarkdownRenderer.attachStreamingRenderer(bubble, () => buffer);

    const paintThinking = () => {
      thinkingFrame = null;
      if (!firstTokenSeen) this._renderThinking(bubble, thinking);
    };

    this.abortCtrl = new AbortController();
    try {
      const full = await this.api.chat(priorTurns, text, apiAttachments, {
        signal: this.abortCtrl.signal,
        // Reasoning models stream their chain-of-thought before the real
        // answer — surface it as a live preview so the bubble doesn't sit
        // frozen on the typing-dots for the whole "thinking" phase.
        onReasoning: (_delta, fullReasoning) => {
          thinking = fullReasoning;
          if (!firstTokenSeen && thinkingFrame === null) {
            thinkingFrame = requestAnimationFrame(paintThinking);
          }
        },
        onChunk: (_delta, fullText) => {
          buffer = fullText;
          if (!firstTokenSeen) {
            firstTokenSeen = true;
            if (thinkingFrame !== null) { cancelAnimationFrame(thinkingFrame); thinkingFrame = null; }
            bubble.innerHTML = '';
          }
          renderer.refresh();
          this._scrollToBottom(true, { onlyIfNearBottom: true });
        },
      });
      buffer = full || buffer;
      renderer.stop(buffer);
      if (buffer) {
        this.session.messages.push({ role: 'assistant', content: buffer });
        this._appendCopyButton(bubble, () => buffer);
      } else {
        console.error('Chat request returned an empty response.');
        row.remove();
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        renderer.stop(buffer);
        if (buffer) {
          this.session.messages.push({ role: 'assistant', content: buffer });
          this._appendCopyButton(bubble, () => buffer);
        } else row.remove();
      } else {
        console.error('Chat request failed:', err);
        row.remove();
      }
    } finally {
      this.abortCtrl = null;
      this._setBusy(false);
      SessionStore.save(this.session);
      this.sidebar.refresh(this.session.id);
      this._scrollToBottom(true);
    }
  }

  /** Live "thinking…" preview shown in place of the typing-dots while a
   *  reasoning model streams its chain-of-thought — tail of the reasoning
   *  text so far, since that's what's most relevant to what's coming next. */
  _renderThinking(bubble, text) {
    bubble.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'msg-thinking';
    p.textContent = text.replace(/\s+/g, ' ').trim().slice(-200);
    bubble.append(p);
  }

  /* ── Bubble rendering ──────────────────────────────────────────────── */

  _row(role) {
    const row = document.createElement('div');
    row.className = `msg-row ${role}`;

    const avatar = document.createElement('div');
    avatar.className = `avatar ${role}`;
    if (role === 'assistant') avatar.innerHTML = SPARK_ICON;
    else avatar.textContent = 'U';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    row.append(avatar, bubble);
    this.els.chatColumn.append(row);
    return { row, bubble };
  }

  _renderUserBubble(text, imageUrls = []) {
    const { bubble } = this._row('user');

    if (text) {
      const span = document.createElement('div');
      span.className = 'msg-text';
      span.textContent = text;
      bubble.append(span);
    }
    if (imageUrls.length) {
      const wrap = document.createElement('div');
      wrap.className = 'msg-attachments';
      for (const url of imageUrls) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Attached image';
        wrap.append(img);
      }
      bubble.append(wrap);
    }
    return bubble;
  }

  _renderAssistantBubble(markdown) {
    const { bubble } = this._row('assistant');
    bubble.innerHTML = MarkdownRenderer.toSafeHtml(markdown);
    MarkdownRenderer.decorateCodeBlocks(bubble);
    this._appendCopyButton(bubble, () => markdown);
    return bubble;
  }

  /** Small "copy whole message" button overlaid on assistant bubbles —
   *  alongside MarkdownRenderer's per-code-block Copy buttons (which copy
   *  just a fenced block's contents), this one copies the raw response text
   *  exactly as the model produced it, formatting and all. */
  _appendCopyButton(bubble, getText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-copy-btn';
    btn.title = 'Copy message';
    btn.innerHTML = COPY_ICON;
    btn.addEventListener('click', () => {
      const text = getText();
      if (!text) return;
      const done = () => {
        btn.classList.add('copied');
        btn.innerHTML = CHECK_ICON;
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = COPY_ICON; }, 1600);
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    });
    bubble.append(btn);
  }

  _appendStreamingBubble() {
    const { row, bubble } = this._row('assistant');
    bubble.innerHTML = TYPING_HTML;
    return { row, bubble };
  }

  _renderStored(msg) {
    if (msg.role === 'user') {
      const { text, images } = splitUserContent(msg.content);
      this._renderUserBubble(text, images);
    } else if (msg.role === 'assistant') {
      this._renderAssistantBubble(msg.content);
    }
  }

  /* ── Scrolling ─────────────────────────────────────────────────────── */

  _wireScrollTracking() {
    this.els.chatScroll.addEventListener('scroll', () => {
      this.els.appEl.classList.toggle('scrolled', this.els.chatScroll.scrollTop > 4);
    });
  }

  /** Animated glide to the bottom — cancels/retargets cleanly so a burst of
   *  streamed chunks never queues up a stack of competing scrolls.
   *  `onlyIfNearBottom` skips the jump if the user has scrolled up to read. */
  _scrollToBottom(animated, { onlyIfNearBottom = false } = {}) {
    const el = this.els.chatScroll;
    const target = el.scrollHeight - el.clientHeight;
    if (target <= 0) return;

    if (onlyIfNearBottom && target - el.scrollTop > 120) return;

    if (this._scrollAnim !== null) {
      cancelAnimationFrame(this._scrollAnim);
      this._scrollAnim = null;
    }
    if (!animated) { el.scrollTop = target; return; }

    const start = el.scrollTop;
    const distance = target - start;
    if (Math.abs(distance) < 1) return;

    const duration = 320;
    const startTime = performance.now();
    const easeOutCubic = (t) => 1 - (1 - t) ** 3;

    const step = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      el.scrollTop = start + distance * easeOutCubic(t);
      this._scrollAnim = t < 1 ? requestAnimationFrame(step) : null;
    };
    this._scrollAnim = requestAnimationFrame(step);
  }

  /* ── Connection status pill ────────────────────────────────────────── */

  async checkConnection() {
    this.els.statusDot.className = 'status-dot pending';
    this.els.modelLabel.textContent = 'Connecting…';
    try {
      const model = await this.api.ensureModel();
      this.els.statusDot.className = 'status-dot online';
      this.els.modelLabel.textContent = model;
    } catch (err) {
      this.els.statusDot.className = 'status-dot offline';
      this.els.modelLabel.textContent = err?.message || 'Offline — check Settings';
    }
  }
}

window.ChatController = ChatController;
