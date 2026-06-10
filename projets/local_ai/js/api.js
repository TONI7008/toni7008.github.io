/* ════════════════════════════════════════════════════════════════════════
 * ApiWrapper — talks to any OpenAI-compatible chat-completions server
 * (LM Studio, Ollama's /v1 shim, llama.cpp's llama-server, vLLM,
 * text-generation-webui, or api.openai.com itself).
 *
 * This is the web counterpart of cwrapper.cpp/h: same endpoints
 * (/v1/models, /v1/chat/completions), same SSE "data: {...}" streaming
 * shape, same Bearer-token auth — plus multimodal support the original
 * didn't have (image_url content blocks for vision-capable models).
 * ════════════════════════════════════════════════════════════════════════ */

class ApiWrapper {
  constructor(config = {}) {
    this.serverIp   = config.serverIp   ?? '127.0.0.1';
    this.serverPort = config.serverPort ?? 1234;
    this.useHttps   = config.useHttps   ?? false;
    this.apiKey     = config.apiKey     ?? '';
    this.modelName  = config.modelName  ?? '';
    this.systemPrompt = config.systemPrompt ?? '';
  }

  configure(patch) {
    Object.assign(this, patch);
  }

  baseUrl() {
    const scheme = this.useHttps ? 'https' : 'http';
    const host = (this.serverIp || '').trim().replace(/\/+$/, '');
    const port = this.serverPort ? `:${this.serverPort}` : '';
    return `${scheme}://${host}${port}`;
  }

  _headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', ...extra };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  /* ── Model discovery ───────────────────────────────────────────────── */

  async listModels() {
    const res = await fetch(`${this.baseUrl()}/v1/models`, { headers: this._headers() });
    if (!res.ok) throw new Error(`HTTP ${res.status} while listing models`);
    const json = await res.json().catch(() => ({}));
    return Array.isArray(json.data) ? json.data : [];
  }

  /** Confirms the configured model exists on the server, falling back to the
   *  first available one — mirrors CWrapper::loadModel()'s auto-pick. */
  async ensureModel() {
    const models = await this.listModels();
    if (!models.length) throw new Error('Server reported no available models');
    if (this.modelName && models.some(m => m.id === this.modelName)) return this.modelName;
    this.modelName = models[0].id;
    return this.modelName;
  }

  /** LM Studio's extended listing (`/api/v0/models`) — same model ids as
   *  /v1/models, plus a runtime `state` ("loaded" | "not-loaded") and a
   *  `type` ("llm" | "vlm" | "embeddings") that tells us how to load one.
   *  Other OpenAI-compatible servers (Ollama, llama.cpp, vLLM, …) don't
   *  expose this, so a failed/missing probe just yields an empty map and
   *  callers fall back to not showing load state at all. */
  async listModelsDetailed() {
    try {
      const res = await fetch(`${this.baseUrl()}/api/v0/models`, { headers: this._headers() });
      if (!res.ok) return new Map();
      const json = await res.json().catch(() => ({}));
      const data = Array.isArray(json.data) ? json.data : [];
      return new Map(data.map((m) => [m.id, m]));
    } catch {
      return new Map();
    }
  }

  /** LM Studio loads models on demand (JIT) the moment they're used — there's
   *  no dedicated HTTP "load" endpoint, so the way to make it happen from the
   *  browser is to send the smallest real request the model type understands
   *  and let the server load it to serve that request. Resolves once the
   *  server has handled it (model now resident); throws on a hard failure. */
  async loadModel(modelId, type) {
    const isEmbedding = type === 'embeddings';
    const path = isEmbedding ? '/v1/embeddings' : '/v1/chat/completions';
    const body = isEmbedding
      ? { model: modelId, input: 'ping' }
      : { model: modelId, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false };

    const res = await fetch(`${this.baseUrl()}${path}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} while loading model${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }
  }

  /* ── Message construction (text + optional images) ────────────────── */

  /** Builds the OpenAI-shaped user message — a plain string for text-only
   *  turns, or a vision content-block array once images are attached. Also
   *  used by chat.js so the history it keeps matches exactly what was sent. */
  static userMessage(text, attachments = []) {
    if (attachments.length) {
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const att of attachments) {
        content.push({ type: 'image_url', image_url: { url: att.dataUrl } });
      }
      return { role: 'user', content };
    }
    return { role: 'user', content: text };
  }

  buildMessages(history, userText, attachments = []) {
    const messages = [];
    const sys = (this.systemPrompt || '').trim();
    if (sys) messages.push({ role: 'system', content: sys });

    for (const turn of history) messages.push(turn);
    messages.push(ApiWrapper.userMessage(userText, attachments));
    return messages;
  }

  /* ── Streaming chat completion ─────────────────────────────────────── */

  /**
   * Streams a chat completion from /v1/chat/completions.
   *
   * @param {Array<{role:string, content:*}>} history  prior turns (already
   *        in OpenAI message shape — see Session#toApiHistory)
   * @param {string} userText                          the new user message
   * @param {Array<{dataUrl:string}>} attachments      image attachments
   * @param {{onChunk?:(delta:string, full:string)=>void,
   *          onReasoning?:(delta:string, full:string)=>void,
   *          signal?:AbortSignal}} opts
   * @returns {Promise<string>} the fully assembled assistant response
   *          (reasoning is *not* included — see onReasoning)
   */
  async chat(history, userText, attachments = [], { onChunk, onReasoning, signal } = {}) {
    if (!this.modelName) throw new Error('No model selected — open Settings and fetch the model list');

    const body = JSON.stringify({
      model: this.modelName,
      messages: this.buildMessages(history, userText, attachments),
      stream: true,
    });

    const res = await fetch(`${this.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body,
      signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }

    return this._consumeSSE(res.body, onChunk, onReasoning);
  }

  /** Reads an SSE ("data: {json}\n\n") stream of chat-completion chunks and
   *  reassembles the full text, forwarding each delta as it arrives.
   *
   *  Reasoning models (e.g. Gemma's "thinking" variants served through LM
   *  Studio) stream their chain-of-thought first, as `delta.reasoning_content`
   *  — often dozens of chunks before the real answer's `delta.content` ever
   *  shows up. Those are forwarded separately through `onReasoning` (and kept
   *  out of the returned/assembled answer) so the caller can show the user
   *  *something* is happening instead of a frozen "typing…" placeholder. */
  async _consumeSSE(stream, onChunk, onReasoning) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';
    let fullReasoning = '';

    const handleLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;

      let json;
      try { json = JSON.parse(payload); } catch { return; } // partial frame — skip

      const choice = json?.choices?.[0];
      const reasoningDelta = choice?.delta?.reasoning_content
                          ?? choice?.message?.reasoning_content
                          ?? '';
      if (reasoningDelta) {
        fullReasoning += reasoningDelta;
        onReasoning?.(reasoningDelta, fullReasoning);
      }

      const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
      if (delta) {
        full += delta;
        onChunk?.(delta, full);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    }
    if (buffer.trim()) handleLine(buffer);

    return full;
  }
}

window.ApiWrapper = ApiWrapper;
