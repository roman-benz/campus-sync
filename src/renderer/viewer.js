// PDF-Viewer auf Basis von pdf.js: Seiten werden erst beim Hinscrollen gerendert,
// mit markierbarem Text, Suchtreffer-Hervorhebung und Zoom.
import * as pdfjs from '../../node_modules/pdfjs-dist/build/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

const norm = (s) =>
  String(s || '').toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').normalize('NFD').replace(/[̀-ͯ]/g, '');

export async function openPdf(host, { data, page = 1, zoom = 'fit', terms = [], onPage, onSelection, onZoom }) {
  const res = (p) => new URL(`../../node_modules/pdfjs-dist/${p}/`, import.meta.url).href;
  const task = pdfjs.getDocument({
    data, isEvalSupported: false, enableXfa: false,
    cMapUrl: res('cmaps'), cMapPacked: true, standardFontDataUrl: res('standard_fonts'), wasmUrl: res('wasm'),
  });
  const doc = await task.promise;
  const scroller = host;
  const wrap = document.createElement('div');
  wrap.className = 'pdf-pages';
  scroller.appendChild(wrap);

  const first = await doc.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  let scale = 1;
  let hlTerms = terms.map(norm).filter(Boolean);
  const pages = [];
  let current = 1;
  let destroyed = false;

  const MIN_SCALE = 0.3;
  const MAX_SCALE = 5;
  const fitScale = () => Math.max(0.4, Math.min(3, (scroller.clientWidth - 48) / base.width));
  const setScale = (z) => {
    scale = z === 'fit' ? fitScale() : Math.max(MIN_SCALE, Math.min(MAX_SCALE, z));
  };
  setScale(zoom);

  for (let n = 1; n <= doc.numPages; n++) {
    const el = document.createElement('div');
    el.className = 'pdf-page';
    el.dataset.page = n;
    el.innerHTML = `<div class="pdf-ph">${n}</div>`;
    wrap.appendChild(el);
    pages.push({ n, el, size: null, rendered: 0, task: null });
  }

  function layout() {
    for (const p of pages) {
      const w = (p.size ? p.size.width : base.width) * scale;
      const h = (p.size ? p.size.height : base.height) * scale;
      p.el.style.width = `${Math.floor(w)}px`;
      p.el.style.height = `${Math.floor(h)}px`;
      p.el.style.setProperty('--scale-factor', scale);
      p.el.style.setProperty('--total-scale-factor', scale);
    }
  }
  layout();

  async function render(p) {
    if (destroyed || zooming || p.rendered === scale || p.task) return;
    const target = scale;
    p.task = (async () => {
      const pg = await doc.getPage(p.n);
      if (!p.size) {
        const v1 = pg.getViewport({ scale: 1 });
        p.size = { width: v1.width, height: v1.height };
        layout();
      }
      const vp = pg.getViewport({ scale: target });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      await pg.render({ canvas, viewport: vp, ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : {}) }).promise;
      const tl = document.createElement('div');
      tl.className = 'textLayer';
      const layer = new pdfjs.TextLayer({ textContentSource: await pg.getTextContent(), container: tl, viewport: vp });
      await layer.render();
      if (destroyed || target !== scale) return;
      p.el.replaceChildren(canvas, tl);
      p.rendered = target;
      highlight(p);
    })().catch(() => {}).finally(() => {
      p.task = null;
      if (!destroyed && p.rendered !== scale && isNear(p)) render(p);
    });
  }

  function highlight(p) {
    const spans = p.el.querySelectorAll('.textLayer span');
    spans.forEach((s) => {
      const t = norm(s.textContent);
      s.classList.toggle('hit', hlTerms.length > 0 && hlTerms.some((term) => t.includes(term)));
    });
  }

  const isNear = (p) => {
    const r = p.el.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    return r.bottom > sr.top - sr.height && r.top < sr.bottom + sr.height;
  };

  const io = new IntersectionObserver(
    (entries) => entries.forEach((e) => e.isIntersecting && render(pages[Number(e.target.dataset.page) - 1])),
    { root: scroller, rootMargin: '120% 0px' }
  );
  pages.forEach((p) => io.observe(p.el));

  function onScroll() {
    const mid = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
    let best = current;
    for (const p of pages) {
      const r = p.el.getBoundingClientRect();
      if (r.top <= mid && r.bottom >= mid) {
        best = p.n;
        break;
      }
    }
    if (best !== current) {
      current = best;
      onPage && onPage(current, doc.numPages);
    }
  }
  scroller.addEventListener('scroll', onScroll, { passive: true });

  function onMouseUp() {
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (!text || !wrap.contains(sel.anchorNode)) return onSelection && onSelection(null);
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const pageEl = sel.anchorNode.parentElement && sel.anchorNode.parentElement.closest('.pdf-page');
      onSelection && onSelection({ text, rect, page: pageEl ? Number(pageEl.dataset.page) : current });
    }, 10);
  }
  wrap.addEventListener('mouseup', onMouseUp);

  let resizeTimer = null;
  let renderTimer = null;
  let zoomMode = zoom;

  // Zoom läuft über requestAnimationFrame: höchstens ein Layout pro Frame, die Textebene ist
  // währenddessen ausgeblendet, und die Seiten werden erst nach dem Zoomen scharf neu gerendert.
  let zooming = false;
  let zoomFrame = 0;
  let zoomTarget = scale;
  let zoomPoint = null;
  let zoomAnim = null;
  let zoomAnchor = null;

  // Neu rendern erst, wenn das Zoomen kurz pausiert – bis dahin wird das alte Bild skaliert
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      zooming = false;
      zoomAnchor = null;
      wrap.classList.remove('zooming');
      pages.forEach((p) => isNear(p) && render(p));
    }, 160);
  }

  // Merkt sich, welche Stelle welcher Seite unter dem Bildschirmpunkt liegt
  function anchorAt(cx, cy) {
    let p = pages[pages.length - 1];
    for (const q of pages) if (cy <= q.el.getBoundingClientRect().bottom + 7) { p = q; break; }
    const r = p.el.getBoundingClientRect();
    return { el: p.el, cx, cy, fx: (cx - r.left) / r.width, fy: (cy - r.top) / r.height };
  }

  // Skala setzen und so scrollen, dass die Stelle unter dem Zoompunkt exakt stehen bleibt
  function applyScale(next) {
    const { cx, cy } = zoomPoint;
    let a = zoomAnchor && zoomAnchor.cx === cx && zoomAnchor.cy === cy ? zoomAnchor : null;
    if (a) {
      const r = a.el.getBoundingClientRect();
      if (Math.abs(r.top + a.fy * r.height - cy) > 2) a = null; // zwischendurch gescrollt
      // waagerecht kann die Zentrierung schmaler Seiten den Punkt verschieben
      else if (Math.abs(r.left + a.fx * r.width - cx) > 2) a.fx = (cx - r.left) / r.width;
    }
    if (!a) a = zoomAnchor = anchorAt(cx, cy);
    scale = next;
    layout();
    const r = a.el.getBoundingClientRect();
    scroller.scrollLeft += r.left + a.fx * r.width - cx;
    scroller.scrollTop += r.top + a.fy * r.height - cy;
    onZoom && onZoom(scale);
  }

  function zoomTick(now) {
    zoomFrame = 0;
    let next = zoomTarget;
    if (zoomAnim) {
      const t = Math.max(0, Math.min(1, (now - zoomAnim.t0) / zoomAnim.dur));
      const e = 1 - Math.pow(1 - t, 3);
      // logarithmisch interpolieren, damit Vergrößern und Verkleinern gleich schnell wirken
      next = zoomAnim.from * Math.pow(zoomTarget / zoomAnim.from, e);
      if (t < 1) zoomFrame = requestAnimationFrame(zoomTick);
      else zoomAnim = null;
    }
    if (Math.abs(next - scale) > 1e-4) applyScale(next);
    scheduleRender();
  }

  // Zoomen um einen Bildschirmpunkt (ohne Punkt: Mitte der Ansicht)
  function zoomTo(z, cx, cy, animate) {
    zoomTarget = Math.max(MIN_SCALE, Math.min(MAX_SCALE, z));
    if (cx == null) {
      const sr = scroller.getBoundingClientRect();
      cx = sr.left + sr.width / 2;
      cy = sr.top + sr.height / 2;
    }
    zoomPoint = { cx, cy };
    // t0 einen Frame vorverlegt: schon der erste Frame bewegt sich, auch wenn eine Raste eine laufende Animation ablöst
    zoomAnim = animate ? { from: scale, t0: performance.now() - 16, dur: 220 } : null;
    if (!zooming) {
      zooming = true;
      wrap.classList.add('zooming');
    }
    clearTimeout(renderTimer);
    if (!zoomFrame) zoomFrame = requestAnimationFrame(zoomTick);
  }

  // Strg + Mausrad bzw. Touchpad-Pinch (kommt als wheel mit ctrlKey). Mausrad-Rasten werden
  // weich animiert, die feinen Pinch-Schritte direkt umgesetzt; beides addiert sich zum Ziel.
  function onWheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const step = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    const from = zoomFrame ? zoomTarget : scale;
    zoomMode = 'custom';
    zoomTo(from * Math.exp(-step * 0.0018), e.clientX, e.clientY, Math.abs(step) >= 40);
  }
  scroller.addEventListener('wheel', onWheel, { passive: false });
  const ro = new ResizeObserver(() => {
    if (zoomMode !== 'fit' || !scroller.clientWidth) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => api.setZoom('fit', false), 150);
  });
  ro.observe(scroller);

  const api = {
    numPages: doc.numPages,
    get page() { return current; },
    get scale() { return scale; },
    goTo(n, smooth = false) {
      const p = pages[Math.max(1, Math.min(doc.numPages, n)) - 1];
      scroller.scrollTo({ top: p.el.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
      current = p.n;
      onPage && onPage(current, doc.numPages);
    },
    zoomBy(f) {
      zoomMode = 'custom';
      zoomTo((zoomFrame ? zoomTarget : scale) * f, null, null, true);
      return zoomTarget;
    },
    setZoom(z, animate = true) {
      zoomMode = z;
      zoomTo(z === 'fit' ? fitScale() : z, null, null, animate);
      return zoomTarget;
    },
    highlight(terms) {
      hlTerms = (terms || []).map(norm).filter(Boolean);
      pages.forEach((p) => p.rendered && highlight(p));
    },
    destroy() {
      destroyed = true;
      io.disconnect();
      ro.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('wheel', onWheel);
      clearTimeout(renderTimer);
      clearTimeout(resizeTimer);
      cancelAnimationFrame(zoomFrame);
      task.destroy();
    },
  };
  if (page > 1) requestAnimationFrame(() => api.goTo(page));
  return api;
}
