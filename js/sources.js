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

  function polyFilter(aoi) {
    // Overpass poly filter wants "lat lon lat lon …"; simplify very detailed AOIs
    let g = aoi.type === 'Feature' ? aoi : turf.feature(aoi);
    let ring = g.geometry.type === 'Polygon' ? g.geometry.coordinates[0] : null;
    if (!ring || ring.length > 200) {
      g = turf.simplify(turf.convex(g) || g, { tolerance: 0.0005, highQuality: true });
      ring = g.geometry.coordinates[0];
    }
    return ring.map((c) => c[1].toFixed(6) + ' ' + c[0].toFixed(6)).join(' ');
  }

  function buildQuery(aoi, date) {
    const p = `(poly:"${polyFilter(aoi)}")`;
    const settings = `[out:json][timeout:180][maxsize:1073741824]` + (date ? `[date:"${date}T00:00:00Z"]` : '');
    return `${settings};
(
  way["building"]${p};
  relation["building"]["type"="multipolygon"]${p};
  way["highway"~"^(${HIGHWAYS})$"]${p};
  nwr["amenity"]${p};
  nwr["healthcare"]${p};
  nwr["shop"]${p};
  way["leisure"~"^(park|garden|nature_reserve|recreation_ground|golf_course)$"]${p};
  way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|orchard|farmland|cemetery)$"]${p};
  way["natural"~"^(wood|scrub|grassland|heath|water|wetland|beach)$"]${p};
  way["landuse"~"^(reservoir|basin)$"]${p};
);
out geom;`;
  }

  async function overpass(query, onStatus) {
    let lastErr;
    for (const url of C().overpass) {
      try {
        onStatus && onStatus('Querying ' + new URL(url).host + '…');
        const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (!res.ok) throw new Error('Overpass returned HTTP ' + res.status);
        const json = await res.json();
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark);
        return json;
      } catch (e) { lastErr = e; }
    }
    throw new Error('All Overpass servers failed. Last error: ' + (lastErr && lastErr.message) + '. Try a smaller area or retry in a minute.');
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
    const json = await overpass(buildQuery(aoi, date), onStatus);
    return parseOSM(json);
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

  GeoAI.Sources = { fetchOSM, parseOSM, buildQuery, parseBuildingUpload, loadSpectral, MAJOR };
})(typeof window !== 'undefined' ? window : globalThis);
