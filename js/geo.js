/* Geometry helpers, local metric projection, spatial indexes and the 250 m grid. */
(function (root) {
  const GeoAI = (root.GeoAI = root.GeoAI || {});
  const R = 6378137;
  const D2R = Math.PI / 180;

  const Geo = {};

  /* ---------- Web Mercator (grid alignment, stable cell ids) ---------- */
  Geo.toMerc = (lon, lat) => [R * lon * D2R, R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2))];
  Geo.fromMerc = (x, y) => [x / R / D2R, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / D2R];

  /* ---------- Local equirectangular projection (metres) ----------
   * Accurate to well under 1% across a city-sized AOI; used for lengths,
   * small-polygon areas and nearest-neighbour searches. */
  Geo.localProjection = function (lon0, lat0) {
    const kx = 111320 * Math.cos(lat0 * D2R);
    const ky = 110574;
    return {
      lon0, lat0, kx, ky,
      fwd: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
      inv: (x, y) => [lon0 + x / kx, lat0 + y / ky]
    };
  };

  Geo.ringArea = function (pts) { // pts in metres
    let a = 0;
    for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    return Math.abs(a / 2);
  };
  Geo.ringPerimeter = function (pts) {
    let p = 0;
    for (let i = 1; i < pts.length; i++) p += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return p;
  };
  Geo.ringCentroid = function (pts) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) {
      const f = pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
      a += f; cx += (pts[j][0] + pts[i][0]) * f; cy += (pts[j][1] + pts[i][1]) * f;
    }
    if (Math.abs(a) < 1e-9) { // degenerate: vertex mean
      const m = pts.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0]);
      return [m[0] / pts.length, m[1] / pts.length];
    }
    return [cx / (3 * a), cy / (3 * a)];
  };
  Geo.pointInRing = function (x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  Geo.bbox = function (pts) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const p of pts) { if (p[0] < a) a = p[0]; if (p[1] < b) b = p[1]; if (p[0] > c) c = p[0]; if (p[1] > d) d = p[1]; }
    return [a, b, c, d];
  };

  /* ---------- Point bucket index for nearest-neighbour queries ---------- */
  Geo.PointIndex = function (size) {
    this.size = size; this.map = new Map(); this.n = 0;
  };
  Geo.PointIndex.prototype.add = function (x, y, data) {
    const k = Math.floor(x / this.size) + ',' + Math.floor(y / this.size);
    let b = this.map.get(k); if (!b) this.map.set(k, (b = []));
    b.push([x, y, data]); this.n++;
  };
  /* nearest point (excluding `skip`), searched in expanding rings up to maxDist */
  Geo.PointIndex.prototype.nearest = function (x, y, maxDist, skip) {
    if (!this.n) return null;
    const s = this.size, cx = Math.floor(x / s), cy = Math.floor(y / s);
    let best = null, bestD = Infinity;
    const maxRing = Math.ceil(maxDist / s) + 1;
    for (let r = 0; r <= maxRing; r++) {
      for (let i = cx - r; i <= cx + r; i++) {
        for (let j = cy - r; j <= cy + r; j++) {
          if (r > 0 && i !== cx - r && i !== cx + r && j !== cy - r && j !== cy + r) continue;
          const b = this.map.get(i + ',' + j); if (!b) continue;
          for (const p of b) {
            if (p[2] === skip && skip !== undefined) continue;
            const d = Math.hypot(p[0] - x, p[1] - y);
            if (d < bestD) { bestD = d; best = p; }
          }
        }
      }
      // any point outside ring r is at least r*s away
      if (best && bestD <= r * s) break;
    }
    return best && bestD <= maxDist ? { d: bestD, p: best } : null;
  };

  /* ---------- 250 m analysis grid ----------
   * Cells are aligned to a fixed Mercator origin so the same location always
   * gets the same cell id (needed for change detection between runs).
   * The Mercator step is scaled by 1/cos(lat) so cells are ~size × size metres. */
  Geo.Grid = function (aoi, size) {
    const tb = turf.bbox(aoi);
    const latRef = Math.round(((tb[1] + tb[3]) / 2) * 2) / 2; // 0.5° steps keep ids stable
    this.size = size;
    this.latRef = latRef;
    this.step = size / Math.cos(latRef * D2R);
    this.aoi = aoi;
    this.cells = [];
    this.byId = new Map();
    const [x0, y0] = Geo.toMerc(tb[0], tb[1]);
    const [x1, y1] = Geo.toMerc(tb[2], tb[3]);
    const i0 = Math.floor(x0 / this.step), i1 = Math.floor(x1 / this.step);
    const j0 = Math.floor(y0 / this.step), j1 = Math.floor(y1 / this.step);
    const aoiFeature = aoi.type === 'Feature' ? aoi : turf.feature(aoi);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const sw = Geo.fromMerc(i * this.step, j * this.step);
        const ne = Geo.fromMerc((i + 1) * this.step, (j + 1) * this.step);
        const poly = turf.bboxPolygon([sw[0], sw[1], ne[0], ne[1]]);
        if (!turf.booleanIntersects(poly, aoiFeature)) continue;
        let areaIn, clipped = null;
        if (turf.booleanWithin(poly, aoiFeature)) {
          areaIn = turf.area(poly);
        } else {
          clipped = turf.intersect(poly, aoiFeature);
          if (!clipped) continue;
          areaIn = turf.area(clipped);
        }
        if (areaIn < 1) continue;
        const cell = {
          id: i + '_' + j, i, j,
          bounds: [sw[0], sw[1], ne[0], ne[1]],
          polygon: poly.geometry,
          clipped: clipped ? clipped.geometry : null,
          area: areaIn,           // m² of the cell inside the AOI
          fullArea: turf.area(poly),
          ind: {}
        };
        this.cells.push(cell);
        this.byId.set(cell.id, cell);
      }
    }
  };
  Geo.Grid.prototype.cellIdAt = function (lon, lat) {
    const [x, y] = Geo.toMerc(lon, lat);
    return Math.floor(x / this.step) + '_' + Math.floor(y / this.step);
  };
  Geo.Grid.prototype.cellAt = function (lon, lat) {
    return this.byId.get(this.cellIdAt(lon, lat)) || null;
  };
  /* true if the point lies inside the AOI part of the cell */
  Geo.Grid.prototype.insideAoi = function (cell, lon, lat) {
    if (!cell.clipped) return true;
    return turf.booleanPointInPolygon([lon, lat], cell.clipped);
  };
  Geo.Grid.prototype.neighbours = function (cell) {
    const out = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      const n = this.byId.get((cell.i + di) + '_' + (cell.j + dj));
      if (n) out.push(n);
    }
    return out;
  };

  /* Seeded RNG (mulberry32) so model runs are reproducible */
  Geo.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  Geo.median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  Geo.std = (arr) => {
    if (arr.length < 2) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1));
  };

  /* yield to the browser so long loops don't freeze the page */
  Geo.tick = () => new Promise((r) => setTimeout(r, 0));

  GeoAI.Geo = Geo;
})(typeof window !== 'undefined' ? window : globalThis);
