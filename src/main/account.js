// Chadoodle-Konto: Der Moodle-Login ist das Konto. Darüber gleichen Desktop-App und Web-Version
// Einstellungen (Stundenpläne, Mensa, KI, Design), Mensa-Bestellungen und – wenn erlaubt – den
// Claude-API-Key ab (Supabase). Kursdateien, Kursinhalte und das Moodle-Token bleiben auf dem Gerät.
//
// Einstellungen werden pro Schlüssel mit Änderungszeit gespeichert; die neuere Änderung gewinnt
// (zusammengeführt in der Datenbank-Funktion merge_settings). Änderungen anderer Geräte kommen
// live über Supabase Realtime.
const { EventEmitter } = require('events');
const { createClient } = require('@supabase/supabase-js');
const store = require('./store');

const SUPABASE_URL = 'https://btqpwjireatmmiyihnei.supabase.co';
const SUPABASE_KEY = 'sb_publishable_QsTZb0ccYAGJJkdWNvcckg_LzFYyibN';
// Nur geräteübergreifend sinnvolle Einstellungen (nicht: Download-Ordner, Autostart, Sync-Intervall …)
const SYNCED = [
  'theme', 'aiProvider', 'claudeModel', 'chatgptModel', 'aiEffort', 'aiGrades', 'aiKeySync',
  'timetables', 'timetableActive',
  'mensaUrl', 'mensaMinBreak', 'mensaMinEat', 'mensaPickupFrom', 'mensaPickupTo', 'mensaFirstName', 'mensaLastName', 'mensaEmail',
];
const META_FILE = 'account-sync.json';
const PULL_MS = 10 * 60 * 1000;

class Account extends EventEmitter {
  constructor(mensa) {
    super();
    this.mensa = mensa;
    this.sb = null;
    this.userId = null;
    this.channel = null;
    this.pending = {};
    this.flushTimer = null;
    this.pullTimer = null;
    this.status = { state: 'off', message: '', lastSync: this.meta().lastSync || 0, connected: false };
    store.onSettingsChange((patch, opts) => this.onLocalChange(patch, opts));
    mensa.on('ordered', (entry) => this.pushOrders([entry]).catch(() => {}));
  }

  // ---------- Zustand ----------
  meta() {
    const m = store.readJson(store.file(META_FILE), null) || {};
    return { user: m.user || null, t: m.t || {}, keyT: m.keyT || 0, lastSync: m.lastSync || 0 };
  }

  saveMeta(m) {
    store.writeJson(store.file(META_FILE), m);
  }

  setStatus(state, message = '') {
    this.status = { state, message, lastSync: this.meta().lastSync, connected: this.connected };
    this.emit('status', this.status);
  }

  client() {
    if (!this.sb) {
      // Die Sitzung liegt wie die übrigen Geheimnisse im Speicher der App (DPAPI bzw. Browser)
      const storage = {
        getItem: (k) => store.getSecret('account:' + k),
        setItem: (k, v) => store.setSecret('account:' + k, v),
        removeItem: (k) => store.setSecret('account:' + k, null),
      };
      this.sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { storage, storageKey: 'session', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
    }
    return this.sb;
  }

  get connected() {
    return !!this.userId;
  }

  // ---------- Verbinden / Trennen ----------
  // Beim Start: vorhandene Sitzung nutzen, sonst still mit dem Moodle-Token verbinden
  async start() {
    if (store.getSettings().accountOff) return this.setStatus('off');
    try {
      const { data } = await this.client().auth.getSession();
      if (data.session) return await this.connect(data.session.user.id);
      const token = store.getSecret('moodleToken');
      const site = store.getSettings().siteUrl;
      if (token && site) await this.login(site, token);
    } catch (e) {
      this.setStatus('error', offline(e) ? 'Offline – Abgleich folgt später' : e.message);
    }
  }

  // Nach dem Moodle-Login: Das Token beweist die Moodle-Identität und wird nicht gespeichert
  async login(siteUrl, token) {
    this.setStatus('connecting');
    const res = await fetch(`${SUPABASE_URL}/functions/v1/account/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify({ siteUrl, token }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `Chadoodle-Konto nicht erreichbar (HTTP ${res.status})`);
    const { data, error } = await this.client().auth.setSession({ access_token: j.access_token, refresh_token: j.refresh_token });
    if (error) throw error;
    if (store.getSettings().accountOff) store.setSettings({ accountOff: false });
    await this.connect(data.session.user.id);
  }

  async connect(userId) {
    const meta = this.meta();
    if (meta.user !== userId) {
      // Erstes Mal mit diesem Konto: selbst geänderte Einstellungen gelten als „alt“ – was im Konto
      // schon steht, gewinnt; was dort fehlt, wird hochgeladen
      const saved = store.savedSettings();
      meta.user = userId;
      meta.t = Object.fromEntries(SYNCED.filter((k) => k in saved).map((k) => [k, 1]));
      meta.keyT = store.getSecret('anthropicKey') ? 1 : 0;
      this.saveMeta(meta);
    }
    this.userId = userId;
    this.subscribe();
    clearInterval(this.pullTimer);
    this.pullTimer = setInterval(() => this.pull().catch(() => {}), PULL_MS);
    await this.pull();
  }

  // Abmelden von Moodle bzw. Konto auf diesem Gerät trennen (Daten im Konto bleiben)
  async logout({ disable = false } = {}) {
    clearInterval(this.pullTimer);
    clearTimeout(this.flushTimer);
    this.pending = {};
    if (this.channel) this.client().removeChannel(this.channel);
    this.channel = null;
    this.userId = null;
    try {
      await this.client().auth.signOut({ scope: 'local' });
    } catch {}
    store.setSecret('account:session', null);
    if (disable) store.setSettings({ accountOff: true });
    this.setStatus('off');
  }

  // Konto samt aller synchronisierten Daten löschen
  async deleteAccount() {
    const { data } = await this.client().auth.getSession();
    if (!data.session) throw new Error('Nicht mit dem Chadoodle-Konto verbunden.');
    const res = await fetch(`${SUPABASE_URL}/functions/v1/account/delete`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${data.session.access_token}` },
    });
    if (!res.ok) throw new Error('Konto konnte nicht gelöscht werden.');
    await this.logout({ disable: true });
    store.writeJson(store.file(META_FILE), {});
  }

  subscribe() {
    const sb = this.client();
    if (this.channel) sb.removeChannel(this.channel);
    const filter = `user_id=eq.${this.userId}`;
    this.channel = sb
      .channel(`chadoodle-${this.userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_settings', filter }, (p) => p.new && p.new.data && this.applySettings(p.new.data))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_secrets', filter }, (p) => this.syncKey(p.new && p.new.user_id ? p.new : null).catch(() => {}))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensa_orders', filter }, (p) => p.new && this.importOrders([p.new.data]))
      .subscribe();
  }

  // ---------- Abgleich ----------
  async pull() {
    if (!this.connected) return;
    const sb = this.client();
    try {
      const [s, sec, ord] = await Promise.all([
        sb.from('user_settings').select('data').maybeSingle(),
        sb.from('user_secrets').select('anthropic_key, updated_ms').maybeSingle(),
        sb.from('mensa_orders').select('order_no, data').order('created_at', { ascending: false }).limit(200),
      ]);
      for (const r of [s, sec, ord]) if (r.error) throw r.error;
      const remote = (s.data && s.data.data) || {};
      this.applySettings(remote);
      // Lokal neuere (oder im Konto fehlende) Einstellungen hochladen
      const meta = this.meta();
      const cur = store.getSettings();
      for (const k of SYNCED) {
        const lt = meta.t[k] || 0;
        if (lt > ((remote[k] && remote[k].t) || 0)) this.pending[k] = { v: cur[k] ?? null, t: lt };
      }
      await this.flush();
      await this.syncKey(sec.data);
      this.importOrders(ord.data.map((r) => r.data));
      const remoteNos = new Set(ord.data.map((r) => r.order_no));
      await this.pushOrders(this.mensa.orders().filter((o) => o.no && !remoteNos.has(o.no)));
      const m = this.meta();
      m.lastSync = Date.now();
      this.saveMeta(m);
      this.setStatus('ok');
    } catch (e) {
      this.setStatus('error', offline(e) ? 'Offline – Abgleich folgt später' : e.message);
      if (/JWT|session|refresh/i.test(e.message || '')) await this.recoverSession();
    }
  }

  // Sitzung abgelaufen: mit dem Moodle-Token neu verbinden
  async recoverSession() {
    const token = store.getSecret('moodleToken');
    const site = store.getSettings().siteUrl;
    if (!token || !site) return;
    try {
      await this.login(site, token);
    } catch {}
  }

  applySettings(remote) {
    const meta = this.meta();
    const patch = {};
    for (const k of SYNCED) {
      const r = remote[k];
      if (r && typeof r.t === 'number' && r.t > (meta.t[k] || 0)) {
        patch[k] = r.v;
        meta.t[k] = r.t;
      }
    }
    if (!Object.keys(patch).length) return;
    this.saveMeta(meta);
    store.setSettings(patch, { remote: true });
    this.emit('changed', { settings: patch });
    if ('aiKeySync' in patch && patch.aiKeySync) this.pull().catch(() => {});
  }

  onLocalChange(patch, opts) {
    if (opts.remote) return;
    const keys = Object.keys(patch).filter((k) => SYNCED.includes(k));
    if (!keys.length) return;
    const meta = this.meta();
    const now = Date.now();
    for (const k of keys) {
      meta.t[k] = now;
      this.pending[k] = { v: patch[k] ?? null, t: now };
    }
    this.saveMeta(meta);
    if (!this.connected) return;
    if ('aiKeySync' in patch) {
      // Abgeschaltet: Key aus dem Konto entfernen; eingeschaltet: lokalen Key hochladen
      if (patch.aiKeySync) this.pushKey(store.getSecret('anthropicKey'), this.meta().keyT || now).catch(() => {});
      else this.client().from('user_secrets').delete().eq('user_id', this.userId).then(() => {}, () => {});
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush().catch(() => {}), 800);
  }

  async flush() {
    clearTimeout(this.flushTimer);
    if (!this.connected || !Object.keys(this.pending).length) return;
    const patch = this.pending;
    this.pending = {};
    const { data, error } = await this.client().rpc('merge_settings', { patch });
    if (error) {
      this.pending = { ...patch, ...this.pending };
      throw error;
    }
    this.applySettings(data || {});
  }

  // ---------- Claude-API-Key ----------
  // Lokal geändert (Einstellungen): merken und – wenn erlaubt – ins Konto schreiben
  keyChanged(key) {
    const meta = this.meta();
    meta.keyT = Date.now();
    this.saveMeta(meta);
    if (this.connected && store.getSettings().aiKeySync) this.pushKey(key, meta.keyT).catch(() => {});
  }

  async pushKey(key, t) {
    const { error } = await this.client().from('user_secrets').upsert({ user_id: this.userId, anthropic_key: key || null, updated_ms: t });
    if (error) throw error;
  }

  async syncKey(row) {
    if (!this.connected || !store.getSettings().aiKeySync) return;
    const meta = this.meta();
    const remoteT = (row && Number(row.updated_ms)) || 0;
    if (row && remoteT > meta.keyT) {
      store.setSecret('anthropicKey', row.anthropic_key || null);
      meta.keyT = remoteT;
      this.saveMeta(meta);
      this.emit('changed', { key: true });
    } else if (meta.keyT > remoteT && (row || store.getSecret('anthropicKey'))) {
      await this.pushKey(store.getSecret('anthropicKey'), meta.keyT);
    }
  }

  // ---------- Mensa-Bestellungen ----------
  importOrders(list) {
    if (this.mensa.importOrders(list)) this.emit('changed', { orders: true });
  }

  async pushOrders(list) {
    if (!this.connected || !list.length) return;
    const rows = list.map((o) => ({ user_id: this.userId, order_no: String(o.no), data: o }));
    const { error } = await this.client().from('mensa_orders').upsert(rows, { onConflict: 'user_id,order_no', ignoreDuplicates: true });
    if (error) throw error;
  }
}

const offline = (e) => /fetch failed|Failed to fetch|NetworkError|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(String((e && (e.message || e)) || ''));

module.exports = { Account, SYNCED };
