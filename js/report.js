/* Outputs: decision insights, CSV / GeoJSON exports and the PDF report. */
(function (root) {
  const GeoAI = (root.GeoAI = root.GeoAI || {});

  const fmt = (v, d = 1) => (v == null || !isFinite(v) ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
  const fmtInd = (def, v) => (v == null ? '–' : def.pct ? fmt(v * 100, 1) + '%' : fmt(v, Math.abs(v) < 10 ? 2 : 0));

  function classShares(cells) {
    const out = { Low: 0, Medium: 0, High: 0 };
    let tot = 0;
    for (const c of cells) { out[c.pred] += c.area; tot += c.area; }
    for (const k in out) out[k] = tot ? out[k] / tot : 0;
    return out;
  }

  const cellsN = (n) => n + (n === 1 ? ' cell' : ' cells');

  /* Plain-language findings for decision-makers */
  function insights(state) {
    const cells = state.cur.cells, out = [];
    const sh = classShares(cells);
    out.push(`${fmt(sh.High * 100, 0)}% of the area is high built-up intensity, ${fmt(sh.Medium * 100, 0)}% medium and ${fmt(sh.Low * 100, 0)}% low.`);
    const high = cells.filter((c) => c.pred === 'High');
    const farHealth = high.filter((c) => c.ind.dist_health > 1000).length;
    if (high.length && farHealth) out.push(`${farHealth} of ${high.length} high-intensity cells are more than 1 km from a mapped health facility — candidates for service planning.`);
    const farSchool = cells.filter((c) => c.pred !== 'Low' && c.ind.dist_school > 1000).length;
    if (farSchool) out.push(`${farSchool} medium or high-intensity ${farSchool === 1 ? 'cell is' : 'cells are'} more than 1 km from a mapped school.`);
    const lowGreen = high.filter((c) => c.ind.green_share === 0 && (c.ind.ndvi_mean == null || c.ind.ndvi_mean < 0.2)).length;
    if (high.length && lowGreen) out.push(`${lowGreen} high-intensity ${lowGreen === 1 ? 'cell has' : 'cells have'} no mapped green space.`);
    const small = cells.filter((c) => c.pred !== 'Low' && c.ind.small_bld_share > 0.5 && c.ind.mean_nn_dist < 6).length;
    if (small) out.push(`${cellsN(small)} combine mostly very small buildings with tight spacing, a pattern worth checking for informal settlement.`);
    if (state.change) {
      const t = state.change.tally;
      out.push(`Since ${state.opts.baselineDate}: ${cellsN(t.intensified)} intensified, ${t.new_development} newly developed, ${t.declined} declined; ${fmt(state.change.newBuildings, 0)} buildings were added to the map.`);
    }
    const gaps = cells.filter((c) => c.flags.includes('possible_missing_buildings')).length;
    if (gaps) out.push(`${cellsN(gaps)} ${gaps === 1 ? 'has' : 'have'} roads but no mapped buildings — the source data may be incomplete there.`);
    const lowConf = cells.filter((c) => c.prob < 0.5).length;
    if (lowConf) out.push(`${cellsN(lowConf)} ${lowConf === 1 ? 'has' : 'have'} prediction confidence below 50%; review or label ${lowConf === 1 ? 'it' : 'them'} before relying on the result.`);
    return out;
  }

  function cellProps(state, c) {
    const p = {
      cell_id: c.id, cell_size_m: state.opts.cellSize, area_m2: Math.round(c.area),
      intensity: c.pred, confidence: +c.prob.toFixed(3),
      p_low: +c.probs[0].toFixed(3), p_medium: +c.probs[1].toFixed(3), p_high: +c.probs[2].toFixed(3),
      seed_label: c.seedLabel || null, manual_label: c.manualLabel || null, intensity_score: +(c.score || 0).toFixed(4)
    };
    for (const d of GeoAI.INDICATORS) { const v = c.ind[d.key]; p[d.key] = v == null ? null : +v.toFixed(5); }
    if (c.change) Object.assign(p, { change_type: c.change.type, intensity_before: c.change.from, d_bld_count: c.change.d_bld_count, d_builtup_area: +c.change.d_builtup_area.toFixed(1), d_coverage: +c.change.d_coverage.toFixed(5), d_road_length: +c.change.d_road_length.toFixed(1) });
    p.flags = c.flags.join(';') || null;
    return p;
  }

  function cellsGeoJSON(state) {
    return {
      type: 'FeatureCollection',
      name: 'geoai_cells',
      metadata: { generator: 'GeoAI Urban Mapping Platform', run_at: state.runAt, aoi_km2: +state.areaKm2.toFixed(3), cell_size_m: state.opts.cellSize, baseline: state.opts.baselineDate || null, crs: 'EPSG:4326' },
      features: state.cur.cells.map((c) => ({ type: 'Feature', properties: cellProps(state, c), geometry: c.clipped || c.polygon }))
    };
  }

  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function cellsCSV(state) {
    const rows = state.cur.cells.map((c) => {
      const p = cellProps(state, c);
      const cen = turf.centroid(c.clipped || c.polygon).geometry.coordinates;
      return Object.assign({ lon: +cen[0].toFixed(6), lat: +cen[1].toFixed(6) }, p);
    });
    const cols = Object.keys(rows.reduce((a, r) => Object.assign(a, r), {}));
    return [cols.join(',')].concat(rows.map((r) => cols.map((k) => csvEscape(r[k])).join(','))).join('\n');
  }

  function buildingsGeoJSON(state) {
    return {
      type: 'FeatureCollection', name: 'geoai_buildings_clean',
      features: state.cur.buildings.map((b) => ({ type: 'Feature', properties: { source: b.properties.source, id: b.properties.osm_id || b.properties.ext_id || null, levels: b.properties.levels, area_m2: +b._m.area.toFixed(1), cell_id: b._cell }, geometry: b.geometry }))
    };
  }

  function metricsJSON(state) {
    const m = state.model;
    return {
      run_at: state.runAt, aoi_km2: state.areaKm2, cell_size_m: state.opts.cellSize, cells: state.cur.cells.length,
      labelled_cells: m.labelled, manual_labels: m.manual, label_counts: m.labelCounts,
      model: { type: 'RandomForest', trees: GeoAI.CONFIG.rf.trees, max_depth: GeoAI.CONFIG.rf.maxDepth, features: m.keys },
      validation: m.validation, feature_importance: m.importance,
      quality: state.cur.quality, change: state.change ? { baseline: state.opts.baselineDate, tally: state.change.tally, transition_matrix: state.change.matrix } : null,
      sentinel2_scenes: state.spectralScenes, warnings: state.warnings
    };
  }

  function download(name, text, type) {
    const blob = text instanceof Blob ? text : new Blob([text], { type: type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ------------------------------ PDF ------------------------------ */
  function pdf(state) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const M = 16, PW = 210, PH = 297;
    let y = 0;
    const safe = (s) => String(s).replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/—/g, '-').replace(/²/g, '2').replace(/[^\x00-\xFF–•]/g, '');
    const header = () => {
      doc.setFillColor(7, 21, 40); doc.rect(0, 0, PW, 22, 'F');
      doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
      doc.text('GeoAI Urban Mapping Platform', M, 14);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(169, 190, 214);
      doc.text('Analysis report · ' + state.runAt.slice(0, 16).replace('T', ' ') + ' UTC', PW - M, 14, { align: 'right' });
      doc.setTextColor(16, 34, 54); y = 32;
    };
    const h2 = (t) => { need(14); doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text(safe(t), M, y); y += 7; doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); };
    const para = (t) => { const lines = doc.splitTextToSize(safe(t), PW - 2 * M); need(lines.length * 4.6); doc.text(lines, M, y); y += lines.length * 4.6 + 1.5; };
    const need = (h) => { if (y + h > PH - 16) { doc.addPage(); header(); } };
    const table = (head, rows, widths) => {
      doc.setFontSize(8.5);
      const rowH = 5.4;
      const drawRow = (r, bold) => {
        need(rowH);
        let x = M;
        doc.setFont('helvetica', bold ? 'bold' : 'normal');
        r.forEach((cell, i) => {
          const txt = safe(cell);
          if (i === 0) doc.text(txt, x + 1, y); else doc.text(txt, x + widths[i] - 1, y, { align: 'right' });
          x += widths[i];
        });
        doc.setDrawColor(214, 224, 234); doc.line(M, y + 1.6, M + widths.reduce((a, b) => a + b, 0), y + 1.6);
        y += rowH;
      };
      drawRow(head, true); rows.forEach((r) => drawRow(r)); y += 3; doc.setFontSize(9.5);
    };

    header();
    const cells = state.cur.cells, sh = classShares(cells), q = state.cur.quality.buildings;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('Built-up intensity analysis', M, y); y += 8;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
    para(`Area of interest: ${fmt(state.areaKm2, 2)} km² in ${cells.length} cells of ${state.opts.cellSize} × ${state.opts.cellSize} m. Buildings after fusion and deduplication: ${fmt(q.kept, 0)}. Roads: ${fmt(state.cur.roads.reduce((s, r) => s + r._m.len, 0) / 1000, 1)} km. Services and amenities: ${fmt(state.cur.amenities.length, 0)}.`);
    para('Sources: OpenStreetMap (Overpass API)' + Object.keys(q.input).filter((k) => k !== 'OSM').map((k) => ', ' + k).join('') + (state.spectralScenes ? ', Sentinel-2 L2A scenes ' + state.spectralScenes.map((s) => s.date).join(', ') : '') + '.');

    // map of predicted classes
    const bb = turf.bbox(state.aoi);
    const mapW = PW - 2 * M, mapH = 105;
    const kx = Math.cos(((bb[1] + bb[3]) / 2) * Math.PI / 180);
    const sx = mapW / ((bb[2] - bb[0]) * kx), sy = mapH / (bb[3] - bb[1]);
    const s = Math.min(sx, sy);
    const ox = M + (mapW - (bb[2] - bb[0]) * kx * s) / 2, oy = y + (mapH - (bb[3] - bb[1]) * s) / 2;
    const P = (lon, lat) => [ox + (lon - bb[0]) * kx * s, oy + (bb[3] - lat) * s];
    doc.setFillColor(244, 247, 251); doc.rect(M, y, mapW, mapH, 'F');
    const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    for (const c of cells) {
      const ring = (c.clipped || c.polygon);
      const rings = ring.type === 'Polygon' ? [ring.coordinates[0]] : ring.coordinates.map((p) => p[0]);
      doc.setFillColor(...rgb(GeoAI.CONFIG.classColors[c.pred]));
      for (const r of rings) {
        const pts = r.map((p) => P(p[0], p[1]));
        const deltas = pts.slice(1).map((p, i) => [p[0] - pts[i][0], p[1] - pts[i][1]]);
        doc.lines(deltas, pts[0][0], pts[0][1], [1, 1], 'F', true);
      }
    }
    const aoiRings = state.aoi.geometry.type === 'Polygon' ? [state.aoi.geometry.coordinates[0]] : state.aoi.geometry.coordinates.map((p) => p[0]);
    doc.setDrawColor(7, 21, 40); doc.setLineWidth(0.4);
    for (const r of aoiRings) { const pts = r.map((p) => P(p[0], p[1])); doc.lines(pts.slice(1).map((p, i) => [p[0] - pts[i][0], p[1] - pts[i][1]]), pts[0][0], pts[0][1], [1, 1], 'S', true); }
    y += mapH + 5;
    let lx = M;
    for (const k of GeoAI.CONFIG.classes) {
      doc.setFillColor(...rgb(GeoAI.CONFIG.classColors[k])); doc.rect(lx, y - 3, 4, 4, 'F');
      doc.text(`${k} ${fmt(sh[k] * 100, 0)}%`, lx + 6, y); lx += 40;
    }
    y += 8;

    h2('Key findings');
    insights(state).forEach((t) => para('•  ' + t));

    h2('Model validation');
    const v = state.model.validation;
    if (v) {
      para(`Random Forest (${GeoAI.CONFIG.rf.trees} trees) trained on ${v.trainSize} labelled cells and validated on ${v.testSize} held-out cells. Overall accuracy ${fmt(v.accuracy * 100, 1)}%, Cohen's kappa ${fmt(v.kappa, 2)}, macro F1 ${fmt(v.macroF1, 2)}. ${state.model.manual ? state.model.manual + ' labels were set manually.' : 'Labels are automatic seeds; scores show agreement with the seeding rules.'}`);
      table(['Actual \\ predicted', 'Low', 'Medium', 'High'], v.confusion.map((r, i) => [GeoAI.CONFIG.classes[i], ...r.map(String)]), [60, 30, 30, 30]);
      table(['Class', 'Precision', 'Recall', 'F1-score', 'Support'], v.perClass.map((c) => [c.name, fmt(c.precision, 2), fmt(c.recall, 2), fmt(c.f1, 2), String(c.support)]), [50, 30, 30, 30, 30]);
    } else para('Too few labelled cells were available for a held-out validation set.');
    h2('Most important indicators');
    table(['Indicator', 'Importance'], state.model.importance.slice(0, 10).map((i) => [GeoAI.INDICATORS.find((d) => d.key === i.key).label, fmt(i.value * 100, 1) + '%']), [120, 50]);

    h2('Data quality');
    para(`Input footprints: ${Object.entries(q.input).map(([k, n]) => k + ' ' + fmt(n, 0)).join(', ')}. Duplicates removed: ${fmt(q.duplicates, 0)}. Self-intersecting footprints repaired: ${q.repaired}. Invalid geometries dropped: ${Object.values(q.dropped).reduce((a, b) => a + b, 0)}. Slivers under 2 m² removed: ${q.slivers}. Outside the AOI: ${fmt(q.outsideAoi, 0)}. Footprints with recorded levels: ${fmt(q.kept ? (q.withLevels / q.kept) * 100 : 0, 1)}%. Named roads: ${fmt(state.cur.quality.roads.namedShare * 100, 0)}%.`);

    if (state.change) {
      h2('Change since ' + state.opts.baselineDate);
      const t = state.change.tally;
      para(`Intensified ${t.intensified}, newly developed ${t.new_development}, stable ${t.stable}, declined ${t.declined} cells. Net change: ${fmt(state.change.newBuildings, 0)} buildings, ${fmt(state.change.addedArea / 1e4, 1)} ha of footprint, ${fmt(state.change.addedRoad / 1000, 1)} km of road.`);
      table(['Before \\ after', 'Low', 'Medium', 'High'], state.change.matrix.map((r, i) => [GeoAI.CONFIG.classes[i], ...r.map(String)]), [60, 30, 30, 30]);
    }

    h2('Indicator summary (all cells)');
    table(['Indicator', 'Min', 'Median', 'Mean', 'Max'], GeoAI.INDICATORS.map((d) => {
      const s = state.summary[d.key];
      return [d.label + (d.unit && !d.pct ? ' (' + d.unit + ')' : ''), ...(s ? [s.min, s.median, s.mean, s.max].map((x) => fmtInd(d, x)) : ['–', '–', '–', '–'])];
    }), [78, 23, 23, 23, 31]);

    if (state.warnings.length) { h2('Notes'); state.warnings.forEach((w) => para('•  ' + w)); }

    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i); doc.setFontSize(8); doc.setTextColor(90, 107, 127);
      doc.text('Map data © OpenStreetMap contributors · Contains modified Copernicus Sentinel data', M, PH - 8);
      doc.text(`${i} / ${pages}`, PW - M, PH - 8, { align: 'right' });
    }
    return doc;
  }

  GeoAI.Report = { insights, classShares, cellsGeoJSON, cellsCSV, buildingsGeoJSON, metricsJSON, pdf, download, fmt, fmtInd };
})(typeof window !== 'undefined' ? window : globalThis);
