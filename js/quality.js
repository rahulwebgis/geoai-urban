/* Data quality: geometry validation and repair, clipping to the AOI,
 * multi-source building fusion and spatial deduplication. */
(function (root) {
  const GeoAI = (root.GeoAI = root.GeoAI || {});
  const Geo = () => GeoAI.Geo;

  function cleanRing(ring) {
    const out = [];
    for (const c of ring) {
      const p = out[out.length - 1];
      if (!p || p[0] !== c[0] || p[1] !== c[1]) out.push(c);
    }
    if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0]);
    return out;
  }

  /* Validate one footprint; returns {feature, status} where status ∈ ok|repaired|dropped:* */
  function validateBuilding(f) {
    let ring = cleanRing(f.geometry.coordinates[0]);
    if (ring.length < 4) return { status: 'dropped:too_few_vertices' };
    if (ring.some((c) => !isFinite(c[0]) || !isFinite(c[1]) || Math.abs(c[1]) > 90)) return { status: 'dropped:bad_coordinates' };
    let status = 'ok';
    if (ring.length <= 400) {
      const k = turf.kinks(turf.polygon([ring]));
      if (k.features.length) {
        // self-intersecting: split into simple pieces and keep the largest
        try {
          const parts = turf.unkinkPolygon(turf.polygon([ring])).features;
          parts.sort((a, b) => turf.area(b) - turf.area(a));
          ring = parts[0].geometry.coordinates[0];
          status = 'repaired';
        } catch (e) { return { status: 'dropped:self_intersection' }; }
      }
    }
    return { status, feature: { type: 'Feature', properties: f.properties, geometry: { type: 'Polygon', coordinates: [ring] } } };
  }

  /* Attach metric geometry (local metres) used by all later steps */
  function measure(f, proj) {
    const pts = f.geometry.coordinates[0].map((c) => proj.fwd(c[0], c[1]));
    const area = Geo().ringArea(pts);
    const perim = Geo().ringPerimeter(pts);
    const cen = Geo().ringCentroid(pts);
    f._m = { pts, area, perim, cx: cen[0], cy: cen[1], bb: Geo().bbox(pts) };
    const ll = proj.inv(cen[0], cen[1]);
    f._m.lon = ll[0]; f._m.lat = ll[1];
    return f;
  }

  function overlapArea(a, b) {
    try {
      const x = turf.intersect(turf.polygon(a.geometry.coordinates), turf.polygon(b.geometry.coordinates));
      return x ? turf.area(x) : 0;
    } catch (e) { return 0; }
  }

  /* Fuse building sets (in priority order) and remove spatial duplicates.
   * Two footprints are duplicates when IoU ≥ 0.5, or when the smaller one's
   * centroid falls inside the larger and it covers ≥ 60 % of the larger.
   * The footprint from the higher-priority source is kept. */
  async function fuseAndDeduplicate(sets, aoi, proj, onStatus) {
    const report = {
      input: {}, dropped: {}, repaired: 0, outsideAoi: 0, slivers: 0, oversized: 0,
      duplicates: 0, duplicatesBySource: {}, kept: 0, withLevels: 0
    };
    const aoiF = aoi.type === 'Feature' ? aoi : turf.feature(aoi);
    const all = [];
    sets.forEach((set, priority) => {
      report.input[set.name] = set.features.length;
      for (const f of set.features) {
        const v = validateBuilding(f);
        if (!v.feature) { report.dropped[v.status] = (report.dropped[v.status] || 0) + 1; continue; }
        if (v.status === 'repaired') report.repaired++;
        const g = measure(v.feature, proj);
        if (g._m.area < 2) { report.slivers++; continue; }
        if (g._m.area > 50000) report.oversized++;
        g._priority = priority;
        all.push(g);
      }
    });
    // clip to AOI by centroid (the actual polygon, not its bounding box)
    const inside = [];
    for (let i = 0; i < all.length; i++) {
      const f = all[i];
      if (turf.booleanPointInPolygon([f._m.lon, f._m.lat], aoiF)) inside.push(f);
      else report.outsideAoi++;
      if (i % 4000 === 0) await Geo().tick();
    }
    onStatus && onStatus('Checking ' + inside.length.toLocaleString() + ' footprints for duplicates…');

    // spatial hash on centroids
    const G = Geo();
    const idx = new G.PointIndex(40);
    inside.forEach((f, i) => idx.add(f._m.cx, f._m.cy, i));
    // process higher priority / larger first so they win
    const order = inside.map((_, i) => i).sort((a, b) => inside[a]._priority - inside[b]._priority || inside[b]._m.area - inside[a]._m.area);
    const removed = new Uint8Array(inside.length);
    let step = 0;
    for (const i of order) {
      if (removed[i]) continue;
      const a = inside[i];
      const bb = a._m.bb;
      const s = idx.size;
      outer:
      for (let gx = Math.floor(bb[0] / s) - 1; gx <= Math.floor(bb[2] / s) + 1; gx++) {
        for (let gy = Math.floor(bb[1] / s) - 1; gy <= Math.floor(bb[3] / s) + 1; gy++) {
          const bucket = idx.map.get(gx + ',' + gy); if (!bucket) continue;
          for (const [x, y, j] of bucket) {
            if (j === i || removed[j]) continue;
            const b = inside[j];
            if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue; // centroid must be within a's bbox
            if (!Geo().pointInRing(x, y, a._m.pts)) continue;
            const small = Math.min(a._m.area, b._m.area), big = Math.max(a._m.area, b._m.area);
            const ov = overlapArea(a, b);
            const iou = ov / (a._m.area + b._m.area - ov || 1);
            if (iou >= 0.5 || (ov / small >= 0.8 && small / big >= 0.6)) {
              // the lower-priority source loses; within one source the smaller one loses
              const bLoses = b._priority > a._priority || (b._priority === a._priority && b._m.area <= a._m.area);
              const loser = bLoses ? j : i;
              removed[loser] = 1;
              report.duplicates++;
              const src = inside[loser].properties.source || 'unknown';
              report.duplicatesBySource[src] = (report.duplicatesBySource[src] || 0) + 1;
              if (!bLoses) break outer;
            }
          }
        }
      }
      if (++step % 2000 === 0) await Geo().tick();
    }
    const kept = inside.filter((_, i) => !removed[i]);
    report.kept = kept.length;
    report.withLevels = kept.filter((f) => f.properties.levels).length;
    report.bySource = {};
    kept.forEach((f) => { report.bySource[f.properties.source] = (report.bySource[f.properties.source] || 0) + 1; });
    return { buildings: kept, report };
  }

  function prepareRoads(roads, aoi, proj) {
    const aoiF = aoi.type === 'Feature' ? aoi : turf.feature(aoi);
    const out = []; let dropped = 0, named = 0;
    for (const r of roads) {
      const c = r.geometry.coordinates;
      if (c.length < 2) { dropped++; continue; }
      const pts = c.map((p) => proj.fwd(p[0], p[1]));
      const len = Geo().ringPerimeter(pts);
      if (len < 0.5) { dropped++; continue; }
      // keep roads that touch the AOI; per-segment clipping happens in feature extraction
      const bb = turf.bbox(r);
      if (!turf.booleanIntersects(turf.bboxPolygon(bb), aoiF)) { dropped++; continue; }
      r._m = { pts, len };
      if (r.properties.name) named++;
      out.push(r);
    }
    return { roads: out, report: { kept: out.length, dropped, namedShare: out.length ? named / out.length : 0 } };
  }

  function preparePolys(polys, proj) {
    const out = [];
    for (const f of polys) {
      const ring = cleanRing(f.geometry.coordinates[0]);
      if (ring.length < 4) continue;
      const pts = ring.map((c) => proj.fwd(c[0], c[1]));
      f._m = { pts, bb: Geo().bbox(pts) };
      out.push(f);
    }
    return out;
  }

  GeoAI.Quality = { fuseAndDeduplicate, prepareRoads, preparePolys, validateBuilding };
})(typeof window !== 'undefined' ? window : globalThis);
