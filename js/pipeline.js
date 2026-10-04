/* Orchestrates the methodological workflow from AOI to decision-ready outputs. */
(function (root) {
  const GeoAI = (root.GeoAI = root.GeoAI || {});

  GeoAI.STEPS = [
    'AOI', 'Data acquisition', 'Mosaicking', 'Pre-processing', 'Fusion & deduplication',
    'Road & spectral analysis', '250 m grid', '30 indicators', 'Ground truth',
    'Training & validation', 'GeoAI prediction', 'Change detection', 'Interactive map', 'Export', 'Decision support'
  ];

  const isoDate = (d) => d.toISOString().slice(0, 10);
  const shiftDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };

  async function buildPeriod(aoi, proj, grid, osm, extraSets, spectral, onStatus) {
    const sets = [{ name: 'OSM', features: osm.buildings }].concat(extraSets || []);
    const fused = await GeoAI.Quality.fuseAndDeduplicate(sets, aoi, proj, onStatus);
    const roads = GeoAI.Quality.prepareRoads(osm.roads, aoi, proj);
    const green = GeoAI.Quality.preparePolys(osm.green, proj);
    const water = GeoAI.Quality.preparePolys(osm.water, proj);
    // fresh copy of grid cells for this period
    const cells = grid.cells.map((c) => Object.assign({}, c, { ind: {}, flags: [] }));
    const g = Object.create(grid); g.cells = cells; g.byId = new Map(cells.map((c) => [c.id, c]));
    await GeoAI.Features.compute({ grid: g, proj, buildings: fused.buildings, roads: roads.roads, amenities: osm.amenities, green, water, spectral }, onStatus);
    return { cells, grid: g, buildings: fused.buildings, roads: roads.roads, amenities: osm.amenities, green, water, quality: { buildings: fused.report, roads: roads.report } };
  }

  /**
   * opts: { cellSize, baselineDate (YYYY-MM-DD|null), spectral (bool), extraSets: [{name, features}] }
   * hooks: { status(msg), step(index, state) }
   */
  async function run(aoi, opts, hooks) {
    const status = hooks.status || (() => {}), step = hooks.step || (() => {});
    const warnings = [];
    const aoiF = aoi.type === 'Feature' ? aoi : turf.feature(aoi);
    const areaKm2 = turf.area(aoiF) / 1e6;
    if (areaKm2 > GeoAI.CONFIG.maxAoiKm2) throw new Error(`The area is ${areaKm2.toFixed(1)} km². In-browser analysis supports up to ${GeoAI.CONFIG.maxAoiKm2} km²; use the Python pipeline for larger regions.`);
    step(0, 'done');

    const c = turf.centroid(aoiF).geometry.coordinates;
    const proj = GeoAI.Geo.localProjection(c[0], c[1]);
    const today = isoDate(new Date());

    /* acquisition */
    step(1, 'active');
    status('Downloading buildings, roads, services and land cover from OpenStreetMap…');
    const osm = await GeoAI.Sources.fetchOSM(aoiF, null, status);
    let osmBase = null;
    if (opts.baselineDate) {
      status('Downloading the OpenStreetMap snapshot for ' + opts.baselineDate + '…');
      osmBase = await GeoAI.Sources.fetchOSM(aoiF, opts.baselineDate, status);
    }
    step(1, 'done');

    /* spectral + mosaicking */
    let spectral = null, spectralBase = null;
    if (opts.spectral) {
      step(2, 'active');
      try {
        spectral = await GeoAI.Sources.loadSpectral(aoiF, shiftDays(today, -365), today, status);
      } catch (e) { warnings.push('Sentinel-2 imagery could not be loaded (' + e.message.replace(/\.$/, '') + '), so NDVI and NDBI were skipped. The other 28 indicators are unaffected.'); }
      if (opts.baselineDate && spectral) {
        if (opts.baselineDate < '2017-06-01') warnings.push('Sentinel-2 L2A is not available before mid-2017, so spectral indicators are excluded from change detection.');
        else {
          try { spectralBase = await GeoAI.Sources.loadSpectral(aoiF, shiftDays(opts.baselineDate, -180), shiftDays(opts.baselineDate, 180), status); }
          catch (e) { warnings.push('Baseline Sentinel-2 imagery could not be loaded (' + e.message.replace(/\.$/, '') + '), so spectral indicators are excluded from change detection.'); }
        }
      }
      step(2, spectral ? 'done' : 'skipped');
    } else step(2, 'skipped');

    /* grid */
    step(3, 'active'); step(6, 'active');
    status('Generating the ' + opts.cellSize + ' m analysis grid…');
    const grid = new GeoAI.Geo.Grid(aoiF, opts.cellSize);
    if (!grid.cells.length) throw new Error('The analysis grid is empty — draw a larger area.');
    step(6, 'done');

    /* pre-processing, fusion, features */
    step(4, 'active'); step(5, 'active'); step(7, 'active');
    const cur = await buildPeriod(aoiF, proj, grid, osm, opts.extraSets, spectral, status);
    step(3, 'done'); step(4, 'done'); step(5, 'done'); step(7, 'done');

    /* ground truth + model */
    step(8, 'active');
    GeoAI.Model.seedLabels(cur.cells);
    step(8, 'done'); step(9, 'active');
    status('Training the Random Forest model…');
    await GeoAI.Geo.tick();
    let keys = GeoAI.Model.featureKeys(cur.cells);
    if (opts.baselineDate && !spectralBase) keys = keys.filter((k) => !/^nd[vb]i/.test(k)); // keep periods comparable
    const result = GeoAI.Model.train(cur.cells, { keys });
    if (!result.ok) throw new Error(result.reason);
    step(9, 'done'); step(10, 'done');

    /* change detection */
    let changeRes = null, base = null, cmp = null;
    if (osmBase) {
      step(11, 'active');
      status('Comparing with ' + opts.baselineDate + '…');
      base = await buildPeriod(aoiF, proj, grid, osmBase, [], spectralBase, status);
      GeoAI.Model.apply(result, base.cells);
      // compare like with like: if extra footprint sources were fused into the current period,
      // rebuild an OSM-only current period for the comparison
      let curCmp = cur;
      if (opts.extraSets && opts.extraSets.length) {
        curCmp = cmp = await buildPeriod(aoiF, proj, grid, osm, [], spectral, status);
        GeoAI.Model.apply(result, curCmp.cells);
        const map = new Map(curCmp.cells.map((x) => [x.id, x]));
        changeRes = GeoAI.Model.change(base.cells, curCmp.cells);
        cur.cells.forEach((x) => { const m = map.get(x.id); x.change = m && m.change; });
        warnings.push('Change detection uses OpenStreetMap for both dates so uploaded footprints do not show up as false growth.');
      } else changeRes = GeoAI.Model.change(base.cells, cur.cells);
      step(11, 'done');
    } else step(11, 'skipped');

    return {
      aoi: aoiF, areaKm2, proj, grid, cur, base, cmp, model: result, change: changeRes,
      spectralScenes: spectral ? spectral.scenes : null,
      summary: GeoAI.Features.summarise(cur.cells),
      opts, warnings, runAt: new Date().toISOString()
    };
  }

  /* re-train after the user edits labels on the map */
  function retrain(state) {
    const result = GeoAI.Model.train(state.cur.cells, { keys: state.model.keys });
    if (!result.ok) throw new Error(result.reason);
    state.model = result;
    if (state.base) {
      GeoAI.Model.apply(result, state.base.cells);
      if (state.cmp) {
        GeoAI.Model.apply(result, state.cmp.cells);
        state.change = GeoAI.Model.change(state.base.cells, state.cmp.cells);
        const map = new Map(state.cmp.cells.map((x) => [x.id, x]));
        state.cur.cells.forEach((x) => { const m = map.get(x.id); x.change = m && m.change; });
      } else state.change = GeoAI.Model.change(state.base.cells, state.cur.cells);
    }
    return state;
  }

  GeoAI.Pipeline = { run, retrain };
})(typeof window !== 'undefined' ? window : globalThis);
