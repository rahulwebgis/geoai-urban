# GeoAI Urban Mapping Platform

**Transforming geospatial data into intelligent urban insights.**

An interactive web platform that turns scattered, multi-source geospatial data into decision-ready indicators. Draw a study area, and the platform collects open data, checks and cleans it, computes 30 urban indicators on a 250 m grid, classifies built-up intensity with a Random Forest, detects change over time and exports maps, tables and a PDF report.

Everything runs in the browser, so the site can be hosted for free on GitHub Pages. A companion Python pipeline runs the same methodology for whole cities and regions.

```
Data → Quality checks → GeoAI analysis → Validation → Spatial indicators → Maps & reports → Decision support
```

## Features

| | |
|---|---|
| **Multi-source data** | OpenStreetMap (live via Overpass, including historical snapshots), Sentinel-2 L2A imagery read directly from cloud-optimised GeoTIFFs, plus your own footprints (Overture Maps, Microsoft, Google Open Buildings) |
| **Data quality** | Geometry validation and repair, AOI clipping by the actual polygon, multi-source fusion and spatial deduplication, completeness checks |
| **30 indicators** | Building morphology, density, coverage, roads, spatial distribution, services, green space, water, NDVI and NDBI |
| **GeoAI** | Random Forest (100 trees) with automatic seed labels, editable ground truth on the map, held-out validation: confusion matrix, accuracy, kappa, precision, recall, F1 |
| **Change detection** | Same grid and model applied to an earlier OpenStreetMap snapshot: intensified, declined, stable, newly developed |
| **Outputs** | Interactive map layers, CSV and GeoJSON for ArcGIS and QGIS, PDF report |

## Pages

- **Home** — what the platform is, key features, applications.
- **Analytics Platform** — the working tool.
- **Methodology** — the 15-step workflow and the indicator catalogue.

## Using the analytics platform

1. Search for a place, then draw a polygon or rectangle (or upload a GeoJSON boundary). 2–15 km² gives results in seconds; up to 60 km² runs in the browser.
2. Choose the cell size (250 m by default), whether to add Sentinel-2 spectral indices, and optionally a baseline date for change detection.
3. Optionally add building footprints from another source to fuse with OpenStreetMap.
4. Run. Click any cell to see its 30 indicators and to relabel it; retrain the model with your labels from the **Model** tab.
5. Export from the **Export** tab.

## The 30 indicators

| Group | Indicators |
|---|---|
| Building morphology | building count, building density, built-up area, coverage ratio, mean / median / std. / largest footprint, share of small (<50 m²) and large (>500 m²) buildings, mean perimeter, mean compactness, mean levels, floor area ratio |
| Spatial distribution | mean nearest-building distance, neighbourhood coverage |
| Road network | road length, road density, intersections, intersection density, major-road share, distance to major road |
| Urban services | services and amenities, service diversity, distance to school, distance to health facility |
| Environment & spectral | green space share, water share, mean NDVI, mean NDBI |

## Run locally

It is a static site — any web server works:

```bash
python -m http.server 8000
# open http://localhost:8000
```

## Publish on GitHub Pages

```bash
git init
git add .
git commit -m "GeoAI Urban Mapping Platform"
git branch -M main
git remote add origin https://github.com/<your-user>/geoai-urban-mapping-platform.git
git push -u origin main
```

Then in the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The included workflow (`.github/workflows/pages.yml`) publishes the site on every push to `main` at `https://<your-user>.github.io/geoai-urban-mapping-platform/`.

## Python pipeline (regional scale)

`python/geoai_pipeline.py` runs the same steps with GeoPandas and scikit-learn, adds Overture Maps footprints and a cloud-masked Sentinel-2 median composite, and writes outputs with the same column names as the web platform.

```bash
cd python
pip install -r requirements.txt
python geoai_pipeline.py --aoi ../examples/riyadh_demo_aoi.geojson --out results \
    --overture --sentinel2 --baseline 2019-01-01
```

Options: `--cell-size` (metres), `--labels cells.csv` (manual ground truth as `cell_id,label`), `--osm-json` / `--osm-json-baseline` (use saved Overpass responses for reproducible runs).

## Project structure

```
index.html            Home, Analytics Platform and Methodology pages
css/style.css
js/config.js          settings and the 30-indicator definitions
js/geo.js             projections, spatial indexes, the 250 m grid
js/sources.js         Overpass, uploaded footprints, Sentinel-2 (STAC + COG)
js/quality.js         validation, repair, fusion, deduplication
js/features.js        indicator computation
js/model.js           seed labels, Random Forest, metrics, change detection
js/pipeline.js        the 15-step workflow
js/report.js          insights, CSV / GeoJSON / PDF
js/app.js             interface and map
js/hero.js            home page illustration
python/               regional-scale pipeline
examples/             sample AOI
```

## Limits worth knowing

- Results depend on how complete the source data is. Cells with roads but no mapped buildings are flagged; adding footprints from another source usually closes the gap.
- Automatic seed labels come from four indicators (coverage, building density, floor area ratio, road density), so validation scores measure agreement with those rules until you add manual labels.
- Building levels are often missing in OpenStreetMap; one storey is assumed where none is recorded.
- Historical OpenStreetMap snapshots show what was mapped at that date, which can lag behind construction.
- Public Overpass servers have usage limits. For large or repeated runs use the Python pipeline with saved responses or your own Overpass instance.

## Built with

Python · JavaScript · HTML · CSS · [Leaflet](https://leafletjs.com) · [Turf.js](https://turfjs.org) · [Chart.js](https://www.chartjs.org) · [jsPDF](https://github.com/parallax/jsPDF) · [geotiff.js](https://geotiffjs.github.io) · [proj4js](http://proj4js.org) · GeoPandas · scikit-learn

## Data and attribution

Map data © OpenStreetMap contributors, available under the ODbL. Contains modified Copernicus Sentinel data, accessed through Element 84 Earth Search. Overture Maps data under its respective licences (ODbL / CDLA). Satellite basemap © Esri and partners.

## Licence

MIT — see [LICENSE](LICENSE).
