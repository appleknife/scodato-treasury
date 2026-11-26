// Data layer: Supabase (live) or localStorage (demo). Same interface for both.
(function () {
  const cfg = window.TROVE_CONFIG || {};
  const live = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

  // ---------------- Supabase over plain REST ----------------
  function sbHeaders() {
    return {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: "Bearer " + cfg.SUPABASE_ANON_KEY,
      "Content-Type": "application/json"
    };
  }
  const base = live ? cfg.SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1" : "";

  async function sbGet(path) {
    const r = await fetch(base + path, { headers: sbHeaders() });
    if (!r.ok) throw new Error(await errText(r));
    return r.json();
  }
  async function sbRpc(fn, args) {
    const r = await fetch(base + "/rpc/" + fn, { method: "POST", headers: sbHeaders(), body: JSON.stringify(args || {}) });
    if (!r.ok) throw new Error(await errText(r));
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  async function errText(r) {
    try { const j = await r.json(); return j.message || j.hint || JSON.stringify(j); } catch (e) { return "Server error " + r.status; }
  }

  const SB = {
    mode: "live",
    async load() {
      const since = new Date(Date.now() - 30 * 864e5).toISOString();
      const cutoff = Date.now() - 4 * 864e5;
      const [items, allReqs, settings, stats] = await Promise.all([
        sbGet("/trove_items?select=*&order=name.asc"),
        sbGet("/trove_requests?select=*&or=" + encodeURIComponent('(status.in.(pending,approved),created_at.gte."' + since + '")') + "&order=created_at.asc&limit=1000"),
        sbGet("/trove_settings?select=*"),
        sbRpc("trove_public_stats")
      ]);
      const s = {};
      settings.forEach(x => (s[x.key] = x.value));
      const reqs = allReqs.filter(r => ["pending", "approved"].includes(r.status) || new Date(r.done_at || r.decided_at || 0).getTime() >= cutoff);
      return { items, requests: reqs, buildings: s.buildings || [], knownNames: s.known_names || [], maxPer: s.max_per_approval == null ? 1 : Number(s.max_per_approval), cooldownH: s.cooldown_hours == null ? 24 : Number(s.cooldown_hours), stats: stats || {} };
    },
    submitRequest: (a) => sbRpc("trove_submit_request", { p_player: a.player, p_building: a.building, p_invested: a.invested, p_note: a.note || null, p_token: a.token }),
    markDone: (id) => sbRpc("trove_mark_done", { p_id: id }),
    playerCancel: (id, token) => sbRpc("trove_player_cancel", { p_id: id, p_token: token }),
    adminLogin: (pw) => sbRpc("trove_admin_login", { p_pw: pw }),
    adminChangePassword: (pw, np) => sbRpc("trove_admin_change_password", { p_pw: pw, p_new: np }),
    adminSaveItems: (pw, items) => sbRpc("trove_admin_save_items", { p_pw: pw, p_items: items }),
    adminDeleteItem: (pw, id) => sbRpc("trove_admin_delete_item", { p_pw: pw, p_id: id }),
    adminDecide: (pw, id, approve, alloc, note) => sbRpc("trove_admin_decide", { p_pw: pw, p_id: id, p_approve: approve, p_alloc: alloc || [], p_note: note || null }),
    adminReopen: (pw, id) => sbRpc("trove_admin_reopen", { p_pw: pw, p_id: id }),
    adminRemoveRequest: (pw, id) => sbRpc("trove_admin_remove_request", { p_pw: pw, p_id: id }),
    adminSaveSetting: (pw, key, value) => sbRpc("trove_admin_save_setting", { p_pw: pw, p_key: key, p_value: value })
  };

  // ---------------- Demo mode (this browser only) ----------------
  const KEY = "trove.demo.v1";
  const DEFAULT_BUILDINGS = ["Town Hall","Temple","Tavern","Emerald Inn","Academy","Training Hall","Master Lodge","Summoner's Tent","Wizard Tower","Laboratory","Apothecary","Ether Well","Mausoleum","Garden","Iron Mine","Lumberyard","Wood Workshop","Jewel Workshop","Tailor Workshop","Tannery","Smithy","Weaver Mill","Ironwood Sawmill","Oil Press","Smelter","Jewel Storehouse"];
  const DEFAULT_NAMES = ["Worldshaper Hood","Aura Reactor","Darkmatter Cortex","Voyager Neovisor","Microcosmos Infusion","Slipstream Assistant","Paradox Entity","Dimensional Anchor"];
  function dbLoad() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
    if (!d) d = { items: [], requests: [], tokens: {}, buildings: DEFAULT_BUILDINGS, knownNames: DEFAULT_NAMES, pw: "demo" };
    if (d.maxPer == null) d.maxPer = 1;
    if (d.cooldownH == null) d.cooldownH = 24;
    return d;
  }
  function dbSave(d) { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) { throw new Error("Browser storage is full or blocked"); } }
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
  const now = () => new Date().toISOString();
  function chk(d, pw) { if (pw !== d.pw) throw new Error("Wrong password"); }
  const wait = (v) => new Promise(r => setTimeout(() => r(v), 120));

  const DEMO = {
    mode: "demo",
    async load() {
      const d = dbLoad();
      const cutoff = Date.now() - 4 * 864e5;
      const reqs = d.requests.filter(r => ["pending", "approved"].includes(r.status) || new Date(r.done_at || r.decided_at || 0).getTime() >= cutoff);
      const done = d.requests.filter(r => r.status === "done");
      const items_donated = done.reduce((s, r) => s + r.allocations.reduce((t, a) => t + a.qty, 0), 0);
      return wait({ items: [...d.items].sort((a, b) => a.name.localeCompare(b.name)), requests: reqs, buildings: d.buildings, knownNames: d.knownNames, maxPer: d.maxPer, cooldownH: d.cooldownH, stats: { items_donated, requests_done: done.length } });
    },
    async submitRequest(a) {
      const d = dbLoad();
      const player = (a.player || "").trim().slice(0, 40), building = (a.building || "").trim();
      if (!player) throw new Error("Please enter your in-game name");
      if (!building) throw new Error("Please pick a building");
      if (!(a.invested >= 0)) throw new Error("Investment amount must be 0 or more");
      if (d.requests.some(r => r.player.toLowerCase() === player.toLowerCase() && ["pending", "approved"].includes(r.status)))
        throw new Error("You already have a request open — finish that one first");
      const r = { id: uid(), player, building, invested: a.invested, note: (a.note || "").slice(0, 200) || null, status: "pending", allocations: [], admin_note: null, created_at: now(), decided_at: null, done_at: null };
      d.requests.push(r); d.tokens[r.id] = a.token; dbSave(d); return wait(r.id);
    },
    async markDone(id) {
      const d = dbLoad(); const r = d.requests.find(x => x.id === id);
      if (!r || r.status !== "approved") throw new Error("That request is not waiting to be finished");
      r.status = "done"; r.done_at = now(); dbSave(d); return wait();
    },
    async playerCancel(id, token) {
      const d = dbLoad(); if (d.tokens[id] !== token) throw new Error("Only the device that made this request can cancel it");
      const r = d.requests.find(x => x.id === id);
      if (r.status === "approved") restore(d, r);
      if (["pending", "approved", "denied"].includes(r.status)) { r.status = "closed"; r.done_at = now(); }
      dbSave(d); return wait();
    },
    async adminLogin(pw) { chk(dbLoad(), pw); return wait(true); },
    async adminChangePassword(pw, np) { const d = dbLoad(); chk(d, pw); if (!np || np.length < 6) throw new Error("New password must be at least 6 characters"); d.pw = np; dbSave(d); return wait(); },
    async adminSaveItems(pw, items) {
      const d = dbLoad(); chk(d, pw);
      items.forEach(it => {
        const ex = it.id && d.items.find(x => x.id === it.id);
        if (ex) {
          if (it.name) ex.name = it.name; if (it.rarity) ex.rarity = it.rarity;
          if (it.qty != null) ex.qty = Math.max(0, it.qty | 0); if (it.icon) ex.icon = it.icon; ex.updated_at = now();
        } else d.items.push({ id: uid(), name: it.name || "Unknown item", rarity: it.rarity || "legendary", qty: Math.max(0, it.qty | 0), icon: it.icon || null, updated_at: now() });
      });
      dbSave(d); return wait();
    },
    async adminDeleteItem(pw, id) { const d = dbLoad(); chk(d, pw); d.items = d.items.filter(x => x.id !== id); dbSave(d); return wait(); },
    async adminDecide(pw, id, approve, alloc, note) {
      const d = dbLoad(); chk(d, pw); const r = d.requests.find(x => x.id === id);
      if (!r || r.status !== "pending") throw new Error("That request is no longer pending");
      if (!approve) { r.status = "denied"; r.admin_note = note || null; r.decided_at = now(); dbSave(d); return wait(); }
      const snap = [];
      for (const a of alloc || []) {
        if (!(a.qty > 0)) continue;
        const it = d.items.find(x => x.id === a.item_id);
        if (!it) throw new Error("An item is missing from the treasury");
        if (it.qty < a.qty) throw new Error(`Only ${it.qty} × ${it.name} left`);
        snap.push({ item_id: it.id, name: it.name, rarity: it.rarity, qty: a.qty, icon: it.icon });
      }
      if (!snap.length) throw new Error("Pick at least one item");
      const total = snap.reduce((s, x) => s + x.qty, 0);
      if (d.maxPer > 0 && total > d.maxPer) throw new Error(`Max ${d.maxPer} item(s) per approval — change the limit in Settings`);
      snap.forEach(s => (d.items.find(x => x.id === s.item_id).qty -= s.qty));
      r.status = "approved"; r.allocations = snap; r.admin_note = note || null; r.decided_at = now(); dbSave(d); return wait();
    },
    async adminReopen(pw, id) {
      const d = dbLoad(); chk(d, pw); const r = d.requests.find(x => x.id === id);
      if (r.status === "approved") restore(d, r);
      if (["approved", "denied"].includes(r.status)) Object.assign(r, { status: "pending", allocations: [], admin_note: null, decided_at: null });
      dbSave(d); return wait();
    },
    async adminRemoveRequest(pw, id) {
      const d = dbLoad(); chk(d, pw); const r = d.requests.find(x => x.id === id);
      if (r.status === "approved") restore(d, r);
      r.status = "closed"; r.done_at = now(); dbSave(d); return wait();
    },
    async adminSaveSetting(pw, key, value) {
      const d = dbLoad(); chk(d, pw);
      if (key === "buildings") d.buildings = value; else if (key === "known_names") d.knownNames = value;
      else if (key === "max_per_approval") d.maxPer = value; else if (key === "cooldown_hours") d.cooldownH = value; else throw new Error("Unknown setting");
      dbSave(d); return wait();
    }
  };
  function restore(d, r) { r.allocations.forEach(a => { const it = d.items.find(x => x.id === a.item_id); if (it) it.qty += a.qty; }); }

  window.TroveAPI = live ? SB : DEMO;
})();
