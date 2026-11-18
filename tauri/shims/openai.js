// Wie anthropic.js: Freigabe der OpenAI-SDK für die Desktop-App (ChatGPT-Plan des Nutzers).
const real = require('openai');

class OpenAI extends real.OpenAI {
  constructor(opts = {}) {
    super({ ...opts, dangerouslyAllowBrowser: true });
  }
}

module.exports = { ...real, OpenAI, default: OpenAI };
