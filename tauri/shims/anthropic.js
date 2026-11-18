// Die Anthropic-SDK verweigert sich im Browser ohne ausdrückliche Freigabe. In der Desktop-App
// gehört der Schlüssel dem Nutzer selbst und die Anfragen laufen über Rust (tauri/net.js).
const real = require('@anthropic-ai/sdk');

class Anthropic extends real.Anthropic {
  constructor(opts = {}) {
    super({ ...opts, dangerouslyAllowBrowser: true });
  }
}

module.exports = { ...real, Anthropic, default: Anthropic };
