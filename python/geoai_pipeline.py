"""
GeoAI Urban Mapping Platform — Python pipeline
==============================================

Runs the same 15-step methodology as the web platform, for areas too large for
the browser and with data sources that need a Python environment:

  * OpenStreetMap via the Overpass API (current or a historical date)
  * Overture Maps building footprints (``overturemaps`` package)
  * Sentinel-2 L2A cloud-masked median composite (Earth Search STAC + odc-stac)

Outputs (EPSG:4326): analysis cells with the 30 indicators and the predicted
built-up intensity (GeoJSON + CSV), cleaned building footprints, and a JSON
file with validation metrics, feature importance and the data-quality report.

Example
-------
    python geoai_pipeline.py --aoi aoi.geojson --out results/ \
        --overture --sentinel2 --baseline 2019-01-01

    # offline / reproducible: use a saved Overpass response instead of the API
    python geoai_pipeline.py --aoi aoi.geojson --osm-json osm.json --out results/
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import geopandas as gpd
import requests
from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.validation import make_valid
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, cohen_kappa_score, confusion_matrix, precision_recall_fscore_support
from sklearn.model_selection import train_test_split

CLASSES = ["Low", "Medium", "High"]
INDICATORS = [
    "bld_count", "bld_density", "builtup_area", "coverage_ratio", "mean_footprint", "median_footprint",
    "std_footprint", "max_footprint", "small_bld_share", "large_bld_share", "mean_perimeter",
    "mean_compactness", "mean_levels", "floor_area_ratio", "mean_nn_dist", "neighbour_coverage",
    "road_length", "road_density", "intersection_count", "intersection_density", "major_road_share",
    "dist_major_road", "amenity_count", "service_diversity", "dist_school", "dist_health",
    "green_share", "water_share", "ndvi_mean", "ndbi_mean",
]
SEED_KEYS = ["coverage_ratio", "bld_density", "floor_area_ratio", "road_density"]
DIST_CAP = 5000.0
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
HIGHWAYS = ("motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|"
            "pedestrian|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link")
MAJOR = {"motorway", "trunk", "primary", "secondary", "motorway_link", "trunk_link", "primary_link", "secondary_link"}
EDUCATION = {"school", "kindergarten", "college", "university", "childcare"}
HEALTH = {"hospital", "clinic", "doctors", "pharmacy", "dentist", "health_post"}


def log(msg: str) -> None:
    print(f"[geoai] {msg}", file=sys.stderr, flush=True)


# ----------------------------------------------------------------------------- 1. AOI
def load_aoi(path: str) -> gpd.GeoDataFrame:
    aoi = gpd.read_file(path).to_crs(4326)
    geom = make_valid(aoi.union_all())
    return gpd.GeoDataFrame(geometry=[geom], crs=4326)


# ----------------------------------------------------------------------------- 2. acquisition
def overpass_query(aoi: gpd.GeoDataFrame, when: str | None) -> str:
    w, s, e, n = aoi.total_bounds
    bb = f"({s:.6f},{w:.6f},{n:.6f},{e:.6f})"
    head = "[out:json][timeout:600][maxsize:2147483648]" + (f'[date:"{when}T00:00:00Z"]' if when else "")
    return f"""{head};
(
  way["building"]{bb};
  relation["building"]["type"="multipolygon"]{bb};
  way["highway"~"^({HIGHWAYS})$"]{bb};
  nwr["amenity"]{bb}; nwr["healthcare"]{bb}; nwr["shop"]{bb};
  way["leisure"~"^(park|garden|nature_reserve|recreation_ground|golf_course)$"]{bb};
  way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|orchard|farmland|cemetery|reservoir|basin)$"]{bb};
  way["natural"~"^(wood|scrub|grassland|heath|water|wetland|beach)$"]{bb};
);
out geom;"""


def fetch_overpass(aoi: gpd.GeoDataFrame, when: str | None = None) -> dict:
    q = overpass_query(aoi, when)
    last = None
    for url in OVERPASS:
        try:
            log(f"Overpass {url} {'@ ' + when if when else '(current)'}")
            r = requests.post(url, data={"data": q}, timeout=900)
            r.raise_for_status()
            return r.json()
        except Exception as exc:  # noqa: BLE001 - try the next mirror
            last = exc
    raise RuntimeError(f"Overpass failed: {last}")


@dataclass
class OSMLayers:
    buildings: gpd.GeoDataFrame
    roads: gpd.GeoDataFrame
    amenities: gpd.GeoDataFrame
    green: gpd.GeoDataFrame
    water: gpd.GeoDataFrame
    node_ways: dict = field(default_factory=dict)


def parse_osm(js: dict) -> OSMLayers:
    b, r, a, g, wt = [], [], [], [], []
    node_ways: dict[int, list] = {}
    for el in js.get("elements", []):
        t = el.get("tags", {})
        geom = [(p["lon"], p["lat"]) for p in el.get("geometry", [])] if el.get("geometry") else None
        is_b = False
        if t.get("building") and el["type"] == "way" and geom and len(geom) >= 4:
            b.append({"source": "OSM", "src_id": f"w{el['id']}", "levels": _num(t.get("building:levels")), "geometry": Polygon(geom)})
            is_b = True
        elif t.get("building") and el["type"] == "relation":
            for m in el.get("members", []):
                if m.get("role") == "outer" and m.get("geometry") and len(m["geometry"]) >= 4:
                    b.append({"source": "OSM", "src_id": f"r{el['id']}", "levels": _num(t.get("building:levels")),
                              "geometry": Polygon([(p["lon"], p["lat"]) for p in m["geometry"]])})
            is_b = True
        if is_b and not (t.get("amenity") or t.get("healthcare") or t.get("shop")):
            continue
        if t.get("highway") and el["type"] == "way" and geom and len(geom) >= 2:
            r.append({"highway": t["highway"], "major": t["highway"] in MAJOR, "name": t.get("name"), "geometry": LineString(geom)})
            seen = set()
            for nid, pt in zip(el.get("nodes", []), geom):
                if nid in seen:
                    continue
                seen.add(nid)
                node_ways.setdefault(nid, [0, pt])[0] += 1
            continue
        if t.get("amenity") or t.get("healthcare") or t.get("shop"):
            if el["type"] == "node":
                pt = Point(el["lon"], el["lat"])
            elif el.get("bounds"):
                bb = el["bounds"]
                pt = Point((bb["minlon"] + bb["maxlon"]) / 2, (bb["minlat"] + bb["maxlat"]) / 2)
            else:
                continue
            am = t.get("amenity", "")
            cat = ("education" if am in EDUCATION else "health" if am in HEALTH or t.get("healthcare")
                   else "shop" if t.get("shop") else f"amenity:{am}")
            a.append({"category": cat, "name": t.get("name"), "geometry": pt})
            continue
        if geom and len(geom) >= 4 and el["type"] == "way":
            water = t.get("natural") in ("water", "wetland") or t.get("landuse") in ("reservoir", "basin")
            (wt if water else g).append({"kind": t.get("leisure") or t.get("landuse") or t.get("natural"), "geometry": Polygon(geom)})

    def gdf(rows, cols):
        return gpd.GeoDataFrame(rows if rows else [], columns=cols + ["geometry"], geometry="geometry", crs=4326)

    return OSMLayers(
        gdf(b, ["source", "src_id", "levels"]), gdf(r, ["highway", "major", "name"]),
        gdf(a, ["category", "name"]), gdf(g, ["kind"]), gdf(wt, ["kind"]), node_ways,
    )


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def fetch_overture_buildings(aoi: gpd.GeoDataFrame) -> gpd.GeoDataFrame:
    """Overture Maps building footprints for the AOI bounding box (needs `pip install overturemaps`)."""
    from overturemaps import core  # imported lazily: optional dependency

    log("Downloading Overture Maps buildings…")
    reader = core.record_batch_reader("building", tuple(aoi.total_bounds))
    table = reader.read_all()
    df = gpd.GeoDataFrame.from_arrow(table) if hasattr(gpd.GeoDataFrame, "from_arrow") else gpd.GeoDataFrame(table.to_pandas())
    if df.crs is None:
        df = df.set_crs(4326)
    levels = df["num_floors"] if "num_floors" in df else (df["height"] / 3.2 if "height" in df else None)
    out = gpd.GeoDataFrame({"source": "Overture", "src_id": df.get("id"), "levels": levels}, geometry=df.geometry, crs=4326)
    return out[out.geometry.geom_type.isin(["Polygon", "MultiPolygon"])].explode(index_parts=False).reset_index(drop=True)


# ----------------------------------------------------------------------------- 3. Sentinel-2
def sentinel2_indices(aoi: gpd.GeoDataFrame, start: str, end: str, crs) -> tuple:
    """Cloud-masked median composite → NDVI and NDBI rasters (needs pystac-client, odc-stac)."""
    import pystac_client
    import odc.stac

    log(f"Sentinel-2 composite {start} → {end}")
    cat = pystac_client.Client.open("https://earth-search.aws.element84.com/v1")
    items = list(cat.search(collections=["sentinel-2-l2a"], bbox=list(aoi.total_bounds), datetime=f"{start}/{end}",
                            query={"eo:cloud_cover": {"lt": 30}}).items())
    if not items:
        raise RuntimeError("no Sentinel-2 scenes")
    ds = odc.stac.load(items, bands=["red", "nir", "swir16", "scl"], bbox=list(aoi.total_bounds), crs=str(crs),
                       resolution=10, groupby="solar_day", chunks={})
    bad = ds.scl.isin([0, 1, 3, 8, 9, 10, 11])
    out = {}
    for b in ["red", "nir", "swir16"]:
        v = ds[b].where(~bad).astype("float32")
        # processing baseline 04.00 (from 2022-01-25) adds a +1000 offset
        offset = xr_offset(ds)
        out[b] = ((v - offset) / 1e4).median("time").compute()
    ndvi = (out["nir"] - out["red"]) / (out["nir"] + out["red"])
    ndbi = (out["swir16"] - out["nir"]) / (out["swir16"] + out["nir"])
    return ndvi, ndbi, [i.id for i in items]


def xr_offset(ds):
    import xarray as xr
    t = pd.to_datetime(ds.time.values)
    return xr.DataArray(np.where(t >= pd.Timestamp("2022-01-25"), 1000.0, 0.0), dims="time", coords={"time": ds.time})


# ----------------------------------------------------------------------------- 4–5. quality, fusion, dedup
def clean_buildings(sets: list[gpd.GeoDataFrame], aoi_m: gpd.GeoDataFrame, crs) -> tuple[gpd.GeoDataFrame, dict]:
    rep = {"input": {}, "repaired": 0, "dropped_invalid": 0, "slivers": 0, "outside_aoi": 0, "duplicates": 0, "duplicates_by_source": {}}
    frames = []
    for prio, s in enumerate(sets):
        if s.empty:
            continue
        rep["input"][s["source"].iloc[0]] = len(s)
        s = s.to_crs(crs).copy()
        invalid = ~s.geometry.is_valid
        rep["repaired"] += int(invalid.sum())
        s.loc[invalid, "geometry"] = s.loc[invalid, "geometry"].apply(make_valid)
        s = s.explode(index_parts=False)
        s = s[s.geometry.geom_type == "Polygon"]
        rep["dropped_invalid"] += int((s.geometry.is_empty).sum())
        s = s[~s.geometry.is_empty]
        small = s.geometry.area < 2
        rep["slivers"] += int(small.sum())
        s = s[~small].copy()
        s["prio"] = prio
        frames.append(s)
    b = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=crs) if frames else gpd.GeoDataFrame(columns=["source", "src_id", "levels", "prio", "geometry"], geometry="geometry", crs=crs)
    inside = b.geometry.centroid.within(aoi_m.geometry.iloc[0])
    rep["outside_aoi"] = int((~inside).sum())
    b = b[inside].reset_index(drop=True)
    b["area"] = b.geometry.area

    # duplicate candidates: overlapping pairs
    pairs = gpd.sjoin(b[["geometry"]], b[["geometry"]], predicate="intersects", how="inner")
    pairs = pairs[pairs.index < pairs["index_right"]]
    drop = set()
    order = b.sort_values(["prio", "area"], ascending=[True, False]).index
    rank = pd.Series(np.arange(len(order)), index=order)
    for i, j in zip(pairs.index, pairs["index_right"]):
        if i in drop or j in drop:
            continue
        gi, gj = b.geometry[i], b.geometry[j]
        inter = gi.intersection(gj).area
        if inter == 0:
            continue
        small, big = min(gi.area, gj.area), max(gi.area, gj.area)
        iou = inter / (gi.area + gj.area - inter)
        if iou >= 0.5 or (inter / small >= 0.8 and small / big >= 0.6):
            loser = j if rank[i] < rank[j] else i
            drop.add(loser)
            src = b.at[loser, "source"]
            rep["duplicates_by_source"][src] = rep["duplicates_by_source"].get(src, 0) + 1
    rep["duplicates"] = len(drop)
    b = b.drop(index=list(drop)).reset_index(drop=True)
    rep["kept"] = len(b)
    rep["with_levels"] = int(b["levels"].notna().sum())
    return b, rep


# ----------------------------------------------------------------------------- 8. grid
def make_grid(aoi_m: gpd.GeoDataFrame, size: float) -> gpd.GeoDataFrame:
    poly = aoi_m.geometry.iloc[0]
    x0, y0, x1, y1 = poly.bounds
    x0, y0 = math.floor(x0 / size) * size, math.floor(y0 / size) * size
    cells = []
    for x in np.arange(x0, x1, size):
        for y in np.arange(y0, y1, size):
            c = box(x, y, x + size, y + size)
            if not c.intersects(poly):
                continue
            clip = c.intersection(poly)
            if clip.area < 1:
                continue
            cells.append({"cell_id": f"{int(x // size)}_{int(y // size)}", "i": int(x // size), "j": int(y // size), "area_m2": clip.area, "geometry": clip})
    return gpd.GeoDataFrame(cells, geometry="geometry", crs=aoi_m.crs)


# ----------------------------------------------------------------------------- 9. indicators
def nearest_dist(points_from: gpd.GeoSeries, points_to: gpd.GeoSeries, cap=DIST_CAP) -> np.ndarray:
    if points_to.empty:
        return np.full(len(points_from), cap)
    j = gpd.sjoin_nearest(gpd.GeoDataFrame(geometry=points_from.values, crs=points_from.crs),
                          gpd.GeoDataFrame(geometry=points_to.values, crs=points_to.crs), distance_col="d", max_distance=cap)
    d = j.groupby(level=0)["d"].min().reindex(range(len(points_from)))
    return d.fillna(cap).clip(upper=cap).to_numpy()


def compute_indicators(grid, bld, roads, amen, green, water, node_ways, crs, ndvi=None, ndbi=None) -> gpd.GeoDataFrame:
    g = grid.copy()
    km2 = g["area_m2"] / 1e6
    idx = g.set_index("cell_id")

    # buildings → cells by centroid
    if len(bld):
        cen = gpd.GeoDataFrame(bld.drop(columns="geometry"), geometry=bld.geometry.centroid, crs=crs)
        cen["perim"] = bld.geometry.length.values
        cen["compact"] = np.minimum(1, 4 * np.pi * bld["area"].values / np.maximum(cen["perim"].values, 1e-9) ** 2)
        cen["lv"] = bld["levels"].fillna(1).clip(1, 200).values
        cen["floor"] = bld["area"].values * cen["lv"]
        # nearest other building
        nn = gpd.sjoin_nearest(cen[["geometry"]], cen[["geometry"]], distance_col="d", exclusive=True, max_distance=500)
        cen["nn"] = nn.groupby(level=0)["d"].min().reindex(cen.index).fillna(500)
        j = gpd.sjoin(cen, g[["cell_id", "geometry"]], predicate="within", how="inner")
        agg = j.groupby("cell_id").agg(
            bld_count=("area", "size"), builtup_area=("area", "sum"), mean_footprint=("area", "mean"),
            median_footprint=("area", "median"), std_footprint=("area", "std"), max_footprint=("area", "max"),
            small_bld_share=("area", lambda a: (a < 50).mean()), large_bld_share=("area", lambda a: (a > 500).mean()),
            mean_perimeter=("perim", "mean"), mean_compactness=("compact", "mean"), mean_levels=("lv", "mean"),
            floor=("floor", "sum"), mean_nn_dist=("nn", "mean"))
    else:
        agg = pd.DataFrame()
    g = g.merge(agg, left_on="cell_id", right_index=True, how="left")
    for k in ["bld_count", "builtup_area", "mean_footprint", "median_footprint", "std_footprint", "max_footprint",
              "small_bld_share", "large_bld_share", "mean_perimeter", "mean_compactness", "mean_levels", "floor"]:
        g[k] = g.get(k, 0).fillna(0) if k in g else 0
    g["mean_nn_dist"] = g["mean_nn_dist"].fillna(500) if "mean_nn_dist" in g else 500
    g["bld_density"] = g["bld_count"] / km2
    g["coverage_ratio"] = (g["builtup_area"] / g["area_m2"]).clip(upper=1)
    g["floor_area_ratio"] = g["floor"] / g["area_m2"]

    # roads: exact overlay with cells
    if len(roads):
        r = roads.to_crs(crs)
        ov = gpd.overlay(r[["major", "geometry"]], g[["cell_id", "geometry"]], how="intersection", keep_geom_type=True)
        ov["len"] = ov.geometry.length
        ra = ov.groupby("cell_id").agg(road_length=("len", "sum"))
        ra["major_len"] = ov[ov["major"]].groupby("cell_id")["len"].sum()
        g = g.merge(ra, left_on="cell_id", right_index=True, how="left")
        major = r[r["major"]]
        major_pts = major.geometry.union_all() if len(major) else None
    else:
        g["road_length"], g["major_len"], major_pts = 0, 0, None
    g["road_length"] = g["road_length"].fillna(0)
    g["major_len"] = g["major_len"].fillna(0)
    g["road_density"] = g["road_length"] / 1000 / km2
    g["major_road_share"] = np.where(g["road_length"] > 0, g["major_len"] / g["road_length"].replace(0, 1), 0)

    # intersections: nodes shared by two or more ways
    inter = [Point(pt) for cnt, pt in node_ways.values() if cnt >= 2]
    if inter:
        ip = gpd.GeoDataFrame(geometry=inter, crs=4326).to_crs(crs)
        ic = gpd.sjoin(ip, g[["cell_id", "geometry"]], predicate="within").groupby("cell_id").size().rename("intersection_count")
        g = g.merge(ic, left_on="cell_id", right_index=True, how="left")
    g["intersection_count"] = g.get("intersection_count", pd.Series(0, index=g.index)).fillna(0)
    g["intersection_density"] = g["intersection_count"] / km2

    centroids = g.geometry.centroid
    g["dist_major_road"] = centroids.distance(major_pts).clip(upper=DIST_CAP).to_numpy() if major_pts is not None else DIST_CAP

    # services
    if len(amen):
        am = amen.to_crs(crs)
        am["grp"] = am["category"].str.split(":").str[0].where(am["category"].str.startswith("shop") | am["category"].isin(["education", "health"]), am["category"])
        aj = gpd.sjoin(am, g[["cell_id", "geometry"]], predicate="within")
        sa = aj.groupby("cell_id").agg(amenity_count=("category", "size"), service_diversity=("grp", "nunique"))
        g = g.merge(sa, left_on="cell_id", right_index=True, how="left")
        g["dist_school"] = nearest_dist(centroids, am[am["category"] == "education"].geometry)
        g["dist_health"] = nearest_dist(centroids, am[am["category"] == "health"].geometry)
    else:
        g["dist_school"] = g["dist_health"] = DIST_CAP
    g["amenity_count"] = g.get("amenity_count", pd.Series(0, index=g.index)).fillna(0)
    g["service_diversity"] = g.get("service_diversity", pd.Series(0, index=g.index)).fillna(0)

    # green and water share (exact area overlay)
    for name, layer in [("green_share", green), ("water_share", water)]:
        if len(layer):
            lay = gpd.GeoDataFrame(geometry=[make_valid(layer.to_crs(crs).union_all())], crs=crs)
            ov = gpd.overlay(g[["cell_id", "geometry"]], lay, how="intersection")
            share = (ov.set_index("cell_id").geometry.area / idx["area_m2"]).groupby(level=0).sum().clip(upper=1)
            g[name] = g["cell_id"].map(share).fillna(0)
        else:
            g[name] = 0.0
    g["green_share"] = (g["green_share"] - g["water_share"]).clip(lower=0)

    # spectral zonal means
    if ndvi is not None:
        g["ndvi_mean"] = zonal_mean(ndvi, g)
        g["ndbi_mean"] = zonal_mean(ndbi, g)
    else:
        g["ndvi_mean"] = np.nan
        g["ndbi_mean"] = np.nan

    # neighbourhood coverage (8 neighbours)
    cov = dict(zip(zip(g["i"], g["j"]), g["coverage_ratio"]))
    g["neighbour_coverage"] = [
        np.mean([cov[(i + a, j + b)] for a in (-1, 0, 1) for b in (-1, 0, 1) if (a or b) and (i + a, j + b) in cov] or [cov[(i, j)]])
        for i, j in zip(g["i"], g["j"])
    ]
    g["flag_missing_buildings"] = (g["road_length"] > 400) & (g["bld_count"] == 0) & (g["green_share"] < 0.5) & (g["water_share"] < 0.5)
    g["std_footprint"] = g["std_footprint"].fillna(0)
    return g.drop(columns=["floor", "major_len"], errors="ignore")


def zonal_mean(da, g) -> np.ndarray:
    from rasterio.features import geometry_mask
    tr = da.odc.geobox.transform if hasattr(da, "odc") else da.rio.transform()
    arr = da.values
    out = []
    for geom in g.geometry:
        m = ~geometry_mask([geom], out_shape=arr.shape, transform=tr)
        v = arr[m]
        v = v[np.isfinite(v)]
        out.append(float(v.mean()) if v.size else np.nan)
    return np.array(out)


# ----------------------------------------------------------------------------- 10–12. labels, RF, prediction
def seed_labels(g: pd.DataFrame) -> pd.Series:
    score = pd.concat([g[k].rank(pct=True) for k in SEED_KEYS], axis=1).mean(axis=1)
    q = score.quantile([0.25, 0.4, 0.6, 0.75])
    lab = pd.Series(pd.NA, index=g.index, dtype="object")
    lab[(score >= q[0.4]) & (score <= q[0.6])] = "Medium"
    lab[score >= q[0.75]] = "High"
    lab[(score <= q[0.25]) | (g["bld_count"] == 0)] = "Low"
    g["intensity_score"] = score
    return lab


def train_predict(g: gpd.GeoDataFrame, labels: pd.Series, features: list[str], seed=42):
    X = g[features].astype(float)
    med = X.median()
    X = X.fillna(med)
    lab = labels.dropna()
    y = lab.map(CLASSES.index)
    Xl = X.loc[lab.index]
    rf_kw = dict(n_estimators=100, max_depth=12, min_samples_leaf=2, max_features="sqrt", random_state=seed, n_jobs=-1)
    validation = None
    if len(lab) >= 20 and y.value_counts().min() >= 2:
        Xtr, Xte, ytr, yte = train_test_split(Xl, y, test_size=0.3, stratify=y, random_state=seed)
        m = RandomForestClassifier(**rf_kw).fit(Xtr, ytr)
        yp = m.predict(Xte)
        p, r, f, s = precision_recall_fscore_support(yte, yp, labels=[0, 1, 2], zero_division=0)
        validation = {
            "accuracy": accuracy_score(yte, yp), "kappa": cohen_kappa_score(yte, yp),
            "macro_f1": float(np.mean(f)), "confusion": confusion_matrix(yte, yp, labels=[0, 1, 2]).tolist(),
            "per_class": [{"name": c, "precision": p[k], "recall": r[k], "f1": f[k], "support": int(s[k])} for k, c in enumerate(CLASSES)],
            "train_size": len(ytr), "test_size": len(yte),
        }
    model = RandomForestClassifier(**rf_kw).fit(Xl, y)
    return model, med, validation


def apply_model(model, med, g, features):
    proba = np.zeros((len(g), 3))
    proba[:, model.classes_] = model.predict_proba(g[features].astype(float).fillna(med))
    g["intensity"] = [CLASSES[k] for k in proba.argmax(1)]
    g["confidence"] = proba.max(1)
    g["p_low"], g["p_medium"], g["p_high"] = proba[:, 0], proba[:, 1], proba[:, 2]
    return g


# ----------------------------------------------------------------------------- pipeline
def build_period(aoi, aoi_m, crs, grid, osm: OSMLayers, extra_sets, ndvi, ndbi):
    sets = [osm.buildings] + list(extra_sets)
    bld, q = clean_buildings(sets, aoi_m, crs)
    g = compute_indicators(grid, bld, osm.roads, osm.amenities, osm.green, osm.water, osm.node_ways, crs, ndvi, ndbi)
    return g, bld, q


def run(args):
    aoi = load_aoi(args.aoi)
    crs = aoi.estimate_utm_crs()
    aoi_m = aoi.to_crs(crs)
    log(f"AOI {aoi_m.area.iloc[0] / 1e6:.2f} km², working CRS {crs.to_string()}")

    js = json.load(open(args.osm_json)) if args.osm_json else fetch_overpass(aoi)
    osm = parse_osm(js)
    extra = [fetch_overture_buildings(aoi)] if args.overture else []
    ndvi = ndbi = None
    scenes = None
    warnings = []
    if args.sentinel2:
        try:
            end = date.today()
            ndvi, ndbi, scenes = sentinel2_indices(aoi, str(end - timedelta(days=365)), str(end), crs)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Sentinel-2 skipped: {exc}")

    grid = make_grid(aoi_m, args.cell_size)
    log(f"{len(grid)} cells of {args.cell_size} m")
    g, bld, quality = build_period(aoi, aoi_m, crs, grid, osm, extra, ndvi, ndbi)

    labels = seed_labels(g)
    if args.labels:  # optional manual ground truth: CSV with cell_id,label
        man = pd.read_csv(args.labels).set_index("cell_id")["label"]
        labels = g["cell_id"].map(man).fillna(labels).where(lambda s: s.isin(CLASSES))
    g["seed_label"] = labels
    features = [k for k in INDICATORS if g[k].notna().any()]
    if args.baseline and ndvi is None:
        features = [k for k in features if not k.startswith("nd")]
    model, med, validation = train_predict(g, labels, features)
    g = apply_model(model, med, g, features)
    log(f"validation: {json.dumps({k: validation[k] for k in ('accuracy', 'kappa', 'macro_f1')}) if validation else 'n/a'}")

    change = None
    if args.baseline:
        osm_b = parse_osm(fetch_overpass(aoi, args.baseline)) if not args.osm_json_baseline else parse_osm(json.load(open(args.osm_json_baseline)))
        gb, _, _ = build_period(aoi, aoi_m, crs, grid, osm_b, [], None, None)
        gb = apply_model(model, med, gb, features)
        cur = g if not extra else apply_model(model, med, build_period(aoi, aoi_m, crs, grid, osm, [], ndvi, ndbi)[0], features)
        before = gb.set_index("cell_id")
        now = cur.set_index("cell_id")
        i0 = before["intensity"].map(CLASSES.index)
        i1 = now["intensity"].map(CLASSES.index)
        ctype = np.where((before["bld_count"] == 0) & (now["bld_count"] > 0), "new_development",
                         np.where(i1 > i0, "intensified", np.where(i1 < i0, "declined", "stable")))
        g["intensity_before"] = g["cell_id"].map(before["intensity"])
        g["change_type"] = g["cell_id"].map(pd.Series(ctype, index=now.index))
        g["d_bld_count"] = g["cell_id"].map(now["bld_count"] - before["bld_count"])
        g["d_builtup_area"] = g["cell_id"].map(now["builtup_area"] - before["builtup_area"])
        g["d_road_length"] = g["cell_id"].map(now["road_length"] - before["road_length"])
        change = {"baseline": args.baseline, "tally": pd.Series(ctype).value_counts().to_dict(),
                  "transition_matrix": pd.crosstab(i0, i1).reindex(index=[0, 1, 2], columns=[0, 1, 2], fill_value=0).values.tolist()}

    # ----------------------------------------------------------------- 14. export
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    g["cell_size_m"] = args.cell_size
    cols = ["cell_id", "cell_size_m", "area_m2", "intensity", "confidence", "p_low", "p_medium", "p_high", "seed_label", "intensity_score"] + INDICATORS
    cols += [c for c in ["change_type", "intensity_before", "d_bld_count", "d_builtup_area", "d_road_length", "flag_missing_buildings"] if c in g]
    cells = g[cols + ["geometry"]].to_crs(4326)
    cells.to_file(out / "geoai_cells.geojson", driver="GeoJSON")
    c4326 = cells.copy()
    cen = g.geometry.centroid.to_crs(4326)
    c4326.insert(0, "lat", cen.y.round(6)); c4326.insert(0, "lon", cen.x.round(6))
    pd.DataFrame(c4326.drop(columns="geometry")).to_csv(out / "geoai_cells.csv", index=False)
    bld[["source", "src_id", "levels", "area", "geometry"]].to_crs(4326).to_file(out / "geoai_buildings_clean.geojson", driver="GeoJSON")
    metrics = {
        "aoi_km2": float(aoi_m.area.iloc[0] / 1e6), "cells": len(g), "cell_size_m": args.cell_size,
        "labelled_cells": int(labels.notna().sum()), "label_counts": labels.value_counts().to_dict(),
        "features": features, "validation": validation,
        "feature_importance": sorted(({"key": k, "value": float(v)} for k, v in zip(features, model.feature_importances_)), key=lambda d: -d["value"]),
        "quality": quality, "change": change, "sentinel2_scenes": scenes, "warnings": warnings,
        "class_area_share": (g.groupby("intensity")["area_m2"].sum() / g["area_m2"].sum()).to_dict(),
    }
    (out / "geoai_metrics.json").write_text(json.dumps(metrics, indent=2, default=lambda o: o.item() if hasattr(o, "item") else str(o)))
    log(f"wrote results to {out.resolve()}")
    return g, metrics


def main(argv=None):
    p = argparse.ArgumentParser(description="GeoAI Urban Mapping Platform pipeline")
    p.add_argument("--aoi", required=True, help="AOI polygon (GeoJSON, GeoPackage or Shapefile)")
    p.add_argument("--out", default="results", help="output folder")
    p.add_argument("--cell-size", type=float, default=250, help="analysis cell size in metres (default 250)")
    p.add_argument("--overture", action="store_true", help="fuse Overture Maps building footprints")
    p.add_argument("--sentinel2", action="store_true", help="add NDVI/NDBI from a Sentinel-2 composite")
    p.add_argument("--baseline", help="change detection against OpenStreetMap at this date (YYYY-MM-DD)")
    p.add_argument("--labels", help="CSV of manual ground truth: cell_id,label (Low|Medium|High)")
    p.add_argument("--osm-json", help="use a saved Overpass JSON response instead of querying the API")
    p.add_argument("--osm-json-baseline", help="saved Overpass JSON for the baseline date")
    run(p.parse_args(argv))


if __name__ == "__main__":
    main()
