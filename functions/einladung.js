// Einladung einlösen: Passkey für einen neuen (oder bestehenden) Nutzer einrichten. Das Token steht im #-Teil des Links.
import { invitePage, securityHeaders, newNonce } from './_auth/pages.js';

export async function onRequestGet() {
  const nonce = newNonce();
  return new Response(invitePage(nonce), { headers: securityHeaders(nonce) });
}
