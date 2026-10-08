// Anmeldung der Desktop-App mit Passkey (Rückruf an die App auf 127.0.0.1, Parameter im #-Teil des Links).
import { appLoginPage, securityHeaders, newNonce } from './_auth/pages.js';

export async function onRequestGet() {
  const nonce = newNonce();
  return new Response(appLoginPage(nonce), { headers: securityHeaders(nonce) });
}
