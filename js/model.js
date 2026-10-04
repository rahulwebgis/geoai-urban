/* GeoAI modelling: seed labels (ground truth), Random Forest training and
 * validation, spatial prediction and change detection. Pure JavaScript, no server. */
(function (root) {
  const GeoAI = (root.GeoAI = root.GeoAI || {});

  /* ------------------------------ Random Forest ------------------------------ */
  function gini(counts, n) {
    if (!n) return 0;
    let s = 0; for (const c of counts) s += (c / n) * (c / n);
    return 1 - s;
  }

  function buildTree(X, y, idx, K, opt, rnd, depth, imp) {
    const counts = new Array(K).fill(0);
    for (const i of idx) counts[y[i]]++;
    const n = idx.length;
    const leaf = () => ({ leaf: true, dist: n ? counts.map((c) => c / n) : counts.map(() => 1 / K) });
    if (depth >= opt.maxDepth || n < 2 * opt.minLeaf || counts.some((c) => c === n)) return leaf();

    const p = X[0].length;
    const mtry = Math.max(1, Math.round(Math.sqrt(p)));
    const feats = [];
    const pool = [...Array(p).keys()];
    for (let k = 0; k < mtry; k++) { const r = k + Math.floor(rnd() * (p - k)); [pool[k], pool[r]] = [pool[r], pool[k]]; feats.push(pool[k]); }

    const parentG = gini(counts, n);
    let best = null;
    for (const f of feats) {
      const sorted = idx.slice().sort((a, b) => X[a][f] - X[b][f]);
      const left = new Array(K).fill(0), right = counts.slice();
      for (let k = 0; k < n - 1; k++) {
        const c = y[sorted[k]]; left[c]++; right[c]--;
        const nl = k + 1, nr = n - nl;
        const v0 = X[sorted[k]][f], v1 = X[sorted[k + 1]][f];
        if (v0 === v1 || nl < opt.minLeaf || nr < opt.minLeaf) continue;
        const g = (nl / n) * gini(left, nl) + (nr / n) * gini(right, nr);
        const gain = parentG - g;
        let thr = v0 + (v1 - v0) / 2;
        if (!(thr < v1)) thr = v0; // adjacent floats: keep the split exact
        if (!best || gain > best.gain) best = { gain, f, thr };
      }
    }
    if (!best || best.gain <= 1e-12) return leaf();
    imp[best.f] += best.gain * n;
    const L = [], R = [];
    for (const i of idx) (X[i][best.f] <= best.thr ? L : R).push(i);
    if (!L.length || !R.length) return leaf();
    return { f: best.f, thr: best.thr, l: buildTree(X, y, L, K, opt, rnd, depth + 1, imp), r: buildTree(X, y, R, K, opt, rnd, depth + 1, imp) };
  }

  function predictTree(node, x) {
    while (!node.leaf) node = x[node.f] <= node.thr ? node.l : node.r;
    return node.dist;
  }

  function RandomForest(opt) { this.opt = Object.assign({ trees: 100, maxDepth: 12, minLeaf: 2, seed: 42 }, opt || {}); }
  RandomForest.prototype.fit = function (X, y, K) {
    const rnd = GeoAI.Geo.rng(this.opt.seed);
    this.K = K; this.trees = [];
    const p = X[0].length;
    const imp = new Array(p).fill(0);
    for (let t = 0; t < this.opt.trees; t++) {
      const idx = Array.from({ length: X.length }, () => Math.floor(rnd() * X.length)); // bootstrap
      this.trees.push(buildTree(X, y, idx, K, this.opt, rnd, 0, imp));
    }
    const tot = imp.reduce((a, b) => a + b, 0) || 1;
    this.importance = imp.map((v) => v / tot);
    return this;
  };
  RandomForest.prototype.predictProba = function (x) {
    const out = new Array(this.K).fill(0);
    for (const t of this.trees) { const d = predictTree(t, x); for (let k = 0; k < this.K; k++) out[k] += d[k]; }
    return out.map((v) => v / this.trees.length);
  };
  RandomForest.prototype.predict = function (x) {
    const p = this.predictProba(x); return p.indexOf(Math.max(...p));
  };

  /* ------------------------------ Metrics ------------------------------ */
  function metrics(yTrue, yPred, K, names) {
    const cm = Array.from({ length: K }, () => new Array(K).fill(0));
    yTrue.forEach((t, i) => cm[t][yPred[i]]++);
    const n = yTrue.length;
    const correct = cm.reduce((s, r, i) => s + r[i], 0);
    const perClass = names.map((name, k) => {
      const tp = cm[k][k];
      const fp = cm.reduce((s, r, i) => s + (i !== k ? r[k] : 0), 0);
      const fn = cm[k].reduce((s, v, j) => s + (j !== k ? v : 0), 0);
      const precision = tp + fp ? tp / (tp + fp) : 0;
      const recall = tp + fn ? tp / (tp + fn) : 0;
      const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
      return { name, precision, recall, f1, support: tp + fn };
    });
    const po = n ? correct / n : 0;
    let pe = 0;
    for (let k = 0; k < K; k++) pe += (cm[k].reduce((a, b) => a + b, 0) / n) * (cm.reduce((s, r) => s + r[k], 0) / n);
    return {
      confusion: cm, accuracy: po, kappa: pe < 1 ? (po - pe) / (1 - pe) : 0,
      macroF1: perClass.reduce((s, c) => s + c.f1, 0) / K, perClass, n
    };
  }

  /* ------------------------------ Labels ------------------------------ */
  function pctRank(values) {
    const s = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(values.length);
    let i = 0;
    while (i < s.length) { // average rank for ties
      let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++;
      const rank = (i + j) / 2 / Math.max(1, s.length - 1);
      for (let k = i; k <= j; k++) r[s[k][1]] = rank;
      i = j + 1;
    }
    return r;
  }

  /* Built-up intensity score and automatic seed labels.
   * Only the clearest cells become seeds (bottom quarter → Low, middle band → Medium,
   * top quarter → High); the model then predicts everything in between.
   * Manual labels set on the map always override seeds. */
  function seedLabels(cells) {
    const ranks = GeoAI.SEED_KEYS.map((k) => pctRank(cells.map((c) => c.ind[k] || 0)));
    cells.forEach((c, i) => { c.score = ranks.reduce((s, r) => s + r[i], 0) / ranks.length; });
    const sorted = cells.map((c) => c.score).sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    const q25 = q(0.25), q40 = q(0.4), q60 = q(0.6), q75 = q(0.75);
    for (const c of cells) {
      c.seedLabel = null;
      if (c.ind.bld_count === 0 || c.score <= q25) c.seedLabel = 'Low';
      else if (c.score >= q75) c.seedLabel = 'High';
      else if (c.score >= q40 && c.score <= q60) c.seedLabel = 'Medium';
    }
    return { q25, q40, q60, q75 };
  }

  /* ------------------------------ Training ------------------------------ */
  function featureKeys(cells) {
    return GeoAI.INDICATORS.map((d) => d.key).filter((k) => cells.some((c) => c.ind[k] != null && isFinite(c.ind[k])));
  }
  function matrix(cells, keys, medians) {
    return cells.map((c) => keys.map((k, j) => { const v = c.ind[k]; return v == null || !isFinite(v) ? medians[j] : v; }));
  }

  function train(cells, opts) {
    const names = GeoAI.CONFIG.classes, K = names.length;
    const o = Object.assign({}, GeoAI.CONFIG.rf, opts || {});
    const keys = o.keys || featureKeys(cells);
    const labelled = cells.filter((c) => c.manualLabel || c.seedLabel);
    const labelOf = (c) => names.indexOf(c.manualLabel || c.seedLabel);
    const present = new Set(labelled.map(labelOf));
    if (labelled.length < 15 || present.size < 2) {
      return { ok: false, reason: 'Not enough labelled cells to train a model (need at least 15 across two or more classes). Draw a larger area or label more cells.' };
    }
    const medians = keys.map((k) => GeoAI.Geo.median(cells.map((c) => c.ind[k]).filter((v) => v != null && isFinite(v))));

    // stratified train / validation split
    const rnd = GeoAI.Geo.rng(o.seed);
    const trainIdx = [], testIdx = [];
    for (let k = 0; k < K; k++) {
      const group = labelled.map((c, i) => [c, i]).filter(([c]) => labelOf(c) === k).map(([, i]) => i);
      for (let i = group.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [group[i], group[j]] = [group[j], group[i]]; }
      const nTest = group.length >= 4 ? Math.round(group.length * o.testShare) : 0;
      testIdx.push(...group.slice(0, nTest)); trainIdx.push(...group.slice(nTest));
    }
    const X = matrix(labelled, keys, medians), y = labelled.map(labelOf);
    const pick = (arr, ids) => ids.map((i) => arr[i]);

    let validation = null;
    if (testIdx.length >= 5) {
      const evalModel = new RandomForest(o).fit(pick(X, trainIdx), pick(y, trainIdx), K);
      const yp = testIdx.map((i) => evalModel.predict(X[i]));
      validation = metrics(pick(y, testIdx), yp, K, names);
      validation.trainSize = trainIdx.length; validation.testSize = testIdx.length;
    }
    // final model on all labels
    const model = new RandomForest(o).fit(X, y, K);
    const all = matrix(cells, keys, medians);
    cells.forEach((c, i) => {
      const p = model.predictProba(all[i]);
      const k = p.indexOf(Math.max(...p));
      c.pred = names[k]; c.prob = p[k]; c.probs = p;
    });
    const importance = keys.map((k, j) => ({ key: k, value: model.importance[j] })).sort((a, b) => b.value - a.value);
    const seedCounts = {}, manual = cells.filter((c) => c.manualLabel).length;
    labelled.forEach((c) => { const l = c.manualLabel || c.seedLabel; seedCounts[l] = (seedCounts[l] || 0) + 1; });
    return { ok: true, model, keys, medians, validation, importance, labelled: labelled.length, manual, labelCounts: seedCounts };
  }

  /* apply a trained model to another set of cells (e.g. the baseline period) */
  function apply(result, cells) {
    const names = GeoAI.CONFIG.classes;
    const X = matrix(cells, result.keys, result.medians);
    cells.forEach((c, i) => {
      const p = result.model.predictProba(X[i]);
      const k = p.indexOf(Math.max(...p));
      c.pred = names[k]; c.prob = p[k]; c.probs = p;
    });
  }

  /* ------------------------------ Change detection ------------------------------ */
  function change(baseCells, curCells) {
    const names = GeoAI.CONFIG.classes;
    const base = new Map(baseCells.map((c) => [c.id, c]));
    const matrix = names.map(() => names.map(() => 0));
    const tally = { intensified: 0, declined: 0, stable: 0, new_development: 0 };
    let newBuildings = 0, addedArea = 0, addedRoad = 0;
    for (const c of curCells) {
      const b = base.get(c.id); if (!b) continue;
      const i0 = names.indexOf(b.pred), i1 = names.indexOf(c.pred);
      matrix[i0][i1]++;
      const d = {
        from: b.pred, to: c.pred,
        d_bld_count: c.ind.bld_count - b.ind.bld_count,
        d_builtup_area: c.ind.builtup_area - b.ind.builtup_area,
        d_coverage: c.ind.coverage_ratio - b.ind.coverage_ratio,
        d_road_length: c.ind.road_length - b.ind.road_length
      };
      d.type = b.ind.bld_count === 0 && c.ind.bld_count > 0 ? 'new_development' : i1 > i0 ? 'intensified' : i1 < i0 ? 'declined' : 'stable';
      tally[d.type]++;
      c.change = d;
      newBuildings += d.d_bld_count; addedArea += d.d_builtup_area; addedRoad += d.d_road_length;
    }
    return { matrix, tally, newBuildings, addedArea, addedRoad };
  }

  GeoAI.Model = { RandomForest, metrics, seedLabels, train, apply, change, featureKeys };
})(typeof window !== 'undefined' ? window : globalThis);
