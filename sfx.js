// Tiny synthesized sound effects (no audio files). Mute state is remembered per device.
window.SFX = (function () {
  let ctx = null, master = null, unlocked = false;
  let muted = false;
  try { muted = localStorage.getItem("trove.muted") === "1"; } catch (e) {}

  function ac() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.32; master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }
  // browsers only allow sound after the first tap/click/key
  ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
    window.addEventListener(ev, () => { unlocked = true; ac(); }, { once: false, passive: true, capture: true }));

  // one note: type, start freq, end freq, length, volume, delay
  function tone(type, f1, f2, dur, vol, delay) {
    const c = ac(); if (!c) return;
    const t = c.currentTime + (delay || 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1, t);
    if (f2 && f2 !== f1) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  const sounds = {
    hover() { tone("sine", 880, 1180, 0.06, 0.09); },
    tab() { tone("triangle", 520, 780, 0.09, 0.22); },
    click() { tone("triangle", 420, 680, 0.08, 0.25); tone("sine", 1200, 1500, 0.05, 0.08, 0.02); },
    step() { tone("square", 660, 720, 0.04, 0.06); },
    stepDown() { tone("square", 560, 500, 0.04, 0.06); },
    coin() { tone("square", 988, 988, 0.08, 0.1); tone("square", 1319, 1319, 0.28, 0.1, 0.075); },
    success() { [523, 659, 784, 1047].forEach((f, i) => tone("triangle", f, f, 0.16, 0.2, i * 0.07)); tone("sine", 2093, 2093, 0.35, 0.05, 0.28); },
    sparkle() { [1568, 1976, 2349, 2637, 3136].forEach((f, i) => tone("sine", f, f * 1.01, 0.18, 0.07, i * 0.045)); },
    error() { tone("sawtooth", 220, 150, 0.18, 0.12); tone("sine", 180, 120, 0.22, 0.15, 0.03); },
    whoosh() { tone("sine", 300, 1400, 0.16, 0.08); },
    paper() { tone("triangle", 300, 240, 0.06, 0.12); }
  };

  let lastHover = 0;
  function play(name) {
    if (muted || !unlocked || !sounds[name]) return;
    if (name === "hover") { const n = performance.now(); if (n - lastHover < 70) return; lastHover = n; }
    try { sounds[name](); } catch (e) {}
  }
  return {
    play,
    get muted() { return muted; },
    toggle() {
      muted = !muted;
      try { localStorage.setItem("trove.muted", muted ? "1" : "0"); } catch (e) {}
      if (!muted) { unlocked = true; sounds.coin(); }
      return muted;
    }
  };
})();
