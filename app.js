(function () {
  const API = window.TroveAPI;
  const CFG = Object.assign({ TITLE: "Scodato's Treasury", SUBTITLE: "Guild donation board", DONOR: "Scodato" }, window.TROVE_CONFIG || {});
  const DONOR = CFG.DONOR;
  const RARITIES = ["legendary", "epic", "flawless", "uncommon", "common"];
  const RLABEL = { common: "Common", uncommon: "Uncommon", flawless: "Flawless", epic: "Epic", legendary: "Legendary" };
  const app = document.getElementById("app");

  // ---------- local storage helpers ----------
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  const ss = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) {} }
  };

  const state = {
    data: null,
    error: null,
    tab: (location.hash || "").replace("#", "") || "treasury",
    adminTab: "requests",
    pw: ss.get("trove.pw") || ls.get("trove.pw", null),
    mine: ls.get("trove.mine", []), // [{id, token}]
    form: Object.assign({ player: "", building: "", invested: "", note: "" }, ls.get("trove.form", {})),
    open: {},      // admin: which pending request has its picker open
    picks: {},     // admin: {reqId: {itemId: qty}}
    notes: {},     // admin: {reqId: note}
    imp: null,     // admin: screenshot import state
    impMode: "set",
    search: "",
    newItem: { name: "", rarity: "legendary", qty: "1" },
    busy: false
  };
  if (!["treasury", "request", "board", "admin"].includes(state.tab)) state.tab = "treasury";

  // ---------- small utils ----------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const rclass = (r) => "r-" + (RLABEL[r] ? r : "legendary");
  function parseAmt(v) {
    if (v == null) return NaN;
    const s = String(v).trim().toLowerCase().replace(/[, _]/g, "");
    const m = s.match(/^(\d+(?:\.\d+)?)([kmbt]|g)?$/);
    if (!m) return NaN;
    const mult = { k: 1e3, m: 1e6, b: 1e9, g: 1e9, t: 1e12 }[m[2]] || 1;
    return Math.round(parseFloat(m[1]) * mult);
  }
  function fmtAmt(n) {
    n = Number(n) || 0;
    if (n < 10000) return n.toLocaleString();
    const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];
    for (const [v, u] of units) if (n >= v) { const x = n / v; return (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)).replace(/\.?0+$/, "") + u; }
    return String(n);
  }
  function ago(t) {
    if (!t) return "";
    const s = (Date.now() - new Date(t).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function token() { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join(""); }
  let toastT;
  function toast(msg, err) {
    const t = document.getElementById("toast");
    t.textContent = msg; t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast" + (err ? " err" : "")), err ? 4200 : 2600);
  }
  function iconHTML(it, size) {
    const cls = "icon-wrap " + (size || "") + " " + rclass(it.rarity);
    const inner = it.icon ? `<img src="${esc(it.icon)}" alt="" loading="lazy">` : `<div class="noimg">${esc((it.name || "?").trim().charAt(0).toUpperCase())}</div>`;
    return `<div class="${cls}">${inner}</div>`;
  }
  function rarityTag(r) { return `<span class="rarity ${rclass(r)}">${RLABEL[r] || "Legendary"}</span>`; }
  function allocsHTML(allocs) {
    return `<div class="alloc-list">${(allocs || []).map((a) => `<span class="alloc ${rclass(a.rarity)}">${iconHTML(a, "xs")}<span class="alloc-txt"><span><b>${a.qty}×</b> ${esc(a.name)}</span>${rarityTag(a.rarity)}</span></span>`).join("")}</div>`;
  }

  // ---------- derived data ----------
  const D = () => state.data || { items: [], requests: [], buildings: [], knownNames: [], stats: {} };
  const byStatus = (st) => D().requests.filter((r) => r.status === st);
  function pendingRanked() {
    return byStatus("pending").sort((a, b) => Number(a.invested) - Number(b.invested) || new Date(a.created_at) - new Date(b.created_at));
  }
  function reservedMap() {
    const m = {};
    byStatus("approved").forEach((r) => (r.allocations || []).forEach((a) => (m[a.item_id] = (m[a.item_id] || 0) + a.qty)));
    return m;
  }
  const isMine = (id) => state.mine.some((m) => m.id === id);
  const myToken = (id) => (state.mine.find((m) => m.id === id) || {}).token;
  function sortItems(items) {
    return [...items].sort((a, b) => (b.qty > 0) - (a.qty > 0) || RARITIES.indexOf(a.rarity) - RARITIES.indexOf(b.rarity) || a.name.localeCompare(b.name));
  }

  // ---------- loading ----------
  async function load(quiet) {
    try {
      state.data = await API.load();
      state.error = null;
      // forget my requests that are finished or gone
      const keep = state.mine.filter((m) => D().requests.some((r) => r.id === m.id && ["pending", "approved", "denied"].includes(r.status)));
      if (keep.length !== state.mine.length) { state.mine = keep; ls.set("trove.mine", keep); }
    } catch (e) {
      state.error = e.message || String(e);
      if (!quiet) toast("Couldn't reach the board: " + state.error, true);
    }
    safeRender();
  }
  function safeRender() {
    const a = document.activeElement;
    if (a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { pendingRender = true; return; }
    render();
  }
  let pendingRender = false;
  document.addEventListener("focusout", () => setTimeout(() => {
    if (!pendingRender) return;
    const a = document.activeElement;
    if (a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    pendingRender = false; render();
  }, 150));
  setInterval(() => { if (!document.hidden && !state.busy && !(state.imp && state.imp.reading)) load(true); }, 20000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(true); });

  async function run(fn, okMsg) {
    if (state.busy) return;
    state.busy = true;
    document.body.style.cursor = "progress";
    try { await fn(); if (okMsg) toast(okMsg); await load(true); }
    catch (e) {
      const msg = e.message || String(e);
      toast(msg, true);
      if (/wrong password/i.test(msg)) { logout(); }
    }
    finally { state.busy = false; document.body.style.cursor = ""; }
  }

  // ---------- render ----------
  function render() {
    if (!state.data && !state.error) return;
    const d = D();
    const avail = d.items.reduce((s, i) => s + (i.qty || 0), 0);
    const pend = byStatus("pending").length;
    const html = `
      <header class="header">
        <div class="crest"></div>
        <div class="title-banner"><h1>${esc(CFG.TITLE)}</h1></div>
        <div class="subtitle">${esc(CFG.SUBTITLE)}</div>
        <div class="stats">
          <div class="stat"><span class="coin"></span><b>${avail}</b> items in the treasury</div>
          <div class="stat"><span class="coin"></span><b>${d.stats.items_donated || 0}</b> donated so far</div>
          <div class="stat"><span class="coin"></span><b>${pend}</b> waiting</div>
        </div>
      </header>
      <nav class="tabs" role="tablist">
        ${tabBtn("treasury", "Treasury")}
        ${tabBtn("request", "Request")}
        ${tabBtn("board", "Board")}
        ${tabBtn("admin", DONOR + " 🔒", state.pw && pend ? pend : 0)}
      </nav>
      ${API.mode === "demo" ? `<div class="notice demo"><b>Demo mode:</b> nothing is shared yet — everything saves only in this browser. ${esc(DONOR)}'s demo password is <b>demo</b>. Connect Supabase in <code>config.js</code> to go live.</div>` : ""}
      ${state.error ? `<div class="notice">Having trouble reaching the board (${esc(state.error)}). Retrying…</div>` : ""}
      ${state.tab !== "admin" ? spotlights() : ""}
      <main>${state.tab === "treasury" ? treasuryView() : state.tab === "request" ? requestView() : state.tab === "board" ? boardView() : adminView()}</main>
      <footer class="footer">Made for the guild · items are donated in-game through guild requests · fan-made, not affiliated with Kabam / Shop Titans</footer>`;
    app.innerHTML = html;
  }
  function tabBtn(id, label, pip) {
    return `<button class="tab" role="tab" aria-selected="${state.tab === id}" data-act="tab" data-id="${id}">${esc(label)}${pip ? `<span class="pip">${pip}</span>` : ""}</button>`;
  }

  function spotlights() {
    const order = { approved: 0, denied: 1, pending: 2 };
    const mine = D().requests.filter((r) => isMine(r.id) && ["pending", "approved", "denied"].includes(r.status)).sort((a, b) => order[a.status] - order[b.status]);
    if (!mine.length) return "";
    const ranked = pendingRanked();
    return mine.map((r) => {
      if (r.status === "approved") return `
        <section class="spot approved">
          <h3 class="gtext">${esc(DONOR)} approved your request!</h3>
          <div class="big-instr">In Shop Titans, put up a <b>guild request</b> for:</div>
          ${allocsHTML(r.allocations)}
          ${r.admin_note ? `<div class="req-note">“${esc(r.admin_note)}” — ${esc(DONOR)}</div>` : ""}
          <div class="hint">For your <b>${esc(r.building)}</b> investment. Once ${esc(DONOR)} has filled it in game, tap Done.</div>
          <div class="btn-row" style="margin-top:10px"><button class="btn green" data-act="mark-done" data-id="${r.id}">Done in game ✓</button></div>
        </section>`;
      if (r.status === "pending") {
        const pos = ranked.findIndex((x) => x.id === r.id) + 1;
        return `
        <section class="spot pending">
          <h3 class="gtext">Your request is #${pos} in line</h3>
          <div class="big-instr">${esc(r.building)} · ${fmtAmt(r.invested)} invested · sent ${ago(r.created_at)}. ${esc(DONOR)} will pick your items — check back here.</div>
          <div class="btn-row" style="margin-top:8px"><button class="btn sm wood" data-act="cancel-mine" data-id="${r.id}">Cancel request</button></div>
        </section>`;
      }
      return `
        <section class="spot denied">
          <h3 class="gtext">Not this time</h3>
          <div class="big-instr">Your ${esc(r.building)} request wasn't approved${r.admin_note ? `: “${esc(r.admin_note)}”` : "."}</div>
          <div class="btn-row" style="margin-top:8px"><button class="btn sm wood" data-act="cancel-mine" data-id="${r.id}">OK, hide this</button></div>
        </section>`;
    }).join("");
  }

  function itemCard(it, reserved) {
    return `<div class="icard ${rclass(it.rarity)} ${it.qty > 0 ? "" : "out"}">
      <div style="position:relative;width:92px;margin:0 auto">${iconHTML(it)}<div class="qty-badge">x${it.qty}</div></div>
      <div class="ribbon"><span>${esc(it.name)}</span></div>
      ${rarityTag(it.rarity)}
      ${it.qty <= 0 ? `<div class="small" style="margin-top:4px;color:#f3c9dc">All given out</div>` : reserved ? `<div class="small" style="margin-top:4px;color:#f3c9dc">+${reserved} promised</div>` : ""}
    </div>`;
  }

  function treasuryView() {
    const d = D();
    const res = reservedMap();
    let items = sortItems(d.items);
    const q = state.search.trim().toLowerCase();
    if (q) items = items.filter((i) => i.name.toLowerCase().includes(q));
    return `<section class="panel">
      <div class="panel-head">
        <h2 class="gtext">The Treasury</h2>
        <button class="btn" data-act="tab" data-id="request">Ask for items →</button>
      </div>
      <p class="muted" style="margin-top:-6px">What ${esc(DONOR)} has ready to donate. Sell them and invest the gold into a guild building — lower current investment gets priority.</p>
      ${d.items.length > 10 ? `<input type="search" placeholder="Search items…" value="${esc(state.search)}" data-bind="search" style="margin-bottom:14px">` : ""}
      ${items.length ? `<div class="item-grid">${items.map((i) => itemCard(i, res[i.id])).join("")}</div>`
        : `<div class="empty"><span class="gtext">The vault is empty… for now</span>${esc(DONOR)} hasn't posted any items yet.</div>`}
    </section>`;
  }

  function requestView() {
    const d = D();
    const f = state.form;
    const blds = d.buildings || [];
    return `<section class="panel">
      <div class="panel-head"><h2 class="gtext">Request a donation</h2></div>
      <form data-form="request" autocomplete="off">
        <div class="form-grid">
          <label class="field"><span>Your in-game name</span>
            <input name="player" maxlength="40" required value="${esc(f.player)}" data-bind="form.player" placeholder="e.g. ShopKeeperSam"></label>
          <label class="field"><span>Building you'll invest in</span>
            <select name="building" required data-bind="form.building">
              <option value="">Pick a building…</option>
              ${blds.map((b) => `<option ${b === f.building ? "selected" : ""}>${esc(b)}</option>`).join("")}
            </select></label>
        </div>
        <label class="field"><span>Your current investment in that building</span>
          <input name="invested" inputmode="decimal" required value="${esc(f.invested)}" data-bind="form.invested" placeholder="e.g. 12 or 1.5B">
          <div class="hint">Copy it from the building's invest screen. You can type 1.5K / 2M / 3B. The lower it is, the more the guild gains — so lower goes first in line.</div></label>
        <label class="field"><span>Note for ${esc(DONOR)} <span class="muted small">(optional)</span></span>
          <textarea name="note" maxlength="200" data-bind="form.note" placeholder="Anything he should know?">${esc(f.note)}</textarea></label>
        <button class="btn block" type="submit">Send request</button>
      </form>
    </section>
    <section class="panel">
      <div class="panel-head"><h2 class="gtext">How it works</h2></div>
      <ol class="muted" style="margin:0;padding-left:20px;line-height:1.7">
        <li>Send a request with your building and current investment.</li>
        <li>${esc(DONOR)} approves it and picks which items (and how many) you get.</li>
        <li>Come back here — you'll see exactly what to put up as a <b>guild request</b> in game.</li>
        <li>After ${esc(DONOR)} fills it, sell the items, invest the gold, and tap <b>Done</b>.</li>
      </ol>
    </section>`;
  }

  function reqCard(r, ctx) {
    const ranked = ctx.ranked || [];
    const pos = r.status === "pending" ? ranked.findIndex((x) => x.id === r.id) + 1 : 0;
    const badge = r.status === "pending" ? "#" + pos : r.status === "approved" ? "✓" : r.status === "denied" ? "✕" : "★";
    const mine = isMine(r.id);
    let actions = "";
    if (ctx.admin) {
      if (r.status === "pending") actions = `<button class="btn sm green" data-act="adm-toggle" data-id="${r.id}">${state.open[r.id] ? "Close" : "Approve…"}</button><button class="btn sm red" data-act="adm-deny" data-id="${r.id}">Deny</button>`;
      else if (r.status === "approved") actions = `<button class="btn sm blue" data-act="mark-done" data-id="${r.id}">Done ✓</button><button class="btn sm wood" data-act="adm-undo" data-id="${r.id}">Undo</button>`;
      else if (r.status === "denied") actions = `<button class="btn sm wood" data-act="adm-undo" data-id="${r.id}">Undo deny</button>`;
    } else {
      if (r.status === "approved") actions = `<button class="btn sm green" data-act="mark-done" data-id="${r.id}">Done ✓</button>`;
      if (mine && r.status === "pending") actions += `<button class="btn sm wood" data-act="cancel-mine" data-id="${r.id}">Cancel</button>`;
    }
    return `<article class="req ${mine ? "mine" : ""}">
      <div class="rank st-${r.status}">${badge}</div>
      <div class="req-main">
        <div class="req-who">${esc(r.player)}${mine ? ` <span class="chip" style="vertical-align:3px">you</span>` : ""}</div>
        <div class="req-meta">
          <span class="chip bld">${esc(r.building)}</span>
          <span class="chip"><span class="coin" style="width:15px;height:15px;vertical-align:-2px"></span>${fmtAmt(r.invested)} invested</span>
          ${pos === 1 ? `<span class="chip best">Lowest investment — next up</span>` : ""}
          <span class="chip">${r.status === "done" ? "finished " + ago(r.done_at) : r.status === "denied" ? "denied " + ago(r.decided_at) : r.status === "approved" ? "approved " + ago(r.decided_at) : "asked " + ago(r.created_at)}</span>
        </div>
        ${r.note ? `<div class="req-note">“${esc(r.note)}”</div>` : ""}
        ${r.status === "approved" || r.status === "done" ? `${r.status === "approved" ? `<div class="small" style="margin-top:8px">Guild request in game for:</div>` : ""}${allocsHTML(r.allocations)}` : ""}
        ${r.admin_note && r.status !== "pending" ? `<div class="req-note">${esc(DONOR)}: “${esc(r.admin_note)}”</div>` : ""}
      </div>
      <div class="req-actions">${actions}</div>
      ${ctx.admin && r.status === "pending" && state.open[r.id] ? picker(r) : ""}
      ${ctx.admin && r.status === "pending" && !state.open[r.id] ? `<div style="grid-column:1/-1"><input placeholder="Reason / note (optional, shown to them)" data-bind="notes.${r.id}" value="${esc(state.notes[r.id] || "")}" style="padding:7px 10px;border-width:2px"></div>` : ""}
    </article>`;
  }

  function boardView() {
    const ranked = pendingRanked();
    const approved = byStatus("approved").sort((a, b) => new Date(b.decided_at) - new Date(a.decided_at));
    const recent = D().requests.filter((r) => r.status === "done" || r.status === "denied").sort((a, b) => new Date(b.done_at || b.decided_at) - new Date(a.done_at || a.decided_at)).slice(0, 12);
    return `<section class="panel">
      <div class="panel-head"><h2 class="gtext">Approved — go request in game</h2></div>
      ${approved.length ? `<div class="req-list">${approved.map((r) => reqCard(r, {})).join("")}</div>` : `<div class="empty">Nothing approved right now.</div>`}
    </section>
    <section class="panel">
      <div class="panel-head"><h2 class="gtext">Waiting for ${esc(DONOR)}</h2><button class="btn sm" data-act="tab" data-id="request">+ New request</button></div>
      <p class="muted small" style="margin-top:-6px">Lined up by lowest current investment first.</p>
      ${ranked.length ? `<div class="req-list">${ranked.map((r) => reqCard(r, { ranked })).join("")}</div>` : `<div class="empty"><span class="gtext">No one in line</span>Be the first!</div>`}
    </section>
    ${recent.length ? `<section class="panel"><div class="panel-head"><h2 class="gtext">Recently finished</h2></div><div class="req-list">${recent.map((r) => reqCard(r, {})).join("")}</div></section>` : ""}`;
  }

  // ---------- admin ----------
  function adminView() {
    if (!state.pw) return `<section class="panel" style="max-width:460px;margin:0 auto 22px">
      <div class="panel-head"><h2 class="gtext">${esc(DONOR)}'s vault</h2></div>
      <form data-form="login">
        <label class="field"><span>Password</span><input type="password" name="pw" required autocomplete="current-password"></label>
        <label style="display:flex;gap:8px;align-items:center;margin-bottom:14px"><input type="checkbox" name="remember" class="check" style="width:22px"> Remember me on this device</label>
        <button class="btn block" type="submit">Open the vault</button>
      </form>
    </section>`;
    const pend = byStatus("pending").length;
    const sub = (id, label) => `<button class="btn sm" aria-selected="${state.adminTab === id}" data-act="atab" data-id="${id}">${label}</button>`;
    return `<div class="subtabs">
        ${sub("requests", "Requests" + (pend ? ` (${pend})` : ""))}${sub("items", "My items")}${sub("settings", "Settings")}
        <span style="flex:1"></span><button class="btn sm wood" data-act="logout">Lock</button>
      </div>
      ${state.adminTab === "requests" ? adminRequests() : state.adminTab === "items" ? adminItems() : adminSettings()}`;
  }

  function adminRequests() {
    const ranked = pendingRanked();
    const approved = byStatus("approved");
    const denied = byStatus("denied");
    return `<section class="panel">
      <div class="panel-head"><h2 class="gtext">Waiting for you</h2></div>
      <p class="muted small" style="margin-top:-6px">Lowest current investment first. Approve to choose items — they're set aside right away so nobody else gets promised the same ones.</p>
      ${ranked.length ? `<div class="req-list">${ranked.map((r) => reqCard(r, { ranked, admin: true })).join("")}</div>` : `<div class="empty"><span class="gtext">All caught up</span>No new requests.</div>`}
    </section>
    <section class="panel">
      <div class="panel-head"><h2 class="gtext">Approved — waiting on the game</h2></div>
      <p class="muted small" style="margin-top:-6px">Tap Done after you've filled their guild request (they can tap it too). Undo puts the items back.</p>
      ${approved.length ? `<div class="req-list">${approved.map((r) => reqCard(r, { admin: true })).join("")}</div>` : `<div class="empty">Nothing waiting.</div>`}
    </section>
    ${denied.length ? `<section class="panel"><div class="panel-head"><h2 class="gtext">Recently denied</h2></div><div class="req-list">${denied.map((r) => reqCard(r, { admin: true })).join("")}</div></section>` : ""}`;
  }

  function picker(r) {
    const items = sortItems(D().items).filter((i) => i.qty > 0);
    const p = state.picks[r.id] || {};
    if (!items.length) return `<div class="picker">Your treasury is empty — add items under <b>My items</b> first.</div>`;
    const total = Object.values(p).reduce((s, n) => s + (n || 0), 0);
    return `<div class="picker">
      <div class="gtext" style="font-size:17px;color:var(--wood);margin-bottom:6px">What should ${esc(r.player)} request?</div>
      ${items.map((i) => `<div class="pick-row">
        ${iconHTML(i, "sm")}
        <div><div class="pick-name">${esc(i.name)}</div>${rarityTag(i.rarity)} <span class="small muted">· ${i.qty} left</span></div>
        <div class="stepper">
          <button type="button" data-act="adm-step" data-id="${r.id}" data-item="${i.id}" data-d="-1" aria-label="less">−</button>
          <input inputmode="numeric" value="${p[i.id] || 0}" data-pick="${r.id}" data-item="${i.id}" data-max="${i.qty}" aria-label="amount of ${esc(i.name)}">
          <button type="button" data-act="adm-step" data-id="${r.id}" data-item="${i.id}" data-d="1" aria-label="more">+</button>
        </div></div>`).join("")}
      <input placeholder="Message to them (optional)" data-bind="notes.${r.id}" value="${esc(state.notes[r.id] || "")}" style="margin-top:10px">
      <div class="btn-row" style="margin-top:10px;justify-content:flex-end">
        <span class="muted small">${total} item${total === 1 ? "" : "s"} picked</span>
        <button class="btn green" data-act="adm-approve" data-id="${r.id}" ${total ? "" : "disabled"}>Approve ✓</button>
      </div>
    </div>`;
  }

  function adminItems() {
    const d = D();
    const res = reservedMap();
    const imp = state.imp;
    let impHTML = "";
    if (!imp) {
      impHTML = `<div class="drop" data-act="imp-pick" tabindex="0" role="button">
        <span class="coin big"></span>
        <span class="gtext">Drop a screenshot here</span>
        <span class="muted small">…or tap to choose one, or paste it (Ctrl+V). The app reads item names and counts for you.</span>
      </div>`;
    } else if (imp.reading) {
      impHTML = `<div class="empty"><span class="gtext">Reading your screenshot…</span><div class="progress"><div id="imp-bar" style="width:${Math.round((imp.progress || 0) * 100)}%"></div></div><span class="small" id="imp-status">${esc(imp.status || "Starting up")}</span><div class="small muted" style="margin-top:6px">First time takes a little longer (it downloads the text reader).</div></div>`;
    } else {
      const rows = imp.rows;
      impHTML = `<div class="notice" style="margin-bottom:10px">Check the list — anything highlighted yellow was a guess. Fix names, rarity and counts, then save.</div>
      <table class="table"><thead><tr><td></td><td></td><td class="small muted">Item</td><td class="small muted">Rarity</td><td class="small muted">Count</td><td></td></tr></thead><tbody>
      ${rows.map((row, i) => {
        const ex = matchExisting(row);
        const tag = ex ? `in treasury: ${ex.qty}${res[ex.id] ? ` (+${res[ex.id]} promised)` : ""}` : "new";
        return `<tr class="row">
          <td><input type="checkbox" class="check" ${row.include ? "checked" : ""} data-imp="${i}" data-f="include"></td>
          <td>${iconHTML(row, "sm")}</td>
          <td class="wide"><input list="known-names" value="${esc(row.name)}" class="${row.nameSure ? "" : "unsure"}" data-imp="${i}" data-f="name" placeholder="Item name"></td>
          <td><select data-imp="${i}" data-f="rarity">${RARITIES.map((r) => `<option value="${r}" ${r === row.rarity ? "selected" : ""}>${RLABEL[r]}</option>`).join("")}</select></td>
          <td><input class="qty-in ${row.qtySure ? "" : "unsure"}" inputmode="numeric" value="${row.qty}" data-imp="${i}" data-f="qty"></td>
          <td class="wide"><span class="tag ${ex ? "" : "new"}">${tag}</span></td>
        </tr>`; }).join("")}
      </tbody></table>
      <div style="margin:6px 0 12px">
        <label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:6px"><input type="radio" name="impmode" value="set" ${state.impMode === "set" ? "checked" : ""} data-bind="impMode" class="check" style="width:20px"> <span><b>Match my screenshot</b> <span class="small muted">— counts become what the screenshot shows (minus anything already promised to someone).</span></span></label>
        <label style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="impmode" value="add" ${state.impMode === "add" ? "checked" : ""} data-bind="impMode" class="check" style="width:20px"> <span><b>Add on top</b> <span class="small muted">— add these counts to what's already in the treasury.</span></span></label>
      </div>
      <div class="btn-row"><button class="btn green" data-act="imp-save">Save to treasury</button><button class="btn wood" data-act="imp-cancel">Cancel</button></div>`;
    }
    const items = sortItems(d.items);
    return `<datalist id="known-names">${(d.knownNames || []).map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
    <section class="panel">
      <div class="panel-head"><h2 class="gtext">Add from screenshot</h2></div>
      ${impHTML}
      <input type="file" accept="image/*" id="imp-file" class="sr" tabindex="-1">
    </section>
    <section class="panel">
      <div class="panel-head"><h2 class="gtext">My items</h2></div>
      <p class="muted small" style="margin-top:-6px">Changes save as soon as you leave a box. "Promised" items are already set aside for approved requests.</p>
      ${items.length ? `<table class="table"><tbody>${items.map((it) => `<tr class="row">
          <td>${iconHTML(it, "sm")}</td>
          <td class="wide"><input value="${esc(it.name)}" data-item-id="${it.id}" data-f="name" list="known-names"></td>
          <td><select data-item-id="${it.id}" data-f="rarity">${RARITIES.map((r) => `<option value="${r}" ${r === it.rarity ? "selected" : ""}>${RLABEL[r]}</option>`).join("")}</select></td>
          <td><input class="qty-in" inputmode="numeric" value="${it.qty}" data-item-id="${it.id}" data-f="qty" aria-label="available"></td>
          <td><span class="tag">${res[it.id] ? `+${res[it.id]} promised` : "available"}</span></td>
          <td><button class="btn sm red" data-act="item-del" data-id="${it.id}" aria-label="remove">✕</button></td>
        </tr>`).join("")}</tbody></table>` : `<div class="empty">No items yet — drop a screenshot above or add one below.</div>`}
      <h3 class="gtext">Add one by hand</h3>
      <div class="form-grid" style="grid-template-columns:2fr 1fr 90px auto;align-items:end;gap:10px">
        <input list="known-names" placeholder="Item name" value="${esc(state.newItem.name)}" data-bind="newItem.name">
        <select data-bind="newItem.rarity">${RARITIES.map((r) => `<option value="${r}" ${r === state.newItem.rarity ? "selected" : ""}>${RLABEL[r]}</option>`).join("")}</select>
        <input inputmode="numeric" value="${esc(state.newItem.qty)}" data-bind="newItem.qty" aria-label="count">
        <button class="btn green" data-act="item-add">Add</button>
      </div>
    </section>`;
  }

  function adminSettings() {
    const d = D();
    return `<section class="panel">
      <div class="panel-head"><h2 class="gtext">Buildings</h2></div>
      <p class="muted small" style="margin-top:-6px">The buildings people can pick, one per line. Trim it to the ones the guild wants investment in right now.</p>
      <textarea id="set-buildings" rows="10">${esc((d.buildings || []).join("\n"))}</textarea>
      <div class="btn-row" style="margin-top:10px"><button class="btn green" data-act="save-buildings">Save buildings</button></div>
    </section>
    <section class="panel">
      <div class="panel-head"><h2 class="gtext">Item names the reader knows</h2></div>
      <p class="muted small" style="margin-top:-6px">The screenshot reader snaps blurry text to these names. It learns new ones every time you save items.</p>
      <textarea id="set-names" rows="6">${esc((d.knownNames || []).join("\n"))}</textarea>
      <div class="btn-row" style="margin-top:10px"><button class="btn green" data-act="save-names">Save names</button></div>
    </section>
    <section class="panel" style="max-width:520px">
      <div class="panel-head"><h2 class="gtext">Change password</h2></div>
      <label class="field"><span>New password</span><input type="password" id="new-pw" autocomplete="new-password" minlength="6"></label>
      <button class="btn" data-act="change-pw">Change it</button>
    </section>`;
  }

  function matchExisting(row) {
    const n = (row.name || "").trim().toLowerCase();
    return D().items.find((i) => i.name.trim().toLowerCase() === n && i.rarity === row.rarity);
  }

  // ---------- screenshot import ----------
  async function importFile(file) {
    if (!file || !/^image\//.test(file.type)) { toast("That's not an image", true); return; }
    state.imp = { reading: true, progress: 0, status: "Starting up" };
    render();
    try {
      const rows = await TroveOCR.parse(file, D().knownNames || [], (status, p) => {
        if (!state.imp) return;
        state.imp.status = { "loading tesseract core": "Loading the reader", "initializing tesseract": "Warming up", "loading language traineddata": "Downloading English text model", "initializing api": "Warming up", "recognizing text": "Reading item cards" }[status] || status;
        state.imp.progress = p || 0;
        const bar = document.getElementById("imp-bar"), st = document.getElementById("imp-status");
        if (bar) bar.style.width = Math.round(state.imp.progress * 100) + "%";
        if (st) st.textContent = state.imp.status;
      });
      if (!rows.length) { state.imp = null; toast("Couldn't find any item cards in that image — try a clearer screenshot", true); render(); return; }
      state.imp = { rows: rows.map((r) => ({ include: true, name: r.name, rarity: "legendary", qty: r.qty, icon: r.icon, nameSure: r.nameSure && !!r.name, qtySure: r.qtySure })) };
      toast(`Found ${rows.length} item${rows.length === 1 ? "" : "s"} — check them over`);
    } catch (e) {
      state.imp = null; toast(e.message || "Couldn't read that screenshot", true);
    }
    render();
  }
  async function saveImport() {
    const rows = state.imp.rows.filter((r) => r.include && r.name.trim());
    if (!rows.length) { toast("Nothing selected to save", true); return; }
    const res = reservedMap();
    const payload = [];
    const seen = {};
    rows.forEach((r) => {
      const qty = Math.max(0, parseInt(r.qty, 10) || 0);
      const key = r.name.trim().toLowerCase() + "|" + r.rarity;
      if (seen[key]) { seen[key].qty += state.impMode === "add" ? qty : 0; return; }
      const ex = matchExisting(r);
      let p;
      if (ex) p = { id: ex.id, qty: state.impMode === "set" ? Math.max(0, qty - (res[ex.id] || 0)) : ex.qty + qty, icon: ex.icon ? null : r.icon };
      else p = { name: r.name.trim(), rarity: r.rarity, qty, icon: r.icon };
      if (p.icon == null) delete p.icon;
      seen[key] = p; payload.push(p);
    });
    const names = Array.from(new Set([...(D().knownNames || []), ...rows.map((r) => r.name.trim())]));
    await run(async () => {
      await API.adminSaveItems(state.pw, payload);
      if (names.length !== (D().knownNames || []).length) await API.adminSaveSetting(state.pw, "known_names", names);
      state.imp = null;
    }, "Treasury updated!");
  }

  // ---------- events ----------
  function setPath(path, val) {
    const parts = path.split(".");
    let o = state;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] = o[parts[i]] || {};
    o[parts[parts.length - 1]] = val;
    if (parts[0] === "form") ls.set("trove.form", { player: state.form.player, building: state.form.building });
  }
  function logout() { state.pw = null; ss.set("trove.pw", null); ls.set("trove.pw", null); render(); }

  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.bind) {
      setPath(t.dataset.bind, t.type === "radio" ? t.value : t.value);
      if (t.dataset.bind === "search") { const pos = t.selectionStart; render(); const n = app.querySelector('[data-bind="search"]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }
    }
    if (t.dataset.pick) {
      const max = +t.dataset.max; let v = parseInt(t.value, 10); if (isNaN(v) || v < 0) v = 0; if (v > max) v = max;
      (state.picks[t.dataset.pick] = state.picks[t.dataset.pick] || {})[t.dataset.item] = v;
    }
    if (t.dataset.imp != null && state.imp && state.imp.rows) {
      const row = state.imp.rows[+t.dataset.imp], f = t.dataset.f;
      if (f === "include") row.include = t.checked;
      else if (f === "name") { row.name = t.value; row.nameSure = true; t.classList.remove("unsure"); }
      else if (f === "qty") { row.qty = t.value; row.qtySure = true; t.classList.remove("unsure"); }
      else row[f] = t.value;
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.bind === "impMode") { state.impMode = t.value; return; }
    if (t.dataset.imp != null && state.imp && state.imp.rows) { render(); return; }
    if (t.dataset.pick) { render(); return; }
    if (t.id === "imp-file" && t.files && t.files[0]) { importFile(t.files[0]); t.value = ""; return; }
    if (t.dataset.itemId) {
      const f = t.dataset.f; const patch = { id: t.dataset.itemId };
      if (f === "qty") { const v = parseInt(t.value, 10); if (isNaN(v) || v < 0) { toast("Count must be 0 or more", true); render(); return; } patch.qty = v; }
      else if (f === "name") { if (!t.value.trim()) { toast("Name can't be empty", true); render(); return; } patch.name = t.value.trim(); }
      else patch[f] = t.value;
      run(() => API.adminSaveItems(state.pw, [patch]), "Saved");
    }
  });
  document.addEventListener("submit", async (e) => {
    const f = e.target;
    if (f.dataset.form === "request") {
      e.preventDefault();
      const inv = parseAmt(state.form.invested);
      if (!state.form.player.trim()) return toast("Enter your in-game name", true);
      if (!state.form.building) return toast("Pick a building", true);
      if (isNaN(inv)) return toast("Investment should be a number like 12, 1.5K or 2B", true);
      const tok = token();
      await run(async () => {
        const id = await API.submitRequest({ player: state.form.player.trim(), building: state.form.building, invested: inv, note: state.form.note.trim(), token: tok });
        state.mine.push({ id, token: tok }); ls.set("trove.mine", state.mine);
        state.form.invested = ""; state.form.note = "";
        state.tab = "board"; location.hash = "board";
        window.scrollTo({ top: 0, behavior: "smooth" });
      }, "Request sent! Check back to see when it's approved.");
    }
    if (f.dataset.form === "login") {
      e.preventDefault();
      const pw = f.pw.value, remember = f.remember.checked;
      await run(async () => {
        await API.adminLogin(pw);
        state.pw = pw; ss.set("trove.pw", pw); if (remember) ls.set("trove.pw", pw);
      }, "Welcome back, " + DONOR + "!");
    }
  });
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    switch (act) {
      case "tab": state.tab = id; history.replaceState(null, "", "#" + id); render(); window.scrollTo({ top: 0 }); break;
      case "atab": state.adminTab = id; render(); break;
      case "logout": logout(); break;
      case "mark-done": run(() => API.markDone(id), "Marked done — thanks!"); break;
      case "cancel-mine": run(() => API.playerCancel(id, myToken(id)), "Removed"); break;
      case "adm-toggle": {
        state.open[id] = !state.open[id];
        // start with 1 of whatever he has the most of, so spreading items out is the easy path
        if (state.open[id] && !state.picks[id]) {
          const top = D().items.filter((i) => i.qty > 0).sort((a, b) => b.qty - a.qty)[0];
          if (top) state.picks[id] = { [top.id]: 1 };
        }
        render(); break;
      }
      case "adm-step": {
        const p = (state.picks[id] = state.picks[id] || {});
        const it = D().items.find((i) => i.id === el.dataset.item);
        p[el.dataset.item] = Math.max(0, Math.min(it ? it.qty : 0, (p[el.dataset.item] || 0) + Number(el.dataset.d)));
        render(); break;
      }
      case "adm-approve": {
        const p = state.picks[id] || {};
        const alloc = Object.entries(p).filter(([, q]) => q > 0).map(([item_id, qty]) => ({ item_id, qty }));
        run(async () => { await API.adminDecide(state.pw, id, true, alloc, state.notes[id]); delete state.picks[id]; delete state.open[id]; delete state.notes[id]; }, "Approved!");
        break;
      }
      case "adm-deny": run(async () => { await API.adminDecide(state.pw, id, false, [], state.notes[id]); delete state.notes[id]; }, "Denied"); break;
      case "adm-undo": run(() => API.adminReopen(state.pw, id), "Moved back to waiting"); break;
      case "imp-pick": document.getElementById("imp-file").click(); break;
      case "imp-cancel": state.imp = null; render(); break;
      case "imp-save": saveImport(); break;
      case "item-del": {
        const it = D().items.find((i) => i.id === id);
        if (confirm(`Remove ${it ? it.name : "this item"} from the treasury?`)) run(() => API.adminDeleteItem(state.pw, id), "Removed");
        break;
      }
      case "item-add": {
        const n = state.newItem; const qty = parseInt(n.qty, 10);
        if (!n.name.trim()) return toast("Type an item name", true);
        if (isNaN(qty) || qty < 0) return toast("Count must be 0 or more", true);
        const ex = D().items.find((i) => i.name.toLowerCase() === n.name.trim().toLowerCase() && i.rarity === n.rarity);
        run(async () => {
          await API.adminSaveItems(state.pw, [ex ? { id: ex.id, qty: ex.qty + qty } : { name: n.name.trim(), rarity: n.rarity, qty }]);
          const names = D().knownNames || [];
          if (!names.some((x) => x.toLowerCase() === n.name.trim().toLowerCase())) await API.adminSaveSetting(state.pw, "known_names", [...names, n.name.trim()]);
          state.newItem = { name: "", rarity: n.rarity, qty: "1" };
        }, ex ? "Added to existing stack" : "Item added");
        break;
      }
      case "save-buildings": {
        const list = document.getElementById("set-buildings").value.split("\n").map((s) => s.trim()).filter(Boolean);
        if (!list.length) return toast("Keep at least one building", true);
        run(() => API.adminSaveSetting(state.pw, "buildings", Array.from(new Set(list))), "Buildings saved");
        break;
      }
      case "save-names": {
        const list = document.getElementById("set-names").value.split("\n").map((s) => s.trim()).filter(Boolean);
        run(() => API.adminSaveSetting(state.pw, "known_names", Array.from(new Set(list))), "Names saved");
        break;
      }
      case "change-pw": {
        const np = document.getElementById("new-pw").value;
        run(async () => {
          await API.adminChangePassword(state.pw, np);
          state.pw = np; ss.set("trove.pw", np); if (ls.get("trove.pw", null)) ls.set("trove.pw", np);
        }, "Password changed");
        break;
      }
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".drop")) { e.preventDefault(); document.getElementById("imp-file").click(); }
  });
  // drag & drop + paste for screenshots
  document.addEventListener("dragover", (e) => {
    const z = e.target.closest && e.target.closest(".drop");
    if (z) { e.preventDefault(); z.classList.add("hover"); }
  });
  document.addEventListener("dragleave", (e) => { const z = e.target.closest && e.target.closest(".drop"); if (z) z.classList.remove("hover"); });
  document.addEventListener("drop", (e) => {
    const z = e.target.closest && e.target.closest(".drop");
    if (!z) return;
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) importFile(f);
  });
  document.addEventListener("paste", (e) => {
    if (!(state.tab === "admin" && state.pw && state.adminTab === "items") || (state.imp && state.imp.reading)) return;
    const item = Array.from(e.clipboardData.items || []).find((i) => i.type.startsWith("image/"));
    if (item) { e.preventDefault(); importFile(item.getAsFile()); }
  });
  window.addEventListener("hashchange", () => {
    const t = location.hash.replace("#", "");
    if (["treasury", "request", "board", "admin"].includes(t) && t !== state.tab) { state.tab = t; render(); }
  });

  load();
})();
