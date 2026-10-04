/* GeoAI Urban Mapping Platform — shared configuration
 * The indicator list is the single source of truth for the 30 indicators.
 * The Python pipeline (python/geoai_pipeline.py) writes the same keys,
 * so web and Python outputs share one schema.
 */
(function (root) {
  const GeoAI = (root.GeoAI = root.GeoAI || {});

  GeoAI.CONFIG = {
    cellSize: 250,                // metres
    maxAoiKm2: 60,                // hard limit for in-browser runs
    warnAoiKm2: 20,
    smallBuilding: 50,            // m²
    largeBuilding: 500,           // m²
    distanceCap: 5000,            // m — distances beyond this are capped
    rf: { trees: 100, maxDepth: 12, minLeaf: 2, testShare: 0.3, seed: 42 },
    classes: ['Low', 'Medium', 'High'],
    classColors: { Low: '#F3DE8A', Medium: '#EE8B3A', High: '#B8233A' },
    overpass: [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.private.coffee/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
    ],
    stac: 'https://earth-search.aws.element84.com/v1/search'
  };

  // group: building | distribution | road | service | environment
  GeoAI.INDICATORS = [
    { key: 'bld_count', label: 'Building count', group: 'building', unit: '' },
    { key: 'bld_density', label: 'Building density', group: 'building', unit: '/km²' },
    { key: 'builtup_area', label: 'Built-up area', group: 'building', unit: 'm²' },
    { key: 'coverage_ratio', label: 'Building coverage ratio', group: 'building', unit: '%' , pct: true },
    { key: 'mean_footprint', label: 'Mean footprint', group: 'building', unit: 'm²' },
    { key: 'median_footprint', label: 'Median footprint', group: 'building', unit: 'm²' },
    { key: 'std_footprint', label: 'Footprint std. deviation', group: 'building', unit: 'm²' },
    { key: 'max_footprint', label: 'Largest footprint', group: 'building', unit: 'm²' },
    { key: 'small_bld_share', label: 'Small buildings (<50 m²)', group: 'building', unit: '%', pct: true },
    { key: 'large_bld_share', label: 'Large buildings (>500 m²)', group: 'building', unit: '%', pct: true },
    { key: 'mean_perimeter', label: 'Mean perimeter', group: 'building', unit: 'm' },
    { key: 'mean_compactness', label: 'Mean compactness', group: 'building', unit: '0–1' },
    { key: 'mean_levels', label: 'Mean building levels', group: 'building', unit: 'floors' },
    { key: 'floor_area_ratio', label: 'Floor area ratio', group: 'building', unit: '' },
    { key: 'mean_nn_dist', label: 'Mean nearest-building distance', group: 'distribution', unit: 'm' },
    { key: 'neighbour_coverage', label: 'Neighbourhood coverage', group: 'distribution', unit: '%', pct: true },
    { key: 'road_length', label: 'Road length', group: 'road', unit: 'm' },
    { key: 'road_density', label: 'Road density', group: 'road', unit: 'km/km²' },
    { key: 'intersection_count', label: 'Intersections', group: 'road', unit: '' },
    { key: 'intersection_density', label: 'Intersection density', group: 'road', unit: '/km²' },
    { key: 'major_road_share', label: 'Major-road share', group: 'road', unit: '%', pct: true },
    { key: 'dist_major_road', label: 'Distance to major road', group: 'road', unit: 'm' },
    { key: 'amenity_count', label: 'Services and amenities', group: 'service', unit: '' },
    { key: 'service_diversity', label: 'Service diversity', group: 'service', unit: 'types' },
    { key: 'dist_school', label: 'Distance to school', group: 'service', unit: 'm' },
    { key: 'dist_health', label: 'Distance to health facility', group: 'service', unit: 'm' },
    { key: 'green_share', label: 'Green space share', group: 'environment', unit: '%', pct: true },
    { key: 'water_share', label: 'Water share', group: 'environment', unit: '%', pct: true },
    { key: 'ndvi_mean', label: 'Mean NDVI', group: 'environment', unit: '', spectral: true },
    { key: 'ndbi_mean', label: 'Mean NDBI', group: 'environment', unit: '', spectral: true }
  ];

  GeoAI.GROUPS = {
    building: 'Building morphology',
    distribution: 'Spatial distribution',
    road: 'Road network',
    service: 'Urban services',
    environment: 'Environment & spectral'
  };

  // Indicators used to build the automatic seed labels (step 10)
  GeoAI.SEED_KEYS = ['coverage_ratio', 'bld_density', 'floor_area_ratio', 'road_density'];
})(typeof window !== 'undefined' ? window : globalThis);
