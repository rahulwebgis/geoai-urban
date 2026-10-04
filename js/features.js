/* Feature engineering: the 30 urban and spatial indicators per analysis cell. */
(function (root) {
  const GeoAI = (root.GeoAI = root.GeoAI || {});

  function cellPolyIndex(grid, polys) {
    // map cell id → polygons whose bbox touches that cell
    const G = GeoAI.Geo, idx = new Map();
    for (const f of polys) {
      const bb = turf.bbox(f);
      const [x0, y0] = G.toMerc(bb[0], bb[1]), [x1, y1] = G.toMerc(bb[2], bb[3]);
      const i0 = Math.floor(x0 / grid.step), i1 = Math.floor(x1 / grid.step);
      const j0 = Math.floor(y0 / grid.step), j1 = Math.floor(y1 / grid.step);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const id = i + '_' + j;
        if (!grid.byId.has(id)) continue;
        let a = idx.get(id); if (!a) idx.set(id, (a = []));
        a.push(f);
      }
    }
    return idx;
  }

  /* n×n sample points inside the AOI part of a cell (lon/lat) */
  function samplePoints(grid, cell, n) {
    const [w, s, e, nn] = cell.bounds, pts = [];
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      const lon = w + ((a + 0.5) / n) * (e - w), lat = s + ((b + 0.5) / n) * (nn - s);
      if (grid.insideAoi(cell, lon, lat)) pts.push([lon, lat]);
    }
    return pts;
  }

  /**
   * @param ctx {grid, proj, buildings, roads, amenities, green, water, spectral}
   */
  async function compute(ctx, onStatus) {
    const { grid, proj } = ctx;
    const G = GeoAI.Geo, CFG = GeoAI.CONFIG;
    const cap = CFG.distanceCap;
    const acc = new Map();
    for (const c of grid.cells) {
      acc.set(c.id, { areas: [], perims: [], compact: [], levels: [], floor: 0, nn: [], roadLen: 0, majorLen: 0, inter: 0, amen: 0, types: new Set() });
      c.flags = [];
    }

    /* ---- buildings ---- */
    onStatus && onStatus('Measuring building morphology…');
    const bIdx = new G.PointIndex(50);
    ctx.buildings.forEach((b, i) => bIdx.add(b._m.cx, b._m.cy, i));
    for (let i = 0; i < ctx.buildings.length; i++) {
      const b = ctx.buildings[i];
      const cell = grid.cellAt(b._m.lon, b._m.lat);
      b._cell = cell ? cell.id : null;
      if (!cell) continue;
      const a = acc.get(cell.id), m = b._m;
      a.areas.push(m.area);
      a.perims.push(m.perim);
      a.compact.push(m.perim > 0 ? Math.min(1, (4 * Math.PI * m.area) / (m.perim * m.perim)) : 0);
      const lv = b.properties.levels && b.properties.levels > 0 ? Math.min(b.properties.levels, 200) : 1;
      a.levels.push(lv);
      a.floor += m.area * lv;
      const nn = bIdx.nearest(m.cx, m.cy, 500, i);
      a.nn.push(nn ? nn.d : 500);
      if (i % 3000 === 0) await G.tick();
    }

    /* ---- roads: pieces ≤ 20 m assigned by midpoint ---- */
    onStatus && onStatus('Analysing the road network…');
    const majorIdx = new G.PointIndex(250);
    const nodeWays = new Map(), nodePos = new Map();
    for (let r = 0; r < ctx.roads.length; r++) {
      const road = ctx.roads[r], pts = road._m.pts, ll = road.geometry.coordinates;
      for (let k = 1; k < pts.length; k++) {
        const dx = pts[k][0] - pts[k - 1][0], dy = pts[k][1] - pts[k - 1][1];
        const L = Math.hypot(dx, dy); if (!L) continue;
        const n = Math.max(1, Math.ceil(L / 20));
        for (let q = 0; q < n; q++) {
          const t = (q + 0.5) / n;
          const x = pts[k - 1][0] + dx * t, y = pts[k - 1][1] + dy * t;
          const [lon, lat] = proj.inv(x, y);
          if (road.properties.major) majorIdx.add(x, y, r);
          const cell = grid.cellAt(lon, lat);
          if (!cell || !grid.insideAoi(cell, lon, lat)) continue;
          const a = acc.get(cell.id);
          a.roadLen += L / n;
          if (road.properties.major) a.majorLen += L / n;
        }
      }
      const nodes = road.properties.nodes || [];
      const seen = new Set();
      nodes.forEach((nid, k) => {
        if (seen.has(nid)) return; seen.add(nid);
        nodeWays.set(nid, (nodeWays.get(nid) || 0) + 1);
        if (!nodePos.has(nid) && ll[k]) nodePos.set(nid, ll[k]);
      });
      if (r % 500 === 0) await G.tick();
    }
    for (const [nid, cnt] of nodeWays) {
      if (cnt < 2) continue; // a node shared by two or more ways is a junction
      const p = nodePos.get(nid); if (!p) continue;
      const cell = grid.cellAt(p[0], p[1]);
      if (cell && grid.insideAoi(cell, p[0], p[1])) acc.get(cell.id).inter++;
    }

    /* ---- services ---- */
    onStatus && onStatus('Locating services…');
    const schoolIdx = new G.PointIndex(250), healthIdx = new G.PointIndex(250);
    for (const f of ctx.amenities) {
      const [lon, lat] = f.geometry.coordinates;
      const [x, y] = proj.fwd(lon, lat);
      const cat = f.properties.category;
      if (cat === 'education') schoolIdx.add(x, y, 1);
      if (cat === 'health') healthIdx.add(x, y, 1);
      const cell = grid.cellAt(lon, lat);
      if (!cell || !grid.insideAoi(cell, lon, lat)) continue;
      const a = acc.get(cell.id);
      a.amen++;
      a.types.add(cat.split(':')[0] === 'shop' ? 'shop' : cat);
    }

    /* ---- environment ---- */
    onStatus && onStatus('Sampling green space, water and spectral indices…');
    const gIdx = cellPolyIndex(grid, ctx.green), wIdx = cellPolyIndex(grid, ctx.water);
    const inAny = (list, x, y) => {
      if (!list) return false;
      for (const f of list) {
        const bb = f._m.bb;
        if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3]) continue;
        if (G.pointInRing(x, y, f._m.pts)) return true;
      }
      return false;
    };

    let ci = 0;
    for (const cell of grid.cells) {
      const a = acc.get(cell.id), I = cell.ind;
      const km2 = cell.area / 1e6;
      const n = a.areas.length;
      const built = a.areas.reduce((s, v) => s + v, 0);
      I.bld_count = n;
      I.bld_density = n / km2;
      I.builtup_area = built;
      I.coverage_ratio = Math.min(1, built / cell.area);
      I.mean_footprint = n ? built / n : 0;
      I.median_footprint = G.median(a.areas);
      I.std_footprint = G.std(a.areas);
      I.max_footprint = n ? Math.max(...a.areas) : 0;
      I.small_bld_share = n ? a.areas.filter((v) => v < CFG.smallBuilding).length / n : 0;
      I.large_bld_share = n ? a.areas.filter((v) => v > CFG.largeBuilding).length / n : 0;
      I.mean_perimeter = n ? a.perims.reduce((s, v) => s + v, 0) / n : 0;
      I.mean_compactness = n ? a.compact.reduce((s, v) => s + v, 0) / n : 0;
      I.mean_levels = n ? a.levels.reduce((s, v) => s + v, 0) / n : 0;
      I.floor_area_ratio = a.floor / cell.area;
      I.mean_nn_dist = n ? a.nn.reduce((s, v) => s + v, 0) / n : 500;
      I.road_length = a.roadLen;
      I.road_density = a.roadLen / 1000 / km2;
      I.intersection_count = a.inter;
      I.intersection_density = a.inter / km2;
      I.major_road_share = a.roadLen ? a.majorLen / a.roadLen : 0;
      const cxy = proj.fwd((cell.bounds[0] + cell.bounds[2]) / 2, (cell.bounds[1] + cell.bounds[3]) / 2);
      const dm = majorIdx.nearest(cxy[0], cxy[1], cap); I.dist_major_road = dm ? dm.d : cap;
      I.amenity_count = a.amen;
      I.service_diversity = a.types.size;
      const ds = schoolIdx.nearest(cxy[0], cxy[1], cap); I.dist_school = ds ? ds.d : cap;
      const dh = healthIdx.nearest(cxy[0], cxy[1], cap); I.dist_health = dh ? dh.d : cap;

      const pts = samplePoints(grid, cell, 6);
      let g = 0, w = 0, nd = [], nb = [];
      const gl = gIdx.get(cell.id), wl = wIdx.get(cell.id);
      for (const [lon, lat] of pts) {
        const [x, y] = proj.fwd(lon, lat);
        if (inAny(wl, x, y)) w++;
        else if (inAny(gl, x, y)) g++;
        if (ctx.spectral) {
          const s = ctx.spectral(lon, lat);
          if (s) { nd.push(s.ndvi); nb.push(s.ndbi); }
        }
      }
      I.green_share = pts.length ? g / pts.length : 0;
      I.water_share = pts.length ? w / pts.length : 0;
      I.ndvi_mean = nd.length ? nd.reduce((s, v) => s + v, 0) / nd.length : null;
      I.ndbi_mean = nb.length ? nb.reduce((s, v) => s + v, 0) / nb.length : null;

      // completeness flag: a road network but no mapped buildings often means missing footprints
      if (I.road_length > 400 && n === 0 && I.water_share < 0.5 && I.green_share < 0.5) cell.flags.push('possible_missing_buildings');
      if (++ci % 40 === 0) await G.tick();
    }

    // contextual: mean coverage of the 8 neighbouring cells
    for (const cell of grid.cells) {
      const nb = grid.neighbours(cell);
      cell.ind.neighbour_coverage = nb.length ? nb.reduce((s, c) => s + c.ind.coverage_ratio, 0) / nb.length : cell.ind.coverage_ratio;
    }
  }

  /* Summary statistics across cells for every indicator */
  function summarise(cells) {
    const out = {};
    for (const d of GeoAI.INDICATORS) {
      const v = cells.map((c) => c.ind[d.key]).filter((x) => x != null && isFinite(x));
      if (!v.length) { out[d.key] = null; continue; }
      const s = [...v].sort((a, b) => a - b);
      out[d.key] = { min: s[0], max: s[s.length - 1], mean: v.reduce((a, b) => a + b, 0) / v.length, median: GeoAI.Geo.median(s), n: v.length };
    }
    return out;
  }

  GeoAI.Features = { compute, summarise };
})(typeof window !== 'undefined' ? window : globalThis);
