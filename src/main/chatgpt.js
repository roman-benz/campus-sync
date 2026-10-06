// ChatGPT-Lernassistent über „Sign in with ChatGPT“ (Plan-Nutzung statt API-Key).
// Responses API mit store:false + stream:true; Verlauf wird lokal gehalten und komplett mitgeschickt.
const { OpenAI } = require('openai');
const store = require('./store');
const { TOOL_SPECS, validateInput, instructions } = require('./ai-tools');
const { AuthRequiredError, log } = require('./chatgpt-auth');

// Basis-URL nur für Tests überschreibbar
const API_BASE = process.env.MOODLE_DESKTOP_OPENAI_BASE || 'https://api.openai.com/v1';
const FUNCTIONS = TOOL_SPECS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema, strict: false }));

// Ausgabe-Elemente so zurückschicken, dass sie ohne serverseitige Speicherung gültig sind
function toInputItems(output) {
  const items = [];
  for (const it of output || []) {
    if (it.type === 'message') {
      items.push({
        type: 'message',
        role: 'assistant',
        content: (it.content || []).filter((c) => c.type === 'output_text').map((c) => ({ type: 'output_text', text: c.text, annotations: [] })),
      });
    } else if (it.type === 'function_call') {
      items.push({ type: 'function_call', call_id: it.call_id, name: it.name, arguments: it.arguments });
    } else if (it.type === 'reasoning' && it.encrypted_content) {
      items.push({ type: 'reasoning', id: it.id, summary: it.summary || [], encrypted_content: it.encrypted_content });
    }
  }
  return items;
}

class ChatGPTAssistant {
  constructor(tools, auth) {
    this.tools = tools;
    this.auth = auth;
    this.conversations = new Map();
    this.modelCache = null;
    this.noReasoningOpts = false;
  }

  isBusy() {
    return [...this.conversations.values()].some((c) => c.busy);
  }

  reset(id) {
    const conv = this.conversations.get(id);
    if (conv && conv.abort) conv.abort.abort();
    this.conversations.delete(id);
  }

  stop(id) {
    const conv = this.conversations.get(id);
    if (conv) {
      conv.stopped = true;
      if (conv.abort) conv.abort.abort();
    }
  }

  // Modelle, die der ChatGPT-Plan des Nutzers für diese App freigibt
  async models(force = false) {
    if (this.modelCache && !force) return this.modelCache;
    const token = await this.auth.accessToken();
    const res = await fetch(`${API_BASE}/models`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Modelle konnten nicht geladen werden (HTTP ${res.status})`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.data || data.models || [];
    this.modelCache = list
      .filter((m) => !m.visibility || m.visibility === 'list')
      .map((m) => ({ id: m.slug || m.id, name: m.display_name || m.slug || m.id }));
    return this.modelCache;
  }

  async pickModel() {
    const wanted = store.getSettings().chatgptModel;
    const list = await this.models().catch(() => []);
    if (wanted && (!list.length || list.some((m) => m.id === wanted))) return wanted;
    if (list.length) return list[0].id;
    throw new Error('Für deinen ChatGPT-Plan sind keine Modelle verfügbar.');
  }

  async send({ conversationId, text, attachments = [], context = {} }, emit) {
    let conv = this.conversations.get(conversationId);
    if (!conv) {
      conv = { input: [], busy: false, stopped: false, abort: null };
      this.conversations.set(conversationId, conv);
    }
    conv.stopped = false;
    conv.busy = true;
    const startLen = conv.input.length;

    try {
      const blocks = await this.tools.attachmentBlocks(attachments, 'openai');
      const ctx = this.tools.describeContext(context);
      const content = blocks.filter((b) => b.type === 'text').map((b) => ({ type: 'input_text', text: b.text }));
      content.push({ type: 'input_text', text: ctx ? `${ctx}\n\n${text}` : text });
      conv.input.push({ type: 'message', role: 'user', content });

      const model = await this.pickModel();
      let authRetried = false;
      let rounds = 0;

      while (true) {
        if (++rounds > 25) throw new Error('Zu viele Werkzeugschritte – bitte die Frage eingrenzen.');
        const token = await this.auth.accessToken();
        const client = new OpenAI({ apiKey: token, baseURL: API_BASE, maxRetries: 1 });
        conv.abort = new AbortController();
        const params = {
          model,
          instructions: instructions(this.tools.cache),
          input: conv.input,
          tools: FUNCTIONS,
          parallel_tool_calls: true,
          store: false,
          stream: true,
        };
        if (!this.noReasoningOpts) {
          params.include = ['reasoning.encrypted_content'];
          params.reasoning = { summary: 'auto' };
        }

        emit('turn-start', {});
        let response = null;
        try {
          const stream = await client.responses.create(params, { signal: conv.abort.signal });
          for await (const ev of stream) {
            switch (ev.type) {
              case 'response.output_item.added':
                if (ev.item.type === 'message') emit('text-start', {});
                else if (ev.item.type === 'reasoning') emit('thinking-start', {});
                break;
              case 'response.output_text.delta':
                emit('text', { text: ev.delta });
                break;
              case 'response.reasoning_summary_text.delta':
                emit('thinking', { text: ev.delta });
                break;
              case 'response.completed':
                response = ev.response;
                break;
              case 'response.failed':
              case 'response.incomplete':
              case 'error': {
                const er = (ev.response && ev.response.error) || ev.error || ev;
                const reason = ev.response && ev.response.incomplete_details ? ev.response.incomplete_details.reason : null;
                const e = new Error((er && er.message) || (reason ? `Antwort unvollständig (${reason})` : 'Antwort fehlgeschlagen'));
                e.code = (er && er.code) || reason;
                throw e;
              }
            }
          }
        } catch (err) {
          if (err instanceof OpenAI.AuthenticationError && !authRetried) {
            authRetried = true;
            const a = this.auth.account();
            if (a) this.auth.save({ ...a, expiresAt: 0 }); // Token erzwingen erneuern
            continue;
          }
          if (err instanceof OpenAI.BadRequestError && !this.noReasoningOpts && /reasoning|include/i.test(err.message)) {
            this.noReasoningOpts = true; // Modell ohne Reasoning-Optionen
            emit('retry', {});
            continue;
          }
          throw err;
        }
        conv.abort = null;
        // Erfolg erst nach response.completed
        if (!response) throw new Error('Antwort wurde unterbrochen.');

        conv.input.push(...toInputItems(response.output));
        const calls = (response.output || []).filter((it) => it.type === 'function_call');
        if (!calls.length) {
          emit('done', { usage: response.usage, model: response.model });
          return;
        }

        const outputs = await Promise.all(
          calls.map(async (call) => {
            let input;
            try {
              input = JSON.parse(call.arguments || '{}');
            } catch {
              return { type: 'function_call_output', call_id: call.call_id, output: 'INVALID_JSON: Argumente waren kein gültiges JSON.' };
            }
            const invalid = validateInput(call.name, input);
            if (invalid) return { type: 'function_call_output', call_id: call.call_id, output: `INVALID_INPUT: ${invalid}` };
            emit('tool', { name: call.name, label: this.tools.label(call.name, input) });
            try {
              const out = await this.tools.run(call.name, input, 'openai');
              return { type: 'function_call_output', call_id: call.call_id, output: typeof out === 'string' ? out : JSON.stringify(out) };
            } catch (e) {
              return { type: 'function_call_output', call_id: call.call_id, output: `Fehler: ${e.message}` };
            }
          })
        );
        conv.input.push(...outputs);
        if (conv.stopped) throw new OpenAI.APIUserAbortError();
      }
    } catch (err) {
      conv.abort = null;
      conv.input.length = startLen;
      const mapped = this.mapError(err, conv);
      if (mapped[0] === 'error') log(`API-Fehler: status=${err.status || '–'} code=${err.code || (err.error && err.error.code) || '–'} ${String(err.message).slice(0, 300)}`);
      emit(...mapped);
    } finally {
      conv.busy = false;
    }
  }

  mapError(err, conv) {
    const code = err.code || (err.error && err.error.code) || '';
    if (err instanceof OpenAI.APIUserAbortError || conv.stopped || err.name === 'AbortError') return ['stopped', {}];
    if (err instanceof AuthRequiredError || err.code === 'auth_required') return ['error', { message: err.message, kind: 'chatgpt-auth' }];
    if (code === 'subscription_sharing_usage_limit_exceeded' || (err.status === 429 && /subscription|usage/i.test(err.message))) {
      return ['error', { message: 'Nutzungslimit erreicht. Prüfe deinen Plan oder das Limit dieser App in den ChatGPT-Einstellungen.', kind: 'chatgpt-limit' }];
    }
    if (code === 'subscription_sharing_user_not_eligible') return ['error', { message: 'Dein ChatGPT-Konto oder Workspace ist für die Plan-Nutzung in Apps nicht berechtigt (Plus oder Pro nötig).', kind: 'chatgpt-ineligible' }];
    if (code === 'subscription_sharing_usage_unavailable' || err.status === 503) return ['error', { message: 'Die ChatGPT-Plan-Nutzung ist gerade nicht verfügbar. Bitte später erneut versuchen.', kind: 'chatgpt-unavailable' }];
    if (code === 'subscription_sharing_unsupported_capability') return ['error', { message: 'Diese Anfrage wird mit dem ChatGPT-Plan nicht unterstützt.', kind: 'request' }];
    if (err instanceof OpenAI.AuthenticationError) return ['error', { message: 'ChatGPT-Anmeldung ungültig – bitte erneut anmelden.', kind: 'chatgpt-auth' }];
    if (err instanceof OpenAI.PermissionDeniedError) return ['error', { message: 'Zugriff verweigert: ' + err.message, kind: 'chatgpt-ineligible' }];
    if (err instanceof OpenAI.APIConnectionError) return ['error', { message: 'Keine Verbindung zu ChatGPT. Bist du offline?', kind: 'network' }];
    if (err instanceof OpenAI.APIError) return ['error', { message: `ChatGPT-Fehler (${err.status ?? '–'}): ${err.message}`, kind: 'api' }];
    return ['error', { message: err.message || String(err), kind: 'other' }];
  }
}

module.exports = { ChatGPTAssistant };
