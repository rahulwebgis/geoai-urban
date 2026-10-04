/* Hero illustration: a synthetic city seen from above. A scan line passes once
 * and classifies each grid cell into low, medium or high built-up intensity. */
(function () {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let W, H, cells, blocks, roads, start = null, raf = null;
  const CELL = 46;
  const colors = { Low: [243, 222, 138], Medium: [238, 139, 58], High: [184, 35, 58] };

  function rnd(seed) { let a = seed; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }

  function build() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = rnd(7);
    const centres = [[W * 0.74, H * 0.4, 150], [W * 0.92, H * 0.88, 110], [W * 0.56, H * 0.12, 90]];
    const density = (x, y) => Math.min(1, centres.reduce((s, [cx, cy, rad]) => s + Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * rad * rad)), 0));

    // roads: a slightly bent grid plus two diagonals
    roads = [];
    for (let x = -20; x < W + 40; x += 92 + r() * 30) roads.push([[x, -10], [x + 30 * (r() - 0.5), H + 10], r() < 0.2 ? 2.2 : 1]);
    for (let y = -20; y < H + 40; y += 84 + r() * 30) roads.push([[-10, y], [W + 10, y + 40 * (r() - 0.5)], r() < 0.2 ? 2.2 : 1]);
    roads.push([[W * 0.35, H + 10], [W * 1.05, -10], 2.6]);

    blocks = [];
    for (let x = 0; x < W; x += 11) for (let y = 0; y < H; y += 11) {
      const d = density(x, y);
      if (r() < d * 0.6 + 0.035) blocks.push([x + r() * 3, y + r() * 3, 4 + r() * 5 * (0.5 + d), 4 + r() * 5 * (0.5 + d)]);
    }
    cells = [];
    for (let x = 0; x < W; x += CELL) for (let y = 0; y < H; y += CELL) {
      const d = density(x + CELL / 2, y + CELL / 2) + (r() - 0.5) * 0.12;
      cells.push({ x, y, cls: d > 0.6 ? 'High' : d > 0.22 ? 'Medium' : 'Low', d });
    }
  }

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#071528'; ctx.fillRect(0, 0, W, H);
    const sweep = reduce ? W + 200 : t * W * 1.2 - 100;
    // classified cells behind the sweep
    for (const c of cells) {
      if (c.x + CELL > sweep) continue;
      const k = Math.min(1, (sweep - c.x - CELL) / 160);
      const [cr, cg, cb] = colors[c.cls];
      const a = (c.cls === 'Low' ? 0.07 : c.cls === 'Medium' ? 0.26 : 0.42) * k;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
      ctx.fillRect(c.x + 1, c.y + 1, CELL - 2, CELL - 2);
    }
    ctx.lineCap = 'round';
    for (const [a, b, w] of roads) {
      ctx.strokeStyle = w > 2 ? 'rgba(92,184,255,.55)' : 'rgba(92,184,255,.22)';
      ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(214,230,248,.42)';
    for (const b of blocks) ctx.fillRect(b[0], b[1], b[2], b[3]);
    // grid
    ctx.strokeStyle = 'rgba(92,184,255,.13)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= W; x += CELL) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
    for (let y = 0; y <= H; y += CELL) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
    ctx.stroke();
    // scan line
    if (sweep > 0 && sweep < W + 100) {
      const g = ctx.createLinearGradient(sweep - 80, 0, sweep, 0);
      g.addColorStop(0, 'rgba(92,184,255,0)'); g.addColorStop(1, 'rgba(92,184,255,.35)');
      ctx.fillStyle = g; ctx.fillRect(sweep - 80, 0, 80, H);
      ctx.fillStyle = 'rgba(160,215,255,.9)'; ctx.fillRect(sweep, 0, 1.5, H);
    }
  }

  function loop(ts) {
    if (start === null) start = ts;
    const t = (ts - start) / 5200;
    draw(t);
    if (t < 1.25) raf = requestAnimationFrame(loop);
  }

  function init() {
    build();
    cancelAnimationFrame(raf); start = null;
    if (reduce) draw(2); else raf = requestAnimationFrame(loop);
  }
  let to;
  window.addEventListener('resize', () => { clearTimeout(to); to = setTimeout(() => { build(); draw(2); }, 150); });
  window.GeoAIHero = { replay: init };
  init();
})();
