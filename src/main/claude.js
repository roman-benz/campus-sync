// Claude-Lernassistent (Anthropic API-Key): Streaming + Werkzeug-Schleife über die lokalen Moodle-Daten.
const { Anthropic } = require('@anthropic-ai/sdk');
const store = require('./store');
const { TOOL_SPECS, validateInput, instructions } = require('./ai-tools');

const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);
const NO_ADAPTIVE_THINKING = new Set(['claude-haiku-4-5']);
const TOOLS = TOOL_SPECS.map((t) => ({ ...t, eager_input_streaming: true }));

class ClaudeAssistant {
  constructor(tools) {
    this.tools = tools;
    this.conversations = new Map();
  }

  client() {
    const key = store.getSecret('anthropicKey');
    return key ? new Anthropic({ apiKey: key }) : new Anthropic();
  }

  isBusy() {
    return [...this.conversations.values()].some((c) => c.busy);
  }

  reset(conversationId) {
    const conv = this.conversations.get(conversationId);
    if (conv && conv.stream) conv.stream.abort();
    this.conversations.delete(conversationId);
  }

  stop(conversationId) {
    const conv = this.conversations.get(conversationId);
    if (conv) {
      conv.stopped = true;
      if (conv.stream) conv.stream.abort();
    }
  }

  async send({ conversationId, text, attachments = [], context = {} }, emit) {
    let conv = this.conversations.get(conversationId);
    if (!conv) {
      conv = { messages: [], stream: null, stopped: false, busy: false };
      this.conversations.set(conversationId, conv);
    }
    conv.stopped = false;
    conv.busy = true;
    const startLen = conv.messages.length;

    try {
      const content = await this.tools.attachmentBlocks(attachments, 'claude');
      const ctx = this.tools.describeContext(context);
      content.push({ type: 'text', text: ctx ? `${ctx}\n\n${text}` : text });
      conv.messages.push({ role: 'user', content });

      const model = store.getSettings().claudeModel || 'claude-opus-5';
      const params = {
        model,
        max_tokens: 64000,
        system: instructions(this.tools.cache),
        tools: TOOLS,
        cache_control: { type: 'ephemeral' },
        messages: conv.messages,
      };
      if (!NO_ADAPTIVE_THINKING.has(model)) params.thinking = { type: 'adaptive', display: 'summarized' };
      if (FALLBACK_MODELS.has(model)) {
        // Lehnt ein Sicherheitsklassifikator ab, beantwortet ein empfohlenes Ersatzmodell die Anfrage.
        params.betas = ['server-side-fallback-2026-07-01'];
        params.fallbacks = 'default';
      }

      const client = this.client();
      let jsonRetries = 0;
      while (true) {
        const stream = client.beta.messages.stream(params);
        conv.stream = stream;
        emit('turn-start', {});
        let message;
        try {
          for await (const event of stream) {
            if (event.type === 'content_block_start') {
              const b = event.content_block;
              if (b.type === 'thinking') emit('thinking-start', {});
              else if (b.type === 'text') emit('text-start', {});
              else if (b.type === 'fallback') emit('notice', { message: 'Anfrage wurde an ein Ersatzmodell weitergeleitet.' });
            } else if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') emit('text', { text: event.delta.text });
              else if (event.delta.type === 'thinking_delta') emit('thinking', { text: event.delta.thinking });
            }
          }
          message = await stream.finalMessage();
          jsonRetries = 0;
        } catch (err) {
          // Nur ungültiges Werkzeug-JSON wiederholen – SDK-/API-Fehler direkt weiterreichen
          if (err instanceof Anthropic.AnthropicError || conv.stopped || jsonRetries++ >= 2) throw err;
          emit('retry', {});
          continue;
        }
        conv.stream = null;

        if (message.stop_reason === 'refusal') {
          conv.messages.length = startLen;
          emit('error', { message: 'Claude hat diese Anfrage abgelehnt. Formuliere sie bitte anders.', kind: 'refusal' });
          return;
        }
        conv.messages.push({ role: 'assistant', content: message.content });

        const toolUses = message.content.filter((b) => b.type === 'tool_use');
        if (message.stop_reason === 'max_tokens' && toolUses.length) throw new Error('Antwort wurde abgeschnitten (max_tokens).');
        if (message.stop_reason === 'pause_turn') continue;
        if (message.stop_reason !== 'tool_use' || !toolUses.length) {
          emit('done', { usage: message.usage, model: message.model });
          return;
        }

        const results = await Promise.all(
          toolUses.map(async (tu) => {
            const invalid = validateInput(tu.name, tu.input);
            if (invalid) return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `INVALID_INPUT: ${invalid}` };
            emit('tool', { name: tu.name, label: this.tools.label(tu.name, tu.input) });
            try {
              return { type: 'tool_result', tool_use_id: tu.id, content: await this.tools.run(tu.name, tu.input, 'claude') };
            } catch (e) {
              return { type: 'tool_result', tool_use_id: tu.id, is_error: true, content: e.message };
            }
          })
        );
        conv.messages.push({ role: 'user', content: results });
        if (conv.stopped) throw new Anthropic.APIUserAbortError();
      }
    } catch (err) {
      conv.stream = null;
      conv.messages.length = startLen; // Runde verwerfen, Verlauf bleibt konsistent
      if (err instanceof Anthropic.APIUserAbortError || conv.stopped) {
        emit('stopped', {});
      } else if (err instanceof Anthropic.AuthenticationError || (!(err instanceof Anthropic.APIError) && /authentication method/i.test(err.message))) {
        emit('error', { message: 'Kein gültiger Claude-API-Key hinterlegt. Bitte in den Einstellungen prüfen.', kind: 'auth' });
      } else if (err instanceof Anthropic.RateLimitError) {
        emit('error', { message: 'Rate-Limit erreicht – bitte kurz warten und erneut versuchen.', kind: 'rate' });
      } else if (err instanceof Anthropic.APIConnectionError) {
        emit('error', { message: 'Keine Verbindung zu Claude. Bist du offline?', kind: 'network' });
      } else if (err instanceof Anthropic.BadRequestError) {
        emit('error', { message: 'Anfrage abgelehnt: ' + (err.error?.error?.message || err.message), kind: 'request' });
      } else if (err instanceof Anthropic.APIError) {
        emit('error', { message: `Claude-Fehler (${err.status ?? '–'}): ${err.message}`, kind: 'api' });
      } else {
        emit('error', { message: err.message || String(err), kind: 'other' });
      }
    } finally {
      conv.busy = false;
    }
  }
}

module.exports = { ClaudeAssistant };
