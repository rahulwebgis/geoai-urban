/* Data acquisition
 *  - OpenStreetMap through the Overpass API (current or historical snapshot)
 *  - User-supplied building footprints (Overture Maps, Microsoft, Google, …) as GeoJSON
 *  - Sentinel-2 L2A from the Earth Search STAC catalogue, read directly from
 *    cloud-optimised GeoTIFFs (red, NIR, SWIR and the scene classification layer)
 */
(function (root) {
  const GeoAI = (root.GeoAI = root.GeoAI || {});
  const C = () => GeoAI.CONFIG;

  const HIGHWAYS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|pedestrian|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
  const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link']);
  const EDUCATION = new Set(['school', 'kindergarten', 'college', 'university', 'childcare']);
  const HEALTH = new Set(['hospital', 'clinic', 'doctors', 'pharmacy', 'dentist', 'health_post']);

  /* ---------------- Overpass: small split queries, tiling, retries ----------------
   * Public Overpass servers answer 504/429 when a query is heavy or they are busy.
   * To stay well under their limits the AOI bounding box is cut into tiles of at
   * most ~2.5 × 2.5 km, each tile is asked three small questions (buildings, roads,
   * services + land cover) and every request is retried across several mirrors
   * with back-off. Results are merged and de-duplicated by OSM id; clipping to the
   * exact AOI polygon happens later in pre-processing. */
  const GROUPS = [
    { name: 'buildings', body: (b) => `way["building"](${b});relation["building"]["type"="multipolygon"](${b});` },
    { name: 'roads', body: (b) => `way["highway"~"^(${HIGHWAYS})$"](${b});` },
    { name: 'services and land cover', body: (b) => `nwr["amenity"](${b});nwr["healthcare"](${b});node["shop"](${b});way["leisure"~"^(park|garden|nature_reserve|recreation_ground|golf_course)$"](${b});way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|orchard|farmland|cemetery|reservoir|basin)$"](${b});way["natural"~"^(wood|scrub|grassland|heath|water|wetland|beach)$"](${b});` }
  ];

  function buildQuery(bbox, group, date) {
    const b = `${bbox[1].toFixed(6)},${bbox[0].toFixed(6)},${bbox[3].toFixed(6)},${bbox[2].toFixed(6)}`;
    const settings = `[out:json][timeout:90][maxsize:268435456]` + (date ? `[date:"${date}T00:00:00Z"]` : '');
    return `${settings};(${group.body(b)});out geom qt;`;
  }

  function tiles(aoi) {
    const bb = turf.bbox(aoi);
    const lat = (bb[1] + bb[3]) / 2;
    const wKm = (bb[2] - bb[0]) * 111.32 * Math.cos((lat * Math.PI) / 180), hKm = (bb[3] - bb[1]) * 110.57;
    const nx = Math.max(1, Math.ceil(wKm / 2.5)), ny = Math.max(1, Math.ceil(hKm / 2.5));
    const out = [];
    const aoiF = aoi.type === 'Feature' ? aoi : turf.feature(aoi);
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const t = [bb[0] + ((bb[2] - bb[0]) * i) / nx, bb[1] + ((bb[3] - bb[1]) * j) / ny, bb[0] + ((bb[2] - bb[0]) * (i + 1)) / nx, bb[1] + ((bb[3] - bb[1]) * (j + 1)) / ny];
      if (turf.booleanIntersects(turf.bboxPolygon(t), aoiF)) out.push(t); // skip tiles outside an irregular AOI
    }
    return out;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let mirrorIndex = 0; // remember the last server that worked

  async function overpass(query, onStatus, label) {
    const urls = C().overpass;
    let lastErr;
    for (let attempt = 0; attempt < urls.length * 2; attempt++) {
      const url = urls[(mirrorIndex + attempt) % urls.length];
      const host = new URL(url).host;
      try {
        onStatus && onStatus(`${label} · ${host}${attempt ? ' (retry ' + attempt + ')' : ''}`);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 100000);
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status + (res.status === 504 ? ' (server busy)' : res.status === 429 ? ' (rate limited)' : ''));
        const json = await res.json();
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark.slice(0, 120));
        mirrorIndex = (mirrorIndex + attempt) % urls.length;
        return json;
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new Error('request timed out') : e;
        await sleep(Math.min(8000, 1500 * (attempt + 1)));
      }
    }
    throw new Error(`OpenStreetMap servers did not answer (${lastErr && lastErr.message}). They are often busy for a few minutes: try again shortly, draw a smaller area, or load your own data files under "Data source".`);
  }

  async function fetchOSMJson(aoi, date, onStatus) {
    const ts = tiles(aoi);
    const seen = new Set(), elements = [];
    let n = 0;
    for (const t of ts) {
      for (const g of GROUPS) {
        n++;
        const label = `Downloading ${g.name}${ts.length > 1 ? ` (tile ${Math.ceil(n / GROUPS.length)} of ${ts.length})` : ''}${date ? ' for ' + date : ''}`;
        const json = await overpass(buildQuery(t, g, date), onStatus, label);
        for (const el of json.elements || []) {
          const k = el.type + el.id;
          if (seen.has(k)) continue;
          seen.add(k); elements.push(el);
        }
      }
    }
    return { elements };
  }

  const closeRing = (r) => {
    if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push(r[0].slice());
    return r;
  };

  /* Convert Overpass JSON into typed GeoJSON-like collections */
  function parseOSM(json) {
    const out = { buildings: [], roads: [], amenities: [], green: [], water: [], raw: json.elements.length };
    for (const el of json.elements) {
      const t = el.tags || {};
      const geomRing = el.geometry ? el.geometry.map((g) => [g.lon, g.lat]) : null;

      let isBuilding = false;
      if (t.building && el.type === 'way' && geomRing) {
        out.buildings.push({ type: 'Feature', properties: { source: 'OSM', osm_id: 'w' + el.id, levels: parseFloat(t['building:levels']) || null, kind: t.building }, geometry: { type: 'Polygon', coordinates: [closeRing(geomRing.map((c) => c.slice()))] } });
        isBuilding = true;
      } else if (t.building && el.type === 'relation' && el.members) {
        // outer rings only; courtyards (inner rings) are ignored for footprint area
        for (const m of el.members) {
          if (m.role === 'outer' && m.geometry && m.geometry.length > 3) {
            out.buildings.push({ type: 'Feature', properties: { source: 'OSM', osm_id: 'r' + el.id, levels: parseFloat(t['building:levels']) || null, kind: t.building }, geometry: { type: 'Polygon', coordinates: [closeRing(m.geometry.map((g) => [g.lon, g.lat]))] } });
          }
        }
        isBuilding = true;
      }
      // a building tagged as a school or clinic still counts as a service below
      if (isBuilding && !(t.amenity || t.healthcare || t.shop)) continue;
      if (t.highway && el.type === 'way' && geomRing) {
        out.roads.push({ type: 'Feature', properties: { osm_id: el.id, highway: t.highway, major: MAJOR.has(t.highway), name: t.name || null, nodes: el.nodes || [] }, geometry: { type: 'LineString', coordinates: geomRing } });
        continue;
      }
      if (t.amenity || t.healthcare || t.shop) {
        let lon, lat;
        if (el.type === 'node') { lon = el.lon; lat = el.lat; }
        else if (el.bounds) { lon = (el.bounds.minlon + el.bounds.maxlon) / 2; lat = (el.bounds.minlat + el.bounds.maxlat) / 2; }
        else continue;
        const a = t.amenity || '';
        const cat = EDUCATION.has(a) ? 'education' : HEALTH.has(a) || t.healthcare ? 'health' : t.shop ? 'shop:' + t.shop : 'amenity:' + a;
        out.amenities.push({ type: 'Feature', properties: { osm_id: el.type[0] + el.id, category: cat, name: t.name || null, tag: a || t.healthcare || t.shop }, geometry: { type: 'Point', coordinates: [lon, lat] } });
        continue;
      }
      if (geomRing && geomRing.length > 3 && el.type === 'way') {
        const isWater = t.natural === 'water' || t.natural === 'wetland' || t.landuse === 'reservoir' || t.landuse === 'basin';
        const ring = closeRing(geomRing);
        if (ring.length < 4) continue;
        const f = { type: 'Feature', properties: { osm_id: el.id, kind: t.leisure || t.landuse || t.natural }, geometry: { type: 'Polygon', coordinates: [ring] } };
        (isWater ? out.water : out.green).push(f);
      }
    }
    return out;
  }

  async function fetchOSM(aoi, date, onStatus) {
    return parseOSM(await fetchOSMJson(aoi, date, onStatus));
  }

  /* ---------------- User data files ----------------
   * Accepts an Overpass JSON response, or GeoJSON with OSM-style tags (overpass-turbo
   * export, QGIS QuickOSM, HOT Export Tool) or plain footprints (Overture, Microsoft,
   * Google). Features are sorted into layers by their tags, or by geometry when untagged:
   * untagged polygons are buildings, untagged lines are roads, untagged points are services. */
  function parseUserData(json, sourceName) {
    if (json && Array.isArray(json.elements)) return parseOSM(json);
    const feats = json.type === 'FeatureCollection' ? json.features : json.type === 'Feature' ? [json] : [];
    const out = { buildings: [], roads: [], amenities: [], green: [], water: [], raw: feats.length };
    const key = (c) => c[0].toFixed(7) + ',' + c[1].toFixed(7);
    let rid = 0;
    for (const f of feats) {
      if (!f || !f.geometry) continue;
      const t = Object.assign({}, f.properties || {}, (f.properties && f.properties.tags) || {});
      const gt = f.geometry.type;
      const polys = gt === 'Polygon' ? [f.geometry.coordinates] : gt === 'MultiPolygon' ? f.geometry.coordinates : [];
      const lines = gt === 'LineString' ? [f.geometry.coordinates] : gt === 'MultiLineString' ? f.geometry.coordinates : [];
      const svc = t.amenity || t.healthcare || t.shop;
      const isWater = t.natural === 'water' || t.natural === 'wetland' || t.landuse === 'reservoir' || t.landuse === 'basin' || t.waterway === 'riverbank';
      const isGreen = !!((t.leisure && /park|garden|nature_reserve|recreation_ground|golf_course/.test(t.leisure)) || (t.landuse && /grass|forest|meadow|recreation_ground|village_green|orchard|farmland|cemetery/.test(t.landuse)) || (t.natural && /wood|scrub|grassland|heath|beach/.test(t.natural)));
      if (svc || gt === 'Point' || gt === 'MultiPoint') {
        const c = gt === 'Point' ? f.geometry.coordinates : turf.centroid(f).geometry.coordinates;
        const a = t.amenity || '';
        const cat = EDUCATION.has(a) ? 'education' : HEALTH.has(a) || t.healthcare ? 'health' : t.shop ? 'shop:' + t.shop : 'amenity:' + (a || t.category || t.class || 'other');
        out.amenities.push({ type: 'Feature', properties: { category: cat, name: t.name || null, tag: a || t.healthcare || t.shop || t.category || '' }, geometry: { type: 'Point', coordinates: [c[0], c[1]] } });
        if (!t.building || !polys.length) continue;
      }
      if (polys.length) {
        for (const pc of polys) {
          if (!pc[0] || pc[0].length < 4) continue;
          const ring = closeRing(pc[0].map((c) => [c[0], c[1]]));
          const feat = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
          if (isWater) out.water.push(Object.assign(feat, { properties: { kind: t.natural || t.landuse } }));
          else if (isGreen && !t.building) out.green.push(Object.assign(feat, { properties: { kind: t.leisure || t.landuse || t.natural } }));
          else if (t.building || !(t.landuse || t.leisure || t.natural || t.highway)) {
            const lv = parseFloat(t['building:levels'] || t.num_floors || t.levels || (t.height ? t.height / 3.2 : '')) || null;
            feat.properties = { source: sourceName, ext_id: t.id || t['@id'] || null, levels: lv, kind: t.building || t.class || 'building' };
            out.buildings.push(feat);
          }
        }
        continue;
      }
      for (const ln of lines) {
        if (ln.length < 2) continue;
        const hw = t.highway || t.class || t.fclass || 'road';
        out.roads.push({ type: 'Feature', properties: { osm_id: 'u' + rid++, highway: hw, major: MAJOR.has(hw) || /^(motorway|trunk|primary|secondary)/.test(hw), name: t.name || null, nodes: ln.map(key) }, geometry: { type: 'LineString', coordinates: ln.map((c) => [c[0], c[1]]) } });
      }
    }
    return out;
  }

  function mergeData(a, b) {
    if (!a) return b;
    return { buildings: a.buildings.concat(b.buildings), roads: a.roads.concat(b.roads), amenities: a.amenities.concat(b.amenities), green: a.green.concat(b.green), water: a.water.concat(b.water), raw: (a.raw || 0) + (b.raw || 0) };
  }

  /* Read a user-supplied GeoJSON of building footprints (Overture, MS, Google …) */
  function parseBuildingUpload(geojson, sourceName) {
    const feats = geojson.type === 'FeatureCollection' ? geojson.features : geojson.type === 'Feature' ? [geojson] : [];
    const out = [];
    for (const f of feats) {
      if (!f.geometry) continue;
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
      const p = f.properties || {};
      const lv = parseFloat(p.num_floors || p['building:levels'] || p.levels || p.height / 3.2) || null;
      for (const pc of polys) {
        if (!pc[0] || pc[0].length < 4) continue;
        out.push({ type: 'Feature', properties: { source: sourceName, ext_id: p.id || null, levels: lv, kind: p.class || p.subtype || 'building' }, geometry: { type: 'Polygon', coordinates: [closeRing(pc[0].map((c) => [c[0], c[1]]))] } });
      }
    }
    return out;
  }

  /* ---------------- Sentinel-2 (Earth Search STAC + COGs) ---------------- */
  const SCL_BAD = new Set([0, 1, 3, 8, 9, 10, 11]); // no data, saturated, shadow, cloud med/high, cirrus, snow

  async function searchS2(aoi, start, end) {
    const body = {
      collections: ['sentinel-2-l2a'],
      bbox: turf.bbox(aoi),
      datetime: `${start}T00:00:00Z/${end}T23:59:59Z`,
      query: { 'eo:cloud_cover': { lt: 30 } },
      sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }],
      limit: 12
    };
    const res = await fetch(C().stac, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error('STAC search failed (HTTP ' + res.status + ')');
    const json = await res.json();
    return json.features || [];
  }

  function epsgOf(item) {
    const p = item.properties;
    const code = p['proj:epsg'] || (p['proj:code'] && parseInt(String(p['proj:code']).split(':')[1], 10));
    return code;
  }
  function utmDef(epsg) {
    const south = epsg >= 32700;
    const zone = epsg % 100;
    return `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs`;
  }

  /* Read one band window covering the AOI from a COG */
  async function readWindow(href, aoiBboxUtm) {
    const tiff = await GeoTIFF.fromUrl(href, { allowFullFile: false });
    const img = await tiff.getImage();
    const [ox, oy] = img.getOrigin();
    const [rx, ry] = img.getResolution();
    const w = img.getWidth(), h = img.getHeight();
    let x0 = Math.floor((aoiBboxUtm[0] - ox) / rx), x1 = Math.ceil((aoiBboxUtm[2] - ox) / rx);
    let y0 = Math.floor((aoiBboxUtm[3] - oy) / ry), y1 = Math.ceil((aoiBboxUtm[1] - oy) / ry);
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
    if (x1 <= x0 || y1 <= y0) return null;
    const data = await img.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: true });
    return { data, x0, y0, width: x1 - x0, height: y1 - y0, ox, oy, rx, ry };
  }
  function sampleWindow(win, x, y) {
    if (!win) return null;
    const px = Math.floor((x - win.ox) / win.rx) - win.x0;
    const py = Math.floor((y - win.oy) / win.ry) - win.y0;
    if (px < 0 || py < 0 || px >= win.width || py >= win.height) return null;
    return win.data[py * win.width + px];
  }

  /* Returns a sampler(lon, lat) → {ndvi, ndbi} | null.
   * Several scenes are loaded (least cloudy first). Each sample point takes the
   * first scene that has valid, cloud-free data there — a simple per-pixel mosaic. */
  async function loadSpectral(aoi, start, end, onStatus) {
    onStatus && onStatus('Searching Sentinel-2 scenes…');
    const items = await searchS2(aoi, start, end);
    if (!items.length) throw new Error('No Sentinel-2 scenes with <30% cloud between ' + start + ' and ' + end + '.');
    const aoiBbox = turf.bbox(aoi);
    const scenes = [];
    for (const item of items.slice(0, 4)) {
      const epsg = epsgOf(item);
      if (!epsg) continue;
      const def = utmDef(epsg);
      const corners = [[aoiBbox[0], aoiBbox[1]], [aoiBbox[2], aoiBbox[1]], [aoiBbox[2], aoiBbox[3]], [aoiBbox[0], aoiBbox[3]]].map((c) => proj4('EPSG:4326', def, c));
      const ub = [Math.min(...corners.map((c) => c[0])) - 30, Math.min(...corners.map((c) => c[1])) - 30, Math.max(...corners.map((c) => c[0])) + 30, Math.max(...corners.map((c) => c[1])) + 30];
      const a = item.assets;
      if (!a.red || !a.nir || !a.swir16 || !a.scl) continue;
      onStatus && onStatus(`Reading Sentinel-2 ${item.properties.datetime.slice(0, 10)} (cloud ${Math.round(item.properties['eo:cloud_cover'])}%)…`);
      const [red, nir, swir, scl] = await Promise.all([readWindow(a.red.href, ub), readWindow(a.nir.href, ub), readWindow(a.swir16.href, ub), readWindow(a.scl.href, ub)]);
      if (!red || !nir || !swir || !scl) continue;
      scenes.push({ def, red, nir, swir, scl, date: item.properties.datetime.slice(0, 10), cloud: item.properties['eo:cloud_cover'], id: item.id });
    }
    if (!scenes.length) throw new Error('Sentinel-2 scenes found but none could be read for this area.');
    // L2A from processing baseline 04.00 (2022-01-25) carries a +1000 offset
    const sampler = (lon, lat) => {
      for (const s of scenes) {
        const [x, y] = proj4('EPSG:4326', s.def, [lon, lat]);
        const q = sampleWindow(s.scl, x, y);
        if (q == null || SCL_BAD.has(q)) continue;
        const off = s.date >= '2022-01-25' ? 1000 : 0;
        const r = sampleWindow(s.red, x, y), n = sampleWindow(s.nir, x, y), w = sampleWindow(s.swir, x, y);
        if (!r || !n || !w) continue;
        const R = (r - off) / 1e4, N = (n - off) / 1e4, W = (w - off) / 1e4;
        if (N + R === 0 || W + N === 0) continue;
        return { ndvi: (N - R) / (N + R), ndbi: (W - N) / (W + N) };
      }
      return null;
    };
    sampler.scenes = scenes.map((s) => ({ id: s.id, date: s.date, cloud: Math.round(s.cloud) }));
    return sampler;
  }

  GeoAI.Sources = { fetchOSM, fetchOSMJson, parseOSM, parseUserData, mergeData, buildQuery, tiles, parseBuildingUpload, loadSpectral, MAJOR };
})(typeof window !== 'undefined' ? window : globalThis);
