/* ════════════════════════════════════════════════════════════════════════
 * MarkdownRenderer — renders Markdown live, while it's still streaming in.
 *
 * The naive approach (re-parse the buffer on every token) produces broken
 * HTML, because an in-flight response is, by definition, an incomplete
 * document — an unterminated ``` fence swallows everything after it. Every
 * CommonMark-compliant parser (marked, cmark-gfm, md4c…) has this same
 * problem; it isn't a library limitation.
 *
 * The fix applied here is the same one used for the native build: throttle
 * re-parses to a animation-frame cadence and "heal" the buffer — close any
 * dangling fence/inline-code span — before handing it to the parser, so the
 * rendered output never flickers between valid and broken HTML.
 * ════════════════════════════════════════════════════════════════════════ */

const MarkdownRenderer = (() => {
  let configured = false;

  function ensureConfigured() {
    if (configured || !window.marked) return;
    marked.setOptions({ gfm: true, breaks: true });
    configured = true;
  }

  /** Closes an unterminated ``` fence or inline ` span so a partial Markdown
   *  buffer always parses as a syntactically complete (if truncated) document. */
  function heal(markdown) {
    let text = markdown;

    const fences = (text.match(/```/g) || []).length;
    if (fences % 2 === 1) {
      text += '\n```';
    } else {
      const inline = (text.match(/(?<!`)`(?!`)/g) || []).length;
      if (inline % 2 === 1) text += '`';
    }
    return text;
  }

  /** Markdown → sanitised HTML string. `streaming` heals incomplete syntax
   *  first; the final render skips that (the buffer is complete by then). */
  function toSafeHtml(markdown, { streaming = false } = {}) {
    const source = streaming ? heal(markdown) : markdown;

    if (!window.marked) {
      // Library not loaded yet (e.g. offline first paint) — fail soft.
      const div = document.createElement('div');
      div.textContent = source;
      return div.innerHTML.replace(/\n/g, '<br>');
    }
    ensureConfigured();

    const rawHtml = marked.parse(source);
    return window.DOMPurify ? DOMPurify.sanitize(rawHtml, { ADD_ATTR: ['target'] }) : rawHtml;
  }

  /** Post-processes rendered code blocks: applies highlight.js and wraps each
   *  one in a header bar with a language label + "Copy" button — the detail
   *  that makes code read as a first-class citizen rather than a text dump. */
  function decorateCodeBlocks(container) {
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.parentElement?.classList.contains('code-block')) return;

      const codeEl = pre.querySelector('code');
      if (!codeEl) return;

      let lang = (/language-(\w+)/.exec(codeEl.className || '') || [])[1] || '';

      if (window.hljs) {
        try { hljs.highlightElement(codeEl); } catch { /* unrecognised grammar — leave plain */ }
        if (!lang) lang = (/language-(\w+)/.exec(codeEl.className || '') || [])[1] || '';
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block';

      const header = document.createElement('div');
      header.className = 'code-block-header';

      const langLabel = document.createElement('span');
      langLabel.className = 'code-block-lang';
      langLabel.textContent = lang || 'plaintext';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'copy-btn';
      copyBtn.innerHTML =
        '<svg viewBox="0 0 24 24" class="icon"><rect x="9" y="9" width="13" height="13" rx="2"/>' +
        '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span>';
      copyBtn.addEventListener('click', () => {
        const text = codeEl.textContent || '';
        const done = () => {
          copyBtn.classList.add('copied');
          copyBtn.querySelector('span').textContent = 'Copied';
          setTimeout(() => {
            copyBtn.classList.remove('copied');
            copyBtn.querySelector('span').textContent = 'Copy';
          }, 1600);
        };
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done);
        else done();
      });

      header.append(langLabel, copyBtn);
      pre.replaceWith(wrapper);
      wrapper.append(header, pre);
    });
  }

  /**
   * Drives a throttled live render into `el` as `getBuffer()` grows.
   * Re-parses at most once per animation frame — cheap enough that a whole
   * paragraph can land between repaints without the UI ever stalling.
   *
   * @returns {{ refresh: () => void, stop: (finalMarkdown:string) => void }}
   */
  function attachStreamingRenderer(el, getBuffer) {
    let frame = null;
    let stopped = false;

    const paint = () => {
      frame = null;
      if (stopped) return;
      el.innerHTML = toSafeHtml(getBuffer(), { streaming: true });
    };

    const refresh = () => {
      if (stopped || frame !== null) return;
      frame = requestAnimationFrame(paint);
    };

    const stop = (finalMarkdown) => {
      stopped = true;
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      el.innerHTML = toSafeHtml(finalMarkdown, { streaming: false });
      decorateCodeBlocks(el);
    };

    return { refresh, stop };
  }

  return { toSafeHtml, decorateCodeBlocks, attachStreamingRenderer, heal };
})();

window.MarkdownRenderer = MarkdownRenderer;
