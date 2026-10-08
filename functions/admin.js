// Admin-Dashboard: Einladungslinks erzeugen, Nutzer und Passkeys verwalten
import { adminPage, forbiddenPage, securityHeaders, newNonce } from './_auth/pages.js';

export async function onRequestGet({ data }) {
  const nonce = newNonce();
  const user = data.session && data.session.user;
  if (!user || !user.isAdmin) return new Response(forbiddenPage(nonce), { status: 403, headers: securityHeaders(nonce) });
  return new Response(adminPage(nonce, user), { headers: securityHeaders(nonce) });
}
