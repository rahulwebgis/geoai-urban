/* UI controller: navigation, map, controls, results and exports. */
(function () {
  const G = window.GeoAI;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const F = G.Report.fmt;
  const CLS = G.CONFIG.classes, CC = G.CONFIG.classColors;
  const IND = Object.fromEntries(G.INDICATORS.map((d) => [d.key, d]));

  const ARTIFACT = window.GEOAI_ENV === 'artifact'; // sandboxed build: no outside network
  const app = { map: null, aoi: null, aoiLayer: null, state: null, layers: {}, mode: 'class', indicator: 'coverage_ratio', extra: null, charts: {}, heroShown: false, source: ARTIFACT ? 'sample' : 'live', userData: null, baseData: null };

  /* ============================== navigation ============================== */
  function route() {
    const v = (location.hash || (ARTIFACT ? '#platform' : '#home')).slice(1);
    if (!['home', 'platform', 'methodology'].includes(v)) { if (!$('.view:not([hidden])')) location.hash = '#home'; return; } // ignore '#close' etc.
    const view = v;
    $$('.view').forEach((s) => (s.hidden = s.dataset.view !== view));
    $$('.site-nav a').forEach((a) => a.setAttribute('aria-current', a.dataset.nav === view ? 'page' : 'false'));
    document.body.classList.toggle('on-platform', view === 'platform');
    $('#site-nav').classList.remove('open');
    $('.nav-toggle').setAttribute('aria-expanded', 'false');
    if (view === 'platform') {
      initMap();
      if (ARTIFACT && !app.autoRan && app.source === 'sample') { app.autoRan = true; setTimeout(() => $('#run').click(), 300); } // open in a working state
      setTimeout(() => { app.map.invalidateSize(); if (app.aoiLayer && !app.state) app.map.fitBounds(app.aoiLayer.getBounds(), { padding: [30, 30] }); }, 50);
    }
    if (view === 'home' && !app.heroShown && window.GeoAIHero) { app.heroShown = true; window.GeoAIHero.replay(); }
    if (view !== 'platform') window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);
  $('.nav-toggle').addEventListener('click', (e) => {
    const open = $('#site-nav').classList.toggle('open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });

  /* indicator catalogue on the methodology page */
  $('#indicator-catalogue').innerHTML = Object.entries(G.GROUPS).map(([g, name]) => {
    const items = G.INDICATORS.map((d, i) => [d, i]).filter(([d]) => d.group === g);
    return `<section><h3>${name}</h3><ol start="${items[0][1] + 1}">${items.map(([d]) => `<li>${d.label}${d.unit && !d.pct ? ` <span class="muted">(${d.unit})</span>` : ''}</li>`).join('')}</ol></section>`;
  }).join('');

  /* ============================== map ============================== */
  function initMap() {
    if (app.map) return;
    const map = (app.map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([24.69, 46.68], 12));
    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
    const light = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 20, attribution: '© OpenStreetMap contributors © CARTO' });
    const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });
    if (!ARTIFACT) light.addTo(map);
    app.baseLayers = ARTIFACT ? {} : { 'Light map': light, 'OpenStreetMap': osm, 'Satellite imagery': sat };
    app.layerControl = L.control.layers(app.baseLayers, {}, { collapsed: true }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);

    app.drawn = new L.FeatureGroup().addTo(map);
    map.on(L.Draw.Event.CREATED, (e) => { setAoi(e.layer.toGeoJSON()); });
    const shape = { color: '#1F7AE0', weight: 2, fillOpacity: 0.05 };
    $('#draw-poly').onclick = () => new L.Draw.Polygon(map, { shapeOptions: shape, showArea: true, allowIntersection: false }).enable();
    $('#draw-rect').onclick = () => new L.Draw.Rectangle(map, { shapeOptions: shape }).enable();

    // cell lookup by position: independent of layer order and renderer
    map.on('click', (e) => {
      const st = app.state;
      if (!st || !app.layers.cells || !map.hasLayer(app.layers.cells)) return;
      const id = st.grid.cellIdAt(e.latlng.lng, e.latlng.lat);
      const c = st.cur.cells.find((x) => x.id === id);
      if (c && st.grid.insideAoi(c, e.latlng.lng, e.latlng.lat)) L.popup({ maxWidth: 300 }).setLatLng(e.latlng).setContent(popupHtml(c)).openOn(map);
    });
    map.on('popupopen', (e) => {
      const el = e.popup.getElement();
      $$('[data-label]', el).forEach((b) => b.addEventListener('click', () => setLabel(b.dataset.cell, b.dataset.label)));
    });
  }

  function setAoi(feature, fit = true) {
    let f = feature.type === 'FeatureCollection' ? feature.features.find((x) => x.geometry && /Polygon/.test(x.geometry.type)) : feature;
    if (f && f.type !== 'Feature') f = turf.feature(f);
    if (!f || !/Polygon/.test(f.geometry.type)) { status('That file has no polygon to use as an area of interest.', true); return; }
    if (f.geometry.type === 'MultiPolygon' && f.geometry.coordinates.length > 1) {
      // keep the largest part: the Overpass poly filter takes one ring
      const parts = f.geometry.coordinates.map((c) => turf.polygon(c)).sort((a, b) => turf.area(b) - turf.area(a));
      f = parts[0];
      status('Multi-part boundary: the largest part is used.');
    } else if (f.geometry.type === 'MultiPolygon') f = turf.polygon(f.geometry.coordinates[0]);
    app.aoi = f;
    app.drawn.clearLayers();
    app.aoiLayer = L.geoJSON(f, { style: { color: '#071528', weight: 2.5, fill: false, dashArray: '6 4' } }).addTo(app.drawn);
    if (fit) app.map.fitBounds(app.aoiLayer.getBounds(), { padding: [30, 30] });
    const km2 = turf.area(f) / 1e6;
    const tooBig = km2 > G.CONFIG.maxAoiKm2;
    $('#aoi-info').innerHTML = `Area: <b>${F(km2, 2)} km²</b> · about ${F(km2 * 1e6 / (+$('#cell-size').value) ** 2, 0)} cells.` +
      (tooBig ? ` <span style="color:var(--high)">Larger than ${G.CONFIG.maxAoiKm2} km²: draw a smaller area or use the Python pipeline.</span>` : km2 > G.CONFIG.warnAoiKm2 ? ' Large areas can take a few minutes.' : '');
    $('#run').disabled = tooBig;
    if (!tooBig) status('Ready. Choose settings and run the analysis.');
  }

  /* ---------------- data source ---------------- */
  function setSource(src) {
    if (app.source === 'sample' && src !== 'sample' && app.aoi) { app.aoi = null; app.drawn && app.drawn.clearLayers(); app.aoiLayer = null; $('#run').disabled = true; $('#aoi-info').textContent = 'Draw the study area on the map, or use the full extent of your data.'; }
    app.source = src;
    $$('input[name=src]').forEach((r) => (r.checked = r.value === src));
    $('#src-live').hidden = src !== 'live';
    $('#src-files').hidden = src !== 'files';
    $('#src-sample').hidden = src !== 'sample';
    $('#spectral-opt').hidden = ARTIFACT || src !== 'live';
    $('#geocode-form').hidden = ARTIFACT;
    $('#src-live-opt').hidden = ARTIFACT;
    $('#demo-aoi').hidden = src !== 'live';
    $('#extent-aoi').hidden = src !== 'files' || !app.userData;
    $('#change-label').textContent = src === 'live' ? 'Change detection since' : 'Change detection against the earlier data, dated';
    if (src === 'sample') {
      initMap();
      $('#opt-change').checked = true; $('#baseline-date').disabled = false; $('#baseline-date').value = '2018-01-01';
      setAoi(G.Sample.aoi());
      showDataPreview(G.Sample.current());
    } else if (src === 'files' && app.userData) { showDataPreview(app.userData); }
    else clearPreview();
  }
  $$('input[name=src]').forEach((r) => (r.onchange = () => setSource(r.value)));

  function clearPreview() { if (app.preview) { app.map.removeLayer(app.preview); app.preview = null; } }
  function showDataPreview(d) {
    initMap(); clearPreview();
    const feats = d.buildings.slice(0, 30000).concat(d.roads);
    app.preview = L.geoJSON({ type: 'FeatureCollection', features: feats.map((f) => ({ type: 'Feature', properties: {}, geometry: f.geometry })) }, { style: (f) => (f.geometry.type === 'Polygon' ? { color: '#5A6B7F', weight: 0.4, fillColor: '#5A6B7F', fillOpacity: 0.35 } : { color: '#8FA6C2', weight: 1 }), interactive: false }).addTo(app.map);
  }
  function describe(d) { return `${d.buildings.length.toLocaleString()} buildings, ${d.roads.length.toLocaleString()} roads, ${d.amenities.length.toLocaleString()} services, ${(d.green.length + d.water.length).toLocaleString()} green and water areas`; }
  async function readFiles(files) {
    let data = null;
    for (const f of files) data = G.Sources.mergeData(data, G.Sources.parseUserData(JSON.parse(await f.text()), f.name.replace(/\.(geo)?json$/i, '')));
    return data;
  }
  $('#data-files').onchange = async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    try {
      const d = await readFiles(files);
      if (!d.buildings.length && !d.roads.length) throw new Error('no buildings or roads were found in the file');
      app.userData = G.Sources.mergeData(app.userData, d);
      $('#data-info').textContent = 'Loaded ' + describe(app.userData) + '.';
      showDataPreview(app.userData);
      $('#extent-aoi').hidden = false;
      const ext = turf.bboxPolygon(turf.bbox(turf.featureCollection(app.userData.buildings.concat(app.userData.roads))));
      if (!app.aoi || !turf.booleanIntersects(app.aoi, ext)) setAoi(ext); // the area must cover the data
      else app.map.fitBounds(L.geoJSON(ext).getBounds(), { padding: [30, 30] });
    } catch (err) { $('#data-info').textContent = 'Could not read that file: ' + err.message + '.'; }
    e.target.value = '';
  };
  $('#base-files').onchange = async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    try {
      app.baseData = G.Sources.mergeData(app.baseData, await readFiles(files));
      $('#base-info').textContent = 'Earlier data: ' + describe(app.baseData) + '.';
      $('#opt-change').checked = true; $('#baseline-date').disabled = false;
    } catch (err) { $('#base-info').textContent = 'Could not read that file: ' + err.message + '.'; }
    e.target.value = '';
  };
  $('#extent-aoi').onclick = () => app.userData && setAoi(turf.bboxPolygon(turf.bbox(turf.featureCollection(app.userData.buildings.concat(app.userData.roads)))));

  $('#demo-aoi').onclick = () => { initMap(); setAoi(turf.bboxPolygon([46.662, 24.682, 46.694, 24.708])); };
  $('#cell-size').onchange = () => app.aoi && setAoi(app.aoi, false);
  $('#opt-change').onchange = (e) => ($('#baseline-date').disabled = !e.target.checked);
  $('#baseline-date').max = new Date(Date.now() - 86400000 * 180).toISOString().slice(0, 10);

  $('#aoi-file').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { setAoi(JSON.parse(await file.text())); } catch (err) { status('Could not read the file: ' + err.message, true); }
    e.target.value = '';
  };
  $('#extra-file').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const name = $('#extra-name').value.trim() || 'External';
      const feats = G.Sources.parseBuildingUpload(JSON.parse(await file.text()), name);
      if (!feats.length) throw new Error('no polygons found');
      app.extra = { name, features: feats };
      $('#extra-info').textContent = `${feats.length.toLocaleString()} footprints from ${name} will be fused with OpenStreetMap.`;
    } catch (err) { app.extra = null; $('#extra-info').textContent = 'Could not use that file: ' + err.message; }
    e.target.value = '';
  };

  $('#geocode-form').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#geocode-q').value.trim(); if (!q) return;
    initMap();
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(q));
      const j = await r.json();
      if (!j.length) { status('No place found for "' + q + '".', true); return; }
      const b = j[0].boundingbox.map(Number);
      app.map.fitBounds([[b[0], b[2]], [b[1], b[3]]]);
      status('Found ' + j[0].display_name.split(',').slice(0, 2).join(',') + '. Now draw the study area.');
    } catch (err) { status('Place search is unavailable right now.', true); }
  };

  /* ============================== run ============================== */
  function status(msg, err) { const s = $('#status'); s.textContent = msg; s.classList.toggle('error', !!err); }
  function renderSteps() { $('#steps').innerHTML = G.STEPS.map((s, i) => `<li data-step="${i}">${s}</li>`).join(''); }
  function step(i, st) { const li = $(`#steps [data-step="${i}"]`); if (li) li.className = st; }

  $('#run').onclick = async () => {
    if (!app.aoi) return;
    const btn = $('#run');
    btn.disabled = true; btn.textContent = 'Running…';
    renderSteps(); $('#results').hidden = true;
    clearResultLayers();
    const wantChange = $('#opt-change').checked;
    const opts = {
      cellSize: +$('#cell-size').value,
      spectral: !ARTIFACT && app.source === 'live' && $('#opt-spectral').checked,
      baselineDate: wantChange ? $('#baseline-date').value || 'earlier data' : null,
      extraSets: app.extra ? [app.extra] : []
    };
    if (app.source === 'sample') {
      opts.data = G.Sample.current();
      if (wantChange) opts.baseData = G.Sample.baseline();
    } else if (app.source === 'files') {
      if (!app.userData) { status('Add your data files first, or switch the data source.', true); btn.disabled = false; btn.textContent = 'Run analysis'; return; }
      opts.data = app.userData;
      if (wantChange) {
        if (!app.baseData) { status('Add earlier data files for change detection, or turn change detection off.', true); btn.disabled = false; btn.textContent = 'Run analysis'; return; }
        opts.baseData = app.baseData;
      }
    }
    clearPreview();
    try {
      const t0 = performance.now();
      app.state = await G.Pipeline.run(app.aoi, opts, { status, step });
      [12, 13, 14].forEach((i) => step(i, 'done'));
      status(`Done in ${F((performance.now() - t0) / 1000, 1)} s. Click any cell for its indicators.`);
      $('#mode-select').querySelector('[value="change"]').disabled = !app.state.change;
      drawResults();
      renderResults();
    } catch (err) {
      console.error(err);
      status(err.message || String(err), true);
      $$('#steps li.active').forEach((li) => (li.className = ''));
    } finally {
      btn.disabled = false; btn.textContent = 'Run analysis';
    }
  };

  /* ============================== map layers ============================== */
  function clearResultLayers() {
    for (const k in app.layers) { app.map.removeLayer(app.layers[k]); app.layerControl.removeLayer(app.layers[k]); }
    app.layers = {};
    $('#map-mode').hidden = true; $('#legend').hidden = true;
  }

  function quantileBreaks(values, n) {
    const s = values.filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
    if (!s.length) return [];
    return Array.from({ length: n - 1 }, (_, i) => s[Math.floor(((i + 1) / n) * (s.length - 1))]);
  }
  const BLUES = ['#E3EEF9', '#B4D2F0', '#75ADE3', '#2F7FCF', '#0C4A8C'];
  const CHANGE = { intensified: '#B8233A', new_development: '#6A4BC4', declined: '#1F7AE0', stable: '#C9D3DE' };
  const CHANGE_LABEL = { intensified: 'Intensified', new_development: 'New development', declined: 'Declined', stable: 'Stable' };

  function styleFor(c) {
    const base = { weight: 0.6, color: '#ffffff', fillOpacity: 0.72 };
    switch (app.mode) {
      case 'prob': {
        const i = Math.min(4, Math.floor(((c.prob - 0.34) / 0.66) * 5));
        return { ...base, fillColor: BLUES[Math.max(0, i)] };
      }
      case 'indicator': {
        const v = c.ind[app.indicator];
        if (v == null) return { ...base, fillColor: '#E8ECF1', fillOpacity: 0.4 };
        const k = app.breaks.findIndex((b) => v <= b);
        return { ...base, fillColor: BLUES[k === -1 ? BLUES.length - 1 : k] };
      }
      case 'change':
        return c.change ? { ...base, fillColor: CHANGE[c.change.type] } : { ...base, fillOpacity: 0 };
      case 'labels': {
        const l = c.manualLabel || c.seedLabel;
        return l ? { ...base, fillColor: CC[l], weight: c.manualLabel ? 2.5 : 0.6, color: c.manualLabel ? '#071528' : '#fff' } : { ...base, fillColor: '#FFFFFF', fillOpacity: 0.15 };
      }
      default:
        return { ...base, fillColor: CC[c.pred] };
    }
  }

  function drawResults() {
    const st = app.state, map = app.map;
    const cellFeatures = st.cur.cells.map((c) => ({ type: 'Feature', properties: { id: c.id }, geometry: c.clipped || c.polygon }));
    const byId = new Map(st.cur.cells.map((c) => [c.id, c]));
    app.layers.cells = L.geoJSON(cellFeatures, {
      style: (f) => styleFor(byId.get(f.properties.id)),
      interactive: false
    }).addTo(map);

    const bl = st.cur.buildings;
    if (bl.length <= 40000) {
      app.layers.buildings = L.geoJSON({ type: 'FeatureCollection', features: bl.map((b) => ({ type: 'Feature', properties: {}, geometry: b.geometry })) }, { style: { color: '#071528', weight: 0.4, fillColor: '#071528', fillOpacity: 0.35 }, interactive: false });
    }
    app.layers.roads = L.geoJSON({ type: 'FeatureCollection', features: st.cur.roads.map((r) => ({ type: 'Feature', properties: { major: r.properties.major }, geometry: r.geometry })) }, { style: (f) => ({ color: f.properties.major ? '#071528' : '#5A6B7F', weight: f.properties.major ? 2.2 : 0.9, opacity: 0.8 }), interactive: false });
    app.layers.services = L.layerGroup(st.cur.amenities.map((a) => {
      const cat = a.properties.category;
      const col = cat === 'health' ? '#B8233A' : cat === 'education' ? '#1E8C5A' : '#5A6B7F';
      return L.circleMarker([a.geometry.coordinates[1], a.geometry.coordinates[0]], { radius: cat === 'health' || cat === 'education' ? 5 : 3, color: '#fff', weight: 1, fillColor: col, fillOpacity: 0.95 }).bindTooltip((a.properties.name || a.properties.tag || '').toString());
    }));
    app.layerControl.addOverlay(app.layers.cells, 'Analysis cells');
    if (app.layers.buildings) app.layerControl.addOverlay(app.layers.buildings, 'Buildings (cleaned)');
    app.layerControl.addOverlay(app.layers.roads, 'Roads');
    app.layerControl.addOverlay(app.layers.services, 'Services');
    app.layers.roads.addTo(map);
    app.aoiLayer && app.aoiLayer.bringToFront();
    $('#map-mode').hidden = false;
    $('#mode-select').value = app.mode = 'class';
    restyle();
  }

  function restyle() {
    if (!app.layers.cells) return;
    if (app.mode === 'indicator') app.breaks = quantileBreaks(app.state.cur.cells.map((c) => c.ind[app.indicator]), 5);
    const byId = new Map(app.state.cur.cells.map((c) => [c.id, c]));
    app.layers.cells.setStyle((f) => styleFor(byId.get(f.properties.id)));
    renderLegend();
  }
  $('#mode-select').onchange = (e) => { app.mode = e.target.value; restyle(); };

  function renderLegend() {
    const L_ = $('#legend'); L_.hidden = false;
    const sw = (c) => `<span class="sw" style="background:${c}"></span>`;
    if (app.mode === 'class') L_.innerHTML = '<b>Built-up intensity</b>' + CLS.map((k) => `<div>${sw(CC[k])}${k}</div>`).join('');
    else if (app.mode === 'labels') L_.innerHTML = '<b>Training labels</b>' + CLS.map((k) => `<div>${sw(CC[k])}${k}</div>`).join('') + '<div class="muted">Thick outline: your label. Pale: unlabelled.</div>';
    else if (app.mode === 'change') L_.innerHTML = `<b>Since ${app.state.opts.baselineDate}</b>` + Object.keys(CHANGE).map((k) => `<div>${sw(CHANGE[k])}${CHANGE_LABEL[k]}</div>`).join('');
    else if (app.mode === 'prob') L_.innerHTML = `<b>Prediction confidence</b><div class="ramp" style="background:linear-gradient(90deg,${BLUES.join(',')})"></div><div class="ends"><span>34%</span><span>100%</span></div>`;
    else {
      const d = IND[app.indicator], b = app.breaks;
      L_.innerHTML = `<b>${d.label}</b>` + BLUES.map((c, i) => {
        const lo = i === 0 ? null : b[i - 1], hi = b[i];
        const txt = i === 0 ? `≤ ${G.Report.fmtInd(d, hi)}` : i === BLUES.length - 1 ? `> ${G.Report.fmtInd(d, lo)}` : `${G.Report.fmtInd(d, lo)} – ${G.Report.fmtInd(d, hi)}`;
        return `<div>${sw(c)}${txt}</div>`;
      }).join('') + (d.unit && !d.pct ? `<div class="muted">${d.unit}</div>` : '');
    }
  }

  function popupHtml(c) {
    const pct = (v) => F(v * 100, 0) + '%';
    const rows = Object.entries(G.GROUPS).map(([g, name]) =>
      `<tr><td colspan="2"><b>${name}</b></td></tr>` + G.INDICATORS.filter((d) => d.group === g).map((d) => `<tr><td>${d.label}</td><td>${G.Report.fmtInd(d, c.ind[d.key])}${d.unit && !d.pct && c.ind[d.key] != null ? ' ' + d.unit : ''}</td></tr>`).join('')).join('');
    const label = c.manualLabel ? `your label: ${c.manualLabel}` : c.seedLabel ? `seed label: ${c.seedLabel}` : 'unlabelled';
    const ch = c.change ? `<p>Since ${app.state.opts.baselineDate}: <b>${CHANGE_LABEL[c.change.type]}</b> (${c.change.from} → ${c.change.to}), ${c.change.d_bld_count >= 0 ? '+' : ''}${c.change.d_bld_count} buildings.</p>` : '';
    return `<div class="popup"><h4>${c.pred} intensity <span class="muted">· ${pct(c.prob)} confidence</span></h4>
      <div class="muted">Cell ${c.id} · ${label}</div>${ch}
      ${c.flags.length ? '<p class="warn" style="margin:6px 0">Roads but no mapped buildings: data may be incomplete.</p>' : ''}
      <div class="scroll"><table>${rows}</table></div>
      <div class="lbl-row"><span class="muted">Label as</span>${CLS.map((k) => `<button data-cell="${c.id}" data-label="${k}">${k}</button>`).join('')}${c.manualLabel ? `<button data-cell="${c.id}" data-label="">Clear</button>` : ''}</div></div>`;
  }

  function setLabel(id, label) {
    const c = app.state.cur.cells.find((x) => x.id === id); if (!c) return;
    c.manualLabel = label || null;
    app.map.closePopup();
    if (app.mode !== 'labels') { app.mode = 'labels'; $('#mode-select').value = 'labels'; }
    restyle();
    renderModelTab();
    selectTab('model');
  }

  /* ============================== results panel ============================== */
  function selectTab(name) {
    $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('.tab-body').forEach((t) => (t.hidden = t.id !== 'tab-' + name));
  }
  $$('.tabs [role=tab]').forEach((b) => (b.onclick = () => selectTab(b.dataset.tab)));

  function renderResults() {
    $('#results').hidden = false;
    renderOverview(); renderIndicatorTab(); renderModelTab(); renderQualityTab(); renderChangeTab(); renderExportTab();
    selectTab('overview');
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderOverview() {
    const st = app.state, cells = st.cur.cells, sh = G.Report.classShares(cells);
    const roadKm = st.cur.roads.reduce((s, r) => s + r._m.len, 0) / 1000;
    $('#tab-overview').innerHTML = `
      ${st.warnings.map((w) => `<p class="warn">${w}</p>`).join('')}
      <div class="kpis">
        <div class="kpi"><b>${F(st.areaKm2, 2)} km²</b><span>Area of interest</span></div>
        <div class="kpi"><b>${cells.length}</b><span>${st.opts.cellSize} m cells</span></div>
        <div class="kpi"><b>${F(st.cur.buildings.length, 0)}</b><span>Buildings (deduplicated)</span></div>
        <div class="kpi"><b>${F(roadKm, 1)} km</b><span>Roads</span></div>
        <div class="kpi"><b>${F(st.cur.amenities.length, 0)}</b><span>Services and amenities</span></div>
        <div class="kpi"><b>${st.model.validation ? F(st.model.validation.accuracy * 100, 0) + '%' : '–'}</b><span>Validation accuracy</span></div>
      </div>
      <h3>Built-up intensity by area</h3>
      <div class="classbar">${CLS.map((k) => `<i style="width:${sh[k] * 100}%;background:${CC[k]}"></i>`).join('')}</div>
      <div class="classkey">${CLS.map((k) => `<span><span class="sw" style="background:${CC[k]}"></span>${k} ${F(sh[k] * 100, 0)}%</span>`).join('')}</div>
      <h3>What the results show</h3>
      <ul class="insights">${G.Report.insights(st).map((t) => `<li>${t}</li>`).join('')}</ul>
      ${st.spectralScenes ? `<p class="hint">Sentinel-2 scenes used: ${st.spectralScenes.map((s) => `${s.date} (${s.cloud}% cloud)`).join(', ')}.</p>` : ''}`;
  }

  function renderIndicatorTab() {
    const st = app.state;
    const opts = Object.entries(G.GROUPS).map(([g, name]) => `<optgroup label="${name}">${G.INDICATORS.filter((d) => d.group === g).map((d) => `<option value="${d.key}" ${d.key === app.indicator ? 'selected' : ''} ${st.summary[d.key] ? '' : 'disabled'}>${d.label}</option>`).join('')}</optgroup>`).join('');
    const byClass = (key) => CLS.map((k) => {
      const v = st.cur.cells.filter((c) => c.pred === k).map((c) => c.ind[key]).filter((x) => x != null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    });
    $('#tab-indicators').innerHTML = `
      <label class="field">Map an indicator <select id="ind-select">${opts}</select></label>
      <div id="ind-detail"></div>
      <h3>All 30 indicators</h3>
      <table class="t"><thead><tr><th>Indicator</th><th>Median</th><th>Low</th><th>Med.</th><th>High</th></tr></thead><tbody>
      ${G.INDICATORS.map((d) => { const s = st.summary[d.key], m = byClass(d.key); return `<tr><td>${d.label}</td><td>${s ? G.Report.fmtInd(d, s.median) : '–'}</td>${m.map((v) => `<td>${G.Report.fmtInd(d, v)}</td>`).join('')}</tr>`; }).join('')}
      </tbody></table>
      <p class="hint">Low, Med. and High columns are the mean for cells predicted in each class.</p>`;
    const detail = () => {
      const d = IND[app.indicator], s = st.summary[d.key];
      $('#ind-detail').innerHTML = s ? `<p class="hint">${d.label}${d.unit && !d.pct ? ' (' + d.unit + ')' : ''}: min ${G.Report.fmtInd(d, s.min)}, median ${G.Report.fmtInd(d, s.median)}, mean ${G.Report.fmtInd(d, s.mean)}, max ${G.Report.fmtInd(d, s.max)}.</p>` : '<p class="hint">Not available for this run.</p>';
    };
    detail();
    $('#ind-select').onchange = (e) => { app.indicator = e.target.value; app.mode = 'indicator'; $('#mode-select').value = 'indicator'; detail(); restyle(); };
  }

  function renderModelTab() {
    const st = app.state, m = st.model, v = m.validation;
    const manual = st.cur.cells.filter((c) => c.manualLabel).length;
    const cm = v ? `<table class="t cm"><thead><tr><th>Actual ↓ / predicted →</th>${CLS.map((k) => `<th>${k}</th>`).join('')}</tr></thead><tbody>${v.confusion.map((r, i) => `<tr><td>${CLS[i]}</td>${r.map((x, j) => `<td class="${i === j ? 'diag' : ''}">${x}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <h3>Per class</h3>
      <table class="t"><thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th><th>n</th></tr></thead><tbody>${v.perClass.map((c) => `<tr><td>${c.name}</td><td>${F(c.precision, 2)}</td><td>${F(c.recall, 2)}</td><td>${F(c.f1, 2)}</td><td>${c.support}</td></tr>`).join('')}</tbody></table>` : '<p class="hint">Too few labelled cells for a held-out validation set.</p>';
    $('#tab-model').innerHTML = `
      <p>Random Forest, ${G.CONFIG.rf.trees} trees, ${m.keys.length} indicators. Trained on ${m.labelled} labelled cells (${Object.entries(m.labelCounts).map(([k, n]) => k + ' ' + n).join(', ')}).</p>
      ${v ? `<div class="kpis"><div class="kpi"><b>${F(v.accuracy * 100, 1)}%</b><span>Overall accuracy</span></div><div class="kpi"><b>${F(v.kappa, 2)}</b><span>Cohen's kappa</span></div><div class="kpi"><b>${F(v.macroF1, 2)}</b><span>Macro F1-score</span></div><div class="kpi"><b>${v.trainSize} / ${v.testSize}</b><span>Train / validation cells</span></div></div>
      <h3>Confusion matrix (validation cells)</h3>` : ''}${cm}
      <h3>Review the training labels</h3>
      <p class="hint">${m.manual ? m.manual + ' of the labels are yours; the rest are automatic seeds.' : 'All labels are automatic seeds, so the scores above measure agreement with the seeding rules.'} Show “Training labels” on the map, click a cell and choose a label, then retrain.</p>
      <div class="btn-row"><button class="btn btn-small" id="show-labels">Show training labels</button><button class="btn btn-small btn-primary" id="retrain" ${manual === m.manual ? 'disabled' : ''}>Retrain with ${manual} manual label${manual === 1 ? '' : 's'}</button></div>
      <h3>Indicator importance</h3>
      <div class="chart-box" style="height:${Math.max(200, Math.min(m.importance.length, 12) * 22)}px"><canvas id="imp-chart"></canvas></div>`;
    $('#show-labels').onclick = () => { app.mode = 'labels'; $('#mode-select').value = 'labels'; restyle(); };
    $('#retrain').onclick = () => {
      try {
        G.Pipeline.retrain(app.state);
        restyle(); renderResults(); selectTab('model');
        status('Model retrained with your labels.');
      } catch (e) { status(e.message, true); }
    };
    if (app.charts.imp) app.charts.imp.destroy();
    const top = m.importance.slice(0, 12);
    app.charts.imp = new Chart($('#imp-chart'), {
      type: 'bar',
      data: { labels: top.map((i) => IND[i.key].label), datasets: [{ data: top.map((i) => +(i.value * 100).toFixed(1)), backgroundColor: '#1F7AE0', borderRadius: 3 }] },
      options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => c.raw + '% of total impurity decrease' } } }, scales: { x: { grid: { color: '#E3EBF3' }, ticks: { callback: (v) => v + '%' } }, y: { grid: { display: false }, ticks: { font: { size: 11 } } } } }
    });
  }

  function renderQualityTab() {
    const st = app.state, q = st.cur.quality.buildings, r = st.cur.quality.roads;
    const dropped = Object.entries(q.dropped);
    const gaps = st.cur.cells.filter((c) => c.flags.length).length;
    const nonEmpty = st.cur.cells.filter((c) => c.ind.bld_count > 0).length;
    $('#tab-quality').innerHTML = `
      <h3>Building footprints</h3>
      <table class="t"><tbody>
        ${Object.entries(q.input).map(([k, n]) => `<tr><td>Input from ${k}</td><td>${F(n, 0)}</td></tr>`).join('')}
        <tr><td>Self-intersections repaired</td><td>${q.repaired}</td></tr>
        <tr><td>Invalid geometries dropped</td><td>${dropped.reduce((s, [, n]) => s + n, 0)}</td></tr>
        <tr><td>Slivers under 2 m² removed</td><td>${q.slivers}</td></tr>
        <tr><td>Outside the AOI polygon</td><td>${F(q.outsideAoi, 0)}</td></tr>
        <tr><td>Duplicates removed</td><td>${F(q.duplicates, 0)}${Object.keys(q.duplicatesBySource).length ? ' (' + Object.entries(q.duplicatesBySource).map(([k, n]) => k + ' ' + n).join(', ') + ')' : ''}</td></tr>
        <tr><td>Footprints over 50,000 m² (check)</td><td>${q.oversized}</td></tr>
        <tr><td><b>Kept for analysis</b></td><td><b>${F(q.kept, 0)}</b></td></tr>
        ${Object.entries(q.bySource || {}).map(([k, n]) => `<tr><td>&nbsp;&nbsp;from ${k}</td><td>${F(n, 0)}</td></tr>`).join('')}
      </tbody></table>
      <h3>Completeness</h3>
      <table class="t"><tbody>
        <tr><td>Footprints with building levels</td><td>${F(q.kept ? (q.withLevels / q.kept) * 100 : 0, 1)}%</td></tr>
        <tr><td>Roads with a name</td><td>${F(r.namedShare * 100, 0)}%</td></tr>
        <tr><td>Cells containing buildings</td><td>${nonEmpty} of ${st.cur.cells.length}</td></tr>
        <tr><td>Cells with roads but no buildings</td><td>${gaps}</td></tr>
      </tbody></table>
      <p class="hint">Where levels are missing a single storey is assumed. Cells with roads but no buildings are flagged on the map popup; adding footprints from another source usually closes these gaps.</p>`;
  }

  function renderChangeTab() {
    const st = app.state, ch = st.change;
    if (!ch) { $('#tab-change').innerHTML = '<p class="hint">Turn on change detection in Settings and run again to compare with an earlier snapshot.</p>'; return; }
    const t = ch.tally;
    $('#tab-change').innerHTML = `
      <p>Compared with ${st.opts.data ? 'the earlier data' : 'OpenStreetMap as it was'} on <b>${st.opts.baselineDate}</b>, using the same grid and model.</p>
      <div class="kpis">
        <div class="kpi"><b>${t.intensified}</b><span>Cells intensified</span></div>
        <div class="kpi"><b>${t.new_development}</b><span>Newly developed</span></div>
        <div class="kpi"><b>${t.declined}</b><span>Cells declined</span></div>
        <div class="kpi"><b>${t.stable}</b><span>Stable</span></div>
        <div class="kpi"><b>${ch.newBuildings >= 0 ? '+' : ''}${F(ch.newBuildings, 0)}</b><span>Buildings</span></div>
        <div class="kpi"><b>${ch.addedRoad >= 0 ? '+' : ''}${F(ch.addedRoad / 1000, 1)} km</b><span>Roads</span></div>
      </div>
      <h3>Transitions</h3>
      <table class="t cm"><thead><tr><th>Before ↓ / after →</th>${CLS.map((k) => `<th>${k}</th>`).join('')}</tr></thead><tbody>${ch.matrix.map((r, i) => `<tr><td>${CLS[i]}</td>${r.map((x, j) => `<td class="${i === j ? 'diag' : ''}">${x}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <button class="btn btn-small" id="show-change" style="margin-top:12px">Show change on the map</button>
      <p class="hint">Historical snapshots show what was mapped at that date, which can lag behind construction.</p>`;
    $('#show-change').onclick = () => { app.mode = 'change'; $('#mode-select').value = 'change'; restyle(); };
  }

  function renderExportTab() {
    const stamp = new Date().toISOString().slice(0, 10);
    $('#tab-export').innerHTML = `
      <p class="hint">GeoJSON and CSV open directly in ArcGIS Pro and QGIS (EPSG:4326).</p>
      <div class="export-list">
        <button class="btn btn-small" data-x="cells-geojson">Analysis cells with indicators (GeoJSON)</button>
        <button class="btn btn-small" data-x="cells-csv">Analysis cells with indicators (CSV)</button>
        <button class="btn btn-small" data-x="buildings">Cleaned building footprints (GeoJSON)</button>
        <button class="btn btn-small" data-x="metrics">Model metrics and quality report (JSON)</button>
        <button class="btn btn-small btn-primary" data-x="pdf">PDF report</button>
      </div>`;
    const gj = ARTIFACT ? 'json' : 'geojson'; // the sandboxed viewer saves .json; GIS tools read it as GeoJSON
    $$('#tab-export [data-x]').forEach((b) => (b.onclick = async () => {
      const st = app.state, R = G.Report;
      try {
        switch (b.dataset.x) {
          case 'cells-geojson': await saveFile(`geoai_cells_${stamp}.${gj}`, JSON.stringify(R.cellsGeoJSON(st)), 'application/geo+json'); break;
          case 'cells-csv': await saveFile(`geoai_cells_${stamp}.csv`, R.cellsCSV(st), 'text/csv'); break;
          case 'buildings': await saveFile(`geoai_buildings_${stamp}.${gj}`, JSON.stringify(R.buildingsGeoJSON(st)), 'application/geo+json'); break;
          case 'metrics': await saveFile(`geoai_metrics_${stamp}.json`, JSON.stringify(R.metricsJSON(st), null, 2), 'application/json'); break;
          case 'pdf': await saveFile(`geoai_report_${stamp}.pdf`, R.pdf(st).output('blob'), 'application/pdf'); break;
        }
      } catch (e) {
        if (e && e.code === 'declined') return;
        console.error(e); status('Export failed: ' + (e.message || e.code), true);
      }
    }));
  }

  async function saveFile(name, data, type) {
    if (!ARTIFACT) return G.Report.download(name, data instanceof Blob ? data : new Blob([data], { type }), type);
    const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
    if (!dl) throw new Error('saving files is not available in this view');
    await dl.save({ filename: name, data });
    status('Saved ' + name + '.');
  }

  window.GeoAIApp = app; // handy for debugging in the browser console
  route();
  setSource(app.source);
})();
