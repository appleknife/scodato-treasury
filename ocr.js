// Screenshot reader for Shop Titans item cards.
// Runs entirely in the browser with Tesseract.js (nothing is uploaded anywhere).
window.TroveOCR = (function () {
  const P = window.TROVE_OCR_PATHS || {};
  const LIB = P.lib || "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
  let workerP = null;
  let progressCb = null;

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = () => rej(new Error("Couldn't load the screenshot reader (check your internet)"));
      document.head.appendChild(s);
    });
  }
  async function getWorker() {
    if (!window.Tesseract) await loadScript(LIB);
    if (!workerP) {
      const opts = { logger: (m) => progressCb && progressCb(m) };
      if (P.worker) opts.workerPath = P.worker;
      if (P.core) opts.corePath = P.core;
      if (P.lang) opts.langPath = P.lang;
      workerP = Tesseract.createWorker("eng", 1, opts);
    }
    return workerP;
  }

  function loadImage(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("That file doesn't look like an image"));
      img.src = url;
    });
  }

  // ---------- fuzzy matching ----------
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  const norm = (s) => s.toLowerCase().replace(/[^a-z' ]/g, "").replace(/\s+/g, " ").trim();
  const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);
  function score(ocr, cand) {
    const a = norm(ocr), b = norm(cand);
    if (!a || !b) return 0;
    const cs = sim(a, b);
    const aw = a.split(" "), bw = b.split(" ");
    let hit = 0;
    aw.forEach((w) => { if (bw.some((x) => sim(w, x) >= 0.75)) hit++; });
    const ws = hit / Math.max(aw.length, bw.length);
    // also allow OCR that dropped the first letter(s) of a word ("oyager" -> "voyager")
    const sub = b.includes(a) && a.length >= 6 ? 0.9 : 0;
    return Math.max(0.5 * cs + 0.5 * ws, cs, sub);
  }
  function bestMatch(text, known) {
    let best = null, second = 0;
    for (const k of known) {
      const s = score(text, k);
      if (!best || s > best.s) { if (best) second = Math.max(second, best.s); best = { k, s }; }
      else second = Math.max(second, s);
    }
    if (best && best.s >= 0.5 && best.s - second >= 0.08) return { name: best.k, sure: best.s >= 0.8 };
    return null;
  }

  // ---------- helpers ----------
  const cxOf = (b) => (b.x0 + b.x1) / 2, cyOf = (b) => (b.y0 + b.y1) / 2;
  const VALUE_RE = /^\d{1,3}(?:[,.]\d{3})+$/;
  function countFrom(t) {
    let s = (t || "").trim().replace(/[×X✕]/g, "x");
    const m = s.match(/^[x](.{1,5})$/i);
    if (!m) return null;
    const digits = m[1].replace(/[\]|lI!]/g, "1").replace(/[Oo]/g, "0").replace(/S/g, "5").replace(/B/g, "8").replace(/[^0-9]/g, "");
    if (!digits) return null;
    const n = parseInt(digits, 10);
    return n > 0 && n < 100000 ? n : null;
  }
  function cleanName(words) {
    const toks = words.map((w) => w.text.replace(/^[^A-Za-z]+|[^A-Za-z'’]+$/g, ""));
    let i = 0;
    // drop leading junk (bits of the little item-type icon on the ribbon)
    while (i < toks.length && !(toks[i].length >= 3 && /^[A-Za-z'’-]+$/.test(toks[i]))) i++;
    const out = toks.slice(i).filter((t) => t.length >= 2 || /^[A-Z]$/.test(t));
    return out.join(" ").replace(/[’]/g, "'").trim();
  }
  function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

  function cropIcon(img, s, cx, top, size) {
    const S = 112;
    const c = document.createElement("canvas"); c.width = S; c.height = S;
    const g = c.getContext("2d");
    const x = Math.max(0, cx / s - size / s / 2), y = Math.max(0, top / s);
    g.drawImage(img, x, y, size / s, size / s, 0, 0, S, S);
    let url = c.toDataURL("image/webp", 0.85);
    if (!url.startsWith("data:image/webp")) url = c.toDataURL("image/jpeg", 0.85);
    return url;
  }

  // ---------- main ----------
  async function parse(blob, knownNames, onProgress) {
    progressCb = (m) => onProgress && onProgress(m.status, m.progress);
    const img = await loadImage(blob);
    const W = img.naturalWidth, H = img.naturalHeight;
    let s = Math.min(3, Math.max(1, 3000 / W));
    if (W * H * s * s > 14e6) s = Math.max(1, Math.sqrt(14e6 / (W * H)));
    const cv = document.createElement("canvas");
    cv.width = Math.round(W * s); cv.height = Math.round(H * s);
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, cv.width, cv.height);
    const color = g.getImageData(0, 0, cv.width, cv.height);
    // grayscale copy for OCR
    const gray = new ImageData(cv.width, cv.height);
    for (let i = 0; i < color.data.length; i += 4) {
      const v = 0.3 * color.data[i] + 0.59 * color.data[i + 1] + 0.11 * color.data[i + 2];
      gray.data[i] = gray.data[i + 1] = gray.data[i + 2] = v; gray.data[i + 3] = 255;
    }
    const gcv = document.createElement("canvas"); gcv.width = cv.width; gcv.height = cv.height;
    gcv.getContext("2d").putImageData(gray, 0, 0);

    const worker = await getWorker();
    await worker.setParameters({ tessedit_pageseg_mode: "11", tessedit_char_whitelist: "" });
    const { data } = await worker.recognize(gcv);
    const lines = data.lines || [];
    const words = data.words || [];

    // anchors: the gold "value" numbers under each card (very reliable), else item names
    const values = [];
    const names = [];
    for (const ln of lines) {
      const txt = ln.words.map((w) => w.text).join(" ");
      const num = ln.words.find((w) => VALUE_RE.test(w.text.replace(/[^\d,.]/g, "")) && w.text.replace(/[^\d]/g, "").length >= 4);
      if (num) { values.push({ bbox: num.bbox, value: parseInt(num.text.replace(/[^\d]/g, ""), 10) }); continue; }
      const nm = cleanName(ln.words);
      const letters = nm.replace(/[^A-Za-z]/g, "").length;
      if (letters >= 4 && !/^value$/i.test(nm) && !/^x\d/i.test(nm)) {
        const ws = ln.words.filter((w) => /[A-Za-z]{2,}/.test(w.text));
        const bb = ws.length ? { x0: Math.min(...ws.map((w) => w.bbox.x0)), x1: Math.max(...ws.map((w) => w.bbox.x1)), y0: Math.min(...ws.map((w) => w.bbox.y0)), y1: Math.max(...ws.map((w) => w.bbox.y1)) } : ln.bbox;
        names.push({ bbox: bb, text: nm, raw: txt });
      }
    }
    const lineH = median(names.map((n) => n.bbox.y1 - n.bbox.y0).concat(values.map((v) => v.bbox.y1 - v.bbox.y0))) || 20;

    // card width from spacing between neighbours on the same row
    function estWidth(anchors, fallback) {
      const gaps = [];
      anchors.forEach((a) => {
        let best = Infinity;
        anchors.forEach((b) => { if (a !== b && Math.abs(cyOf(a.bbox) - cyOf(b.bbox)) < lineH * 1.5) best = Math.min(best, Math.abs(cxOf(a.bbox) - cxOf(b.bbox))); });
        if (best < Infinity) gaps.push(best);
      });
      return median(gaps) || fallback;
    }

    const cards = [];
    if (values.length) {
      const w = estWidth(values, median(values.map((v) => v.bbox.x1 - v.bbox.x0)) * 1.75);
      const usedNames = new Set();
      for (const v of values) {
        const vx = cxOf(v.bbox) - lineH * 0.5; // number sits a bit right of centre (coin icon on its left)
        let nm = null, bestD = Infinity;
        names.forEach((n, i) => {
          if (usedNames.has(i)) return;
          const dy = v.bbox.y0 - n.bbox.y1, dx = Math.abs(cxOf(n.bbox) - vx);
          if (dy > 0 && dy < w * 0.75 && dx < w * 0.45 && dy + dx < bestD) { bestD = dy + dx; nm = i; }
        });
        if (nm != null) usedNames.add(nm);
        const n = nm != null ? names[nm] : null;
        cards.push({ cx: n ? cxOf(n.bbox) : vx, nameTop: n ? n.bbox.y0 : v.bbox.y0 - w * 0.5, raw: n ? n.text : "", value: v.value, w });
      }
    } else {
      const w = estWidth(names, lineH * 14);
      names.forEach((n) => cards.push({ cx: cxOf(n.bbox), nameTop: n.bbox.y0, raw: n.text, value: null, w }));
    }
    cards.sort((a, b) => (Math.abs(a.nameTop - b.nameTop) < lineH * 2 ? a.cx - b.cx : a.nameTop - b.nameTop));

    // counts ("x21") from the main pass
    const counts = words.map((w) => ({ n: countFrom(w.text), bbox: w.bbox })).filter((c) => c.n != null);
    const results = [];
    for (const c of cards) {
      const w = c.w;
      let best = null, bd = Infinity;
      counts.forEach((k) => {
        const kx = cxOf(k.bbox), ky = cyOf(k.bbox);
        if (kx > c.cx - w * 0.1 && kx < c.cx + w * 0.55 && ky < c.nameTop && ky > c.nameTop - w * 0.6) {
          const d = Math.abs(ky - (c.nameTop - w * 0.15)) + Math.abs(kx - (c.cx + w * 0.38));
          if (d < bd) { bd = d; best = k; }
        }
      });
      if (best) counts.splice(counts.indexOf(best), 1);
      let qty = best ? best.n : null, qtySure = !!best;
      if (qty == null) { qty = await readCount(worker, color, c, cv.width, cv.height); qtySure = qty != null; }
      const m = c.raw ? bestMatch(c.raw, knownNames || []) : null;
      const size = w * 0.5;
      results.push({
        name: m ? m.name : c.raw,
        rawName: c.raw,
        nameSure: !!(m && m.sure),
        qty: qty || 1,
        qtySure,
        value: c.value,
        icon: cropIcon(img, s, c.cx, Math.max(0, c.nameTop - w * 0.1 - size), size)
      });
    }
    await worker.setParameters({ tessedit_pageseg_mode: "11", tessedit_char_whitelist: "" });
    return results;
  }

  // second try at a count badge: crop the spot, keep only white text, read with a digits whitelist
  async function readCount(worker, color, c, CW, CH) {
    const w = c.w;
    const x0 = Math.max(0, Math.round(c.cx + w * 0.12)), x1 = Math.min(CW, Math.round(c.cx + w * 0.54));
    const y0 = Math.max(0, Math.round(c.nameTop - w * 0.4)), y1 = Math.min(CH, Math.round(c.nameTop - w * 0.02));
    if (x1 - x0 < 8 || y1 - y0 < 8) return null;
    const k = Math.max(1, 90 / (y1 - y0));
    const out = document.createElement("canvas");
    out.width = Math.round((x1 - x0) * k) + 40; out.height = Math.round((y1 - y0) * k) + 40;
    const og = out.getContext("2d");
    const tmp = new ImageData(x1 - x0, y1 - y0);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * CW + x) * 4, j = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
      const r = color.data[i], gg = color.data[i + 1], b = color.data[i + 2];
      const v = r > 195 && gg > 195 && b > 195 ? 0 : 255;
      tmp.data[j] = tmp.data[j + 1] = tmp.data[j + 2] = v; tmp.data[j + 3] = 255;
    }
    const t = document.createElement("canvas"); t.width = tmp.width; t.height = tmp.height; t.getContext("2d").putImageData(tmp, 0, 0);
    og.fillStyle = "#fff"; og.fillRect(0, 0, out.width, out.height);
    og.drawImage(t, 20, 20, out.width - 40, out.height - 40);
    await worker.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: "x0123456789" });
    const { data } = await worker.recognize(out);
    const txt = (data.text || "").replace(/\s+/g, "");
    const m = txt.match(/x(\d{1,5})/i);
    return m ? parseInt(m[1], 10) || null : null;
  }

  return { parse, bestMatch };
})();
