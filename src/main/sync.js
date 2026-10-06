// Hintergrund-Synchronisation: holt Kurse, Inhalte, Termine, Noten und lädt alle Dateien
// in einen lokalen Ordner. Die Oberfläche und Claude arbeiten ausschließlich mit diesem Cache.
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const store = require('./store');

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

function safeName(name, max = 80) {
  let s = String(name || 'Unbenannt')
    .replace(/<[^>]*>/g, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (s.length > max) s = s.slice(0, max).trim();
  return s || 'Unbenannt';
}

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// pluginfile-Links in HTML auf das lokale mfile://-Protokoll umbiegen (Token bleibt im Hauptprozess).
function rewriteHtml(html, siteUrl) {
  if (!html) return html;
  const esc = siteUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}/(?:webservice/)?pluginfile\\.php/[^"'\\s<>)]+`, 'g');
  return html.replace(re, (u) => 'mfile://file/' + encodeURIComponent(u.replace(/&amp;/g, '&')));
}

class SyncEngine extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.cache = null;
    this.running = false;
    this.timer = null;
    this.status = { state: 'idle', message: '', done: 0, total: 0 };
  }

  cachePath() {
    return store.file(path.join('cache', sha(this.client.siteUrl).slice(0, 12) + '.json'));
  }

  attach(client) {
    this.client = client;
    this.cache = store.readJson(this.cachePath(), null) || this.emptyCache();
    if (this.cache.site && this.cache.site.userid) client.userid = this.cache.site.userid;
  }

  detach() {
    this.stopTimer();
    this.client = null;
    this.cache = null;
  }

  emptyCache() {
    return {
      site: null, courses: [], contents: {}, pages: {}, assignments: {}, forums: {},
      events: [], grades: {}, notifications: [], files: {}, newItems: [],
      notifiedEvents: [], lastSync: 0, lastError: null,
    };
  }

  save() {
    if (this.client && this.cache) store.writeJson(this.cachePath(), this.cache);
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch, lastSync: this.cache ? this.cache.lastSync : 0 };
    this.emit('status', this.status);
  }

  startTimer() {
    this.stopTimer();
    const min = Math.max(5, Number(store.getSettings().syncIntervalMin) || 30);
    this.timer = setInterval(() => this.run().catch(() => {}), min * 60 * 1000);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  courseDir(course) {
    const base = store.getSettings().downloadDir;
    return path.join(base, safeName(course.shortname || course.fullname, 60));
  }

  async run() {
    if (!this.client || this.running) return;
    this.running = true;
    const c = this.client;
    const prev = this.cache;
    const firstSync = !prev.lastSync;
    const next = { ...this.emptyCache(), notifiedEvents: prev.notifiedEvents || [], newItems: prev.newItems || [] };

    try {
      this.setStatus({ state: 'syncing', message: 'Verbinde mit Moodle…', done: 0, total: 0 });
      const info = await c.call('core_webservice_get_site_info');
      c.userid = info.userid;
      next.site = {
        url: c.siteUrl, sitename: info.sitename, fullname: info.fullname, firstname: info.firstname,
        userid: info.userid, userpictureurl: info.userpictureurl, release: info.release, lang: info.lang,
      };
      next.site.avatar = await this.cacheImage(info.userpictureurl, 'avatar');

      this.setStatus({ message: 'Lade Kursliste…' });
      const courses = await c.call('core_enrol_get_users_courses', { userid: info.userid, returnusercount: 0 });
      next.courses = courses.map((k) => ({
        id: k.id, fullname: k.fullname, shortname: k.shortname, summary: rewriteHtml(k.summary, c.siteUrl),
        category: k.category, progress: k.progress, completed: k.completed, lastaccess: k.lastaccess,
        startdate: k.startdate, enddate: k.enddate, hidden: k.hidden, isfavourite: k.isfavourite,
        imageRemote: k.courseimage || (k.overviewfiles && k.overviewfiles[0] && k.overviewfiles[0].fileurl) || null,
      }));
      // Kategorienamen (optional, nicht jede Seite erlaubt das)
      try {
        const ids = [...new Set(next.courses.map((k) => k.category).filter(Boolean))];
        if (ids.length) {
          const cats = await c.call('core_course_get_categories', { criteria: [{ key: 'ids', value: ids.join(',') }], addsubcategories: 0 });
          const map = Object.fromEntries(cats.map((x) => [x.id, x.name]));
          next.courses.forEach((k) => (k.categoryname = map[k.category] || ''));
        }
      } catch {}

      let n = 0;
      await pool(next.courses, 4, async (course) => {
        this.setStatus({ message: `Kursinhalte: ${course.shortname || course.fullname}`, done: ++n, total: next.courses.length });
        course.image = await this.cacheImage(course.imageRemote, 'course-' + course.id);
        try {
          const sections = await c.call('core_course_get_contents', { courseid: course.id });
          next.contents[course.id] = sections.map((s) => ({
            id: s.id, section: s.section, name: s.name, visible: s.visible, uservisible: s.uservisible,
            summary: rewriteHtml(s.summary, c.siteUrl),
            modules: (s.modules || []).map((m) => ({
              id: m.id, instance: m.instance, name: m.name, modname: m.modname, modplural: m.modplural,
              url: m.url, visible: m.visible, uservisible: m.uservisible, purpose: m.purpose,
              description: rewriteHtml(m.description, c.siteUrl), dates: m.dates || [],
              completion: m.completiondata ? m.completiondata.state : null,
              contents: (m.contents || []).map((f) => ({
                type: f.type, filename: f.filename, filepath: f.filepath, filesize: f.filesize,
                fileurl: f.fileurl, timemodified: f.timemodified, mimetype: f.mimetype,
              })),
            })),
          }));
        } catch (e) {
          next.contents[course.id] = prev.contents[course.id] || [];
        }
        try {
          const g = await c.call('gradereport_user_get_grade_items', { courseid: course.id, userid: info.userid });
          const items = (g.usergrades && g.usergrades[0] && g.usergrades[0].gradeitems) || [];
          next.grades[course.id] = items.map((it) => ({
            id: it.id, name: it.itemname || (it.itemtype === 'course' ? 'Kursgesamt' : 'Bewertung'),
            itemtype: it.itemtype, itemmodule: it.itemmodule, cmid: it.cmid, grade: it.gradeformatted,
            range: it.rangeformatted, percentage: it.percentageformatted, feedback: it.feedback,
            weight: it.weightformatted, graded: it.gradedategraded,
          }));
        } catch {
          next.grades[course.id] = prev.grades[course.id] || [];
        }
      });

      const courseids = next.courses.map((k) => k.id);
      this.setStatus({ message: 'Aufgaben, Seiten und Foren…', done: 0, total: 0 });
      if (courseids.length) {
        try {
          const a = await c.call('mod_assign_get_assignments', { courseids });
          for (const course of a.courses || []) {
            for (const as of course.assignments || []) {
              next.assignments[as.cmid] = {
                id: as.id, courseid: course.id, name: as.name, duedate: as.duedate, cutoffdate: as.cutoffdate,
                allowsubmissionsfromdate: as.allowsubmissionsfromdate, intro: rewriteHtml(as.intro, c.siteUrl),
                attachments: (as.introattachments || []).map((f) => ({
                  filename: f.filename, filepath: f.filepath, filesize: f.filesize, fileurl: f.fileurl,
                  timemodified: f.timemodified, mimetype: f.mimetype,
                })),
              };
            }
          }
        } catch {
          next.assignments = prev.assignments;
        }
        try {
          const p = await c.call('mod_page_get_pages_by_courses', { courseids });
          for (const pg of p.pages || []) {
            next.pages[pg.coursemodule] = { name: pg.name, intro: rewriteHtml(pg.intro, c.siteUrl), content: rewriteHtml(pg.content, c.siteUrl), timemodified: pg.timemodified };
          }
        } catch {
          next.pages = prev.pages;
        }
        try {
          const forums = await c.call('mod_forum_get_forums_by_courses', { courseids });
          await pool(forums, 4, async (f) => {
            let list = [];
            try {
              const r = await c.call('mod_forum_get_forum_discussions', { forumid: f.id, sortorder: 1, page: 0, perpage: 15 });
              list = r.discussions || [];
            } catch {
              try {
                const r = await c.call('mod_forum_get_forum_discussions_paginated', { forumid: f.id, sortby: 'timemodified', sortdirection: 'DESC', page: 0, perpage: 15 });
                list = r.discussions || [];
              } catch {}
            }
            next.forums[f.cmid] = {
              name: f.name, type: f.type, courseid: f.course,
              discussions: list.map((d) => ({
                id: d.discussion, subject: d.subject || d.name, message: rewriteHtml(d.message, c.siteUrl),
                author: d.userfullname, created: d.created, modified: d.timemodified, replies: d.numreplies,
                pinned: d.pinned,
              })),
            };
          });
        } catch {
          next.forums = prev.forums;
        }
      }

      this.setStatus({ message: 'Termine…' });
      try {
        const now = Math.floor(Date.now() / 1000);
        const ev = await c.call('core_calendar_get_action_events_by_timesort', { timesortfrom: now - 3 * 86400, limitnum: 50, limittononsuspendedevents: 1 });
        next.events = (ev.events || []).map((e) => ({
          id: e.id, name: e.name, activityname: e.activityname, timesort: e.timesort, modulename: e.modulename,
          instance: e.instance, cmid: Number((/[?&]id=(\d+)/.exec(e.url || '') || [])[1]) || null,
          courseid: e.course ? e.course.id : null,
          coursename: e.course ? e.course.fullname : '', url: e.url, overdue: e.overdue,
          action: e.action ? { name: e.action.name, url: e.action.url, actionable: e.action.actionable } : null,
          description: rewriteHtml(e.description, c.siteUrl),
        }));
      } catch {
        next.events = prev.events;
      }
      try {
        const nt = await c.call('message_popup_get_popup_notifications', { useridto: info.userid, limit: 30, offset: 0, newestfirst: 1 });
        next.notifications = (nt.notifications || []).map((x) => ({
          id: x.id, subject: x.subject, text: x.smallmessage || x.subject, time: x.timecreated,
          read: !!x.read, url: x.contexturl, component: x.component,
        }));
      } catch {
        next.notifications = prev.notifications;
      }

      // Während des Abrufs ab- oder neu angemeldet? Dann gehören die Daten zur alten Sitzung.
      if (this.client !== c) return;

      // Dateiindex aufbauen
      next.files = this.buildFileIndex(next, prev);
      const newFiles = firstSync ? [] : Object.values(next.files).filter((f) => !prev.files[f.id]);
      for (const f of newFiles) next.newItems.unshift({ type: 'file', fileId: f.id, courseId: f.courseId, time: Date.now() });
      next.newItems = next.newItems.filter((x) => x.type !== 'file' || next.files[x.fileId]).slice(0, 100);

      next.lastSync = Date.now();
      this.cache = next;
      this.save();
      this.emit('updated');
      this.notifyChanges(newFiles);

      await this.downloadPending();
      this.setStatus({ state: 'idle', message: 'Synchronisiert', done: 0, total: 0 });
    } catch (e) {
      if (this.client !== c) return;
      this.cache.lastError = e.message;
      const offline = e.cause && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(String(e.cause.code || e.message));
      this.setStatus({ state: 'error', message: offline || /fetch failed/.test(e.message) ? 'Offline – zeige lokale Daten' : e.message });
      if (e.code === 'invalidtoken') this.emit('invalidtoken');
    } finally {
      this.running = false;
      if (this.client !== c) {
        // Neue Sitzung während dieses Laufs angemeldet – ihr erster Sync wurde übersprungen
        if (this.client) setImmediate(() => this.run());
        else this.setStatus({ state: 'idle', message: '', done: 0, total: 0 });
      }
    }
  }

  buildFileIndex(next, prev) {
    const files = {};
    const used = new Set();
    const add = (course, sectionLabel, mod, f, subdir) => {
      if (!f.fileurl || f.type === 'url') return;
      const id = sha(f.fileurl.split('?')[0]).slice(0, 12);
      if (files[id]) return;
      const old = prev.files[id];
      let local = old && old.localPath;
      if (!local) {
        const rel = (f.filepath || '/').split('/').filter(Boolean).map((p) => safeName(p));
        const dir = path.join(this.courseDir(course), sectionLabel, ...(subdir ? [safeName(subdir)] : []), ...rel);
        local = path.join(dir, safeName(f.filename, 120));
        let i = 2;
        while (used.has(local.toLowerCase())) {
          const ext = path.extname(f.filename);
          local = path.join(dir, `${safeName(path.basename(f.filename, ext), 110)} (${i++})${ext}`);
        }
      }
      used.add(local.toLowerCase());
      const changed = old && old.timemodified !== f.timemodified;
      files[id] = {
        id, courseId: course.id, cmid: mod.id, modname: mod.modname, moduleName: mod.name, section: sectionLabel,
        filename: f.filename, filepath: f.filepath, filesize: f.filesize, mimetype: f.mimetype,
        timemodified: f.timemodified, url: f.fileurl, localPath: local,
        downloaded: !!(old && old.downloaded && !changed && fs.existsSync(local)),
        updated: !!changed,
      };
    };

    for (const course of next.courses) {
      const sections = next.contents[course.id] || [];
      sections.forEach((s, idx) => {
        const label = safeName(`${String(idx).padStart(2, '0')} ${s.name || 'Abschnitt ' + s.section}`, 70);
        for (const m of s.modules) {
          if (m.modname === 'resource') {
            const multi = m.contents.filter((f) => f.type === 'file').length > 1;
            m.contents.forEach((f) => add(course, label, m, f, multi ? m.name : null));
          } else if (m.modname === 'folder') {
            m.contents.forEach((f) => add(course, label, m, f, m.name));
          } else if (m.modname === 'assign' && next.assignments[m.id]) {
            next.assignments[m.id].attachments.forEach((f) => add(course, label, m, f, m.name));
          }
        }
      });
    }
    // Datei-IDs an die Module hängen, damit die Oberfläche sie direkt findet
    const byUrl = {};
    for (const f of Object.values(files)) byUrl[f.url.split('?')[0]] = f.id;
    for (const sections of Object.values(next.contents)) {
      for (const s of sections) for (const m of s.modules) for (const f of m.contents) f.id = byUrl[(f.fileurl || '').split('?')[0]] || null;
    }
    for (const a of Object.values(next.assignments)) for (const f of a.attachments) f.id = byUrl[(f.fileurl || '').split('?')[0]] || null;
    return files;
  }

  async downloadPending() {
    const s = store.getSettings();
    if (!s.autoDownload) return;
    const max = (Number(s.maxFileSizeMB) || 200) * 1024 * 1024;
    const todo = Object.values(this.cache.files).filter((f) => !f.downloaded && (!f.filesize || f.filesize <= max));
    if (!todo.length) return;
    let done = 0;
    let lastSave = Date.now();
    this.setStatus({ state: 'downloading', message: `Lade ${todo.length} Dateien…`, done: 0, total: todo.length });
    const client = this.client;
    await pool(todo, 3, async (f) => {
      if (this.client !== client) return; // abgemeldet: restliche Downloads überspringen
      try {
        await client.download(f.url, f.localPath);
        if (f.timemodified) {
          const t = new Date(f.timemodified * 1000);
          fs.utimesSync(f.localPath, t, t);
        }
        f.downloaded = true;
        f.error = null;
      } catch (e) {
        f.error = e.message;
      }
      done++;
      this.setStatus({ message: `Lade Dateien… ${f.filename}`, done, total: todo.length });
      if (Date.now() - lastSave > 3000) {
        lastSave = Date.now();
        this.save();
        this.emit('files');
      }
    });
    if (this.client !== client) return;
    this.save();
    this.emit('files');
  }

  async ensureFile(fileId) {
    const f = this.cache && this.cache.files[fileId];
    if (!f) throw new Error('Datei unbekannt');
    if (f.downloaded && fs.existsSync(f.localPath)) return f;
    if (!this.client) throw new Error('Nicht angemeldet');
    await this.client.download(f.url, f.localPath);
    f.downloaded = true;
    f.error = null;
    this.save();
    this.emit('files');
    return f;
  }

  async cacheImage(url, key) {
    if (!url) return null;
    if (url.startsWith('data:')) return url;
    const dir = store.file(path.join('cache', 'img'));
    const dest = path.join(dir, `${sha(this.client.siteUrl).slice(0, 8)}-${key}`);
    try {
      const { buffer, type } = await this.client.fetchBuffer(url);
      if (!/^image\//.test(type)) return null;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dest, buffer);
      return require('url').pathToFileURL(dest).href + '?v=' + Date.now().toString(36);
    } catch {
      return fs.existsSync(dest) ? require('url').pathToFileURL(dest).href : null;
    }
  }

  notifyChanges(newFiles) {
    if (!store.getSettings().notifications) return;
    const notes = [];
    if (newFiles.length) {
      const byCourse = {};
      for (const f of newFiles) {
        const k = this.cache.courses.find((x) => x.id === f.courseId);
        const name = k ? k.shortname || k.fullname : 'Kurs';
        byCourse[name] = (byCourse[name] || 0) + 1;
      }
      notes.push({
        title: `${newFiles.length} neue Datei${newFiles.length > 1 ? 'en' : ''} in Moodle`,
        body: Object.entries(byCourse).map(([k, v]) => `${k}: ${v}`).join('\n'),
      });
    }
    const soon = Date.now() / 1000 + 2 * 86400;
    for (const e of this.cache.events) {
      if (e.timesort > Date.now() / 1000 && e.timesort < soon && !this.cache.notifiedEvents.includes(e.id)) {
        this.cache.notifiedEvents.push(e.id);
        notes.push({ title: 'Bald fällig: ' + (e.activityname || e.name), body: `${e.coursename}\n${new Date(e.timesort * 1000).toLocaleString('de-DE', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}` });
      }
    }
    this.cache.notifiedEvents = this.cache.notifiedEvents.slice(-300);
    this.save();
    for (const n of notes) this.emit('notify', n);
  }
}

module.exports = { SyncEngine, safeName };
