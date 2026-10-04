/* Example city: a synthetic, reproducible dataset for trying the platform
 * without a network connection. Two snapshots (earlier and current) let the
 * change-detection step run too. Not real data. */
(function (root) {
  const GeoAI = (root.GeoAI = root.GeoAI || {});

  function snapshot(year, lon0, lat0) {
    const G = GeoAI.Geo;
    const proj = G.localProjection(lon0, lat0);
    const rnd = G.rng(year);
    const W = 3200, H = 2900, el = [];
    let id = year * 1e6;
    const pt = (x, y) => { const [lon, lat] = proj.inv(x, y); return { lon, lat }; };
    const rect = (x, y, w, h) => [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h), pt(x, y)];
    const centres = [[1650, 1500, 900], [2700, 600, 420], [500, 2300, 380]];
    const dens = (x, y) => Math.min(1, centres.reduce((s, [cx, cy, r]) => s + Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r)), 0));

    // buildings: dense core with mid-rise blocks, sprawl at the edges, a tight informal-looking pocket
    for (let x = 15; x < W - 15; x += 21) for (let y = 15; y < H - 15; y += 21) {
      let p = 0.04 + dens(x, y) * 0.9;
      const ring = Math.hypot(x - 1650, y - 1500);
      if (year > 2020 && ring > 900 && ring < 1250) p += 0.3; // growth between snapshots
      if (x > 2350 && x < 2700 && y > 2050 && y < 2400) p = 0.95;
      if (year < 2020 && x < 1500 && y > 2250) p = 0; // a district built after the earlier snapshot
      if (rnd() > p) continue;
      const informal = x > 2350 && x < 2700 && y > 2050 && y < 2400;
      const s = informal ? 4 + rnd() * 3 : 7 + rnd() * 9 + dens(x, y) * 5;
      const tags = { building: informal ? 'hut' : 'yes' };
      if (dens(x, y) > 0.75 && rnd() < 0.7) tags['building:levels'] = String(3 + Math.floor(rnd() * 8));
      el.push({ type: 'way', id: id++, tags, geometry: rect(x, y, s, s * (0.8 + rnd() * 0.4)) });
      if (rnd() < 0.015) el.push({ type: 'way', id: id++, tags: { building: 'yes' }, geometry: rect(x + 0.4, y + 0.3, s, s) }); // mapped twice
    }
    // road grid with shared nodes; two arterials
    const nid = (i, j) => year * 1e7 + i * 1000 + j;
    const step = 200, nx = Math.floor(W / step), ny = Math.floor(H / step);
    for (let j = 0; j <= ny; j++) {
      if (year < 2020 && (j * step > 2600)) continue;
      const nodes = [], geom = [];
      for (let i = 0; i <= nx; i++) { nodes.push(nid(i, j)); geom.push(pt(i * step, j * step)); }
      el.push({ type: 'way', id: id++, nodes, tags: { highway: j === 7 ? 'primary' : 'residential', name: 'Street ' + j }, geometry: geom });
    }
    for (let i = 0; i <= nx; i++) {
      const nodes = [], geom = [];
      for (let j = 0; j <= ny; j++) { if (year < 2020 && j * step > 2600) continue; nodes.push(nid(i, j)); geom.push(pt(i * step, j * step)); }
      el.push({ type: 'way', id: id++, nodes, tags: { highway: i === 8 ? 'secondary' : 'residential' }, geometry: geom });
    }
    // services
    [[800, 700, 'school'], [2300, 1100, 'school'], [1700, 1550, 'hospital'], [1600, 1400, 'pharmacy'], [1720, 1480, 'cafe'], [1580, 1600, 'bank'], [2650, 650, 'clinic'], [1900, 1300, 'restaurant']]
      .forEach(([x, y, a]) => { const p = pt(x, y); el.push({ type: 'node', id: id++, lon: p.lon, lat: p.lat, tags: { amenity: a, name: a[0].toUpperCase() + a.slice(1) } }); });
    // green and water
    el.push({ type: 'way', id: id++, tags: { leisure: 'park' }, geometry: rect(250, 250, 420, 360) });
    el.push({ type: 'way', id: id++, tags: { landuse: 'grass' }, geometry: rect(1400, 1180, 160, 120) });
    el.push({ type: 'way', id: id++, tags: { natural: 'water' }, geometry: rect(2850, 2350, 300, 450) });
    return { elements: el };
  }

  GeoAI.Sample = {
    lon0: 46.655, lat0: 24.675,
    aoi() {
      const p = GeoAI.Geo.localProjection(this.lon0, this.lat0);
      const a = p.inv(0, 0), b = p.inv(3200, 2900);
      return turf.bboxPolygon([a[0], a[1], b[0], b[1]]);
    },
    current() { return GeoAI.Sources.parseOSM(snapshot(2026, this.lon0, this.lat0)); },
    baseline() { return GeoAI.Sources.parseOSM(snapshot(2018, this.lon0, this.lat0)); },
    raw: snapshot
  };
})(typeof window !== 'undefined' ? window : globalThis);
