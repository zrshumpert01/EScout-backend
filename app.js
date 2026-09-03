/* EScout — interactive product demo */
(() => {
  'use strict';

  /* ---------------- Security helpers ---------------- */
  // Escapes user-controlled text (e.g. waypoint labels, which can arrive via the
  // pin-sharing/import flow from a *different* visitor) before it is interpolated
  // into innerHTML, to prevent stored XSS.
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  /* ---------------- Theme ---------------- */
  const root = document.documentElement;
  let theme = matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'dark'; // default dark (field-console)
  root.setAttribute('data-theme', theme);
  const themeToggle = document.getElementById('themeToggle');
  function setThemeIcon() {
    themeToggle.innerHTML =
      theme === 'dark'
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }
  setThemeIcon();
  themeToggle.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', theme);
    setThemeIcon();
  });

  /* ---------------- Toasts ---------------- */
  const toastStack = document.getElementById('toastStack');
  function toast(msg, ms = 2600) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    toastStack.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 240ms';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 260);
    }, ms);
  }

  /* ---------------- Map ---------------- */
  const CENTER = [-88.852, 34.318]; // Tombigbee National Forest area, near Tupelo, MS

  // Esri World Imagery — free, no-key satellite tile service (ArcGIS Online)
  const ESRI_SAT_RAW_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  // Routed through the escout-sharpen protocol so every tile gets a contrast/clarity boost
  // on arrival — this squeezes noticeably crisper, better-defined imagery out of the same
  // source pixels, which matters because the underlying tile cache tops out at native z19
  // in most rural areas (confirmed no real z20+ data exists to fetch instead).
  const ESRI_SAT_TILES = `escout-sharpen://${ESRI_SAT_RAW_TILES}`;
  // Esri's live World Imagery mosaic is a continuously-refreshed composite, but it can
  // still carry cloud cover baked into the most recent capture for a given spot (a known
  // limitation of any single-date satellite basemap). Esri's Wayback archive keeps every
  // past monthly release addressable by a stable release ID, so offering a handful of
  // older captures lets a user simply pick a different pass if the current one is cloudy
  // over their specific hunting ground — the same tile grid, just a different capture date.
  const WAYBACK_TILE_TEMPLATE = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{releaseId}/{z}/{y}/{x}';
  const IMAGERY_VINTAGES = [
    { id: 'live', label: 'Live (Newest)', releaseId: null },
    { id: 'v2026-06', label: 'Jun 2026', releaseId: 32246 },
    { id: 'v2026-04', label: 'Apr 2026', releaseId: 49059 },
    { id: 'v2026-01', label: 'Jan 2026', releaseId: 22252 },
    { id: 'v2025-09', label: 'Sep 2025', releaseId: 58924 },
    { id: 'v2025-05', label: 'May 2025', releaseId: 25285 },
    { id: 'v2025-01', label: 'Jan 2025', releaseId: 36557 },
    { id: 'v2024-09', label: 'Sep 2024', releaseId: 20337 },
  ];
  function imageryVintage(id) {
    return IMAGERY_VINTAGES.find((v) => v.id === id) || IMAGERY_VINTAGES[0];
  }
  // "Winter / Leaf-Off" over Mississippi routes the satellite source through the
  // escout-leafoff protocol (registered below, next to the other custom tile protocols),
  // which serves the real MARIS/MDEQ statewide leaf-off aerial mosaic — genuine bare-tree
  // winter photography flown county-by-county 2016-2024, not a color filter. Outside
  // Mississippi (where no equivalent free nationwide leaf-off source exists — confirmed via
  // research: NAIP is leaf-on by federal mandate, and true leaf-off imagery only exists as a
  // patchwork of individual state GIS programs), the same protocol falls back to a real
  // December-dated Esri Wayback capture with a winter color grade layered on top, exactly as
  // before. Release 13192 is Wayback's newest release tagged "World Imagery (Wayback
  // 2025-12-18)". Important caveat verified against several rural test locations outside MS:
  // Wayback only re-publishes a tile when a new source capture actually becomes available for
  // that exact spot, so a given release's "December" label does NOT guarantee every tile
  // changed color for winter — plenty of rural/wooded tiles go a year or more between
  // refreshes. So the real dated tile is the fallback base layer, with the grade (see
  // LEAFOFF_FALLBACK_GRADE near the escout-leafoff protocol registration) on top to keep the
  // seasonal switch visible everywhere the real MS mosaic doesn't cover. 16453
  // ("2024-12-12") is a second real December capture, documented here for manual swap-in if
  // Esri ever retires 13192.
  const WAYBACK_WINTER_RELEASE_ID = 13192; // World Imagery (Wayback 2025-12-18)
  function satTilesFor(vintageId, seasonId) {
    if (seasonId === 'leafoff') {
      return 'escout-leafoff://{z}/{x}/{y}/{bbox-epsg-3857}';
    }
    const v = imageryVintage(vintageId);
    const raw = v.releaseId == null ? ESRI_SAT_RAW_TILES : WAYBACK_TILE_TEMPLATE.replace('{releaseId}', v.releaseId);
    return `escout-sharpen://${raw}`;
  }
  // Esri World Transportation — real road lines, street names, and highway/route number
  // shields (e.g. "178"), free & no-key. This is what actually puts road numbers & data
  // on top of the satellite imagery (the old Boundaries_and_Places layer only carried
  // admin borders/city labels and returned blank tiles over most rural hunting ground).
  // The service's own rendering paints minor/unclassified roads — which is what most
  // rural county roads are classified as — in a pale, low-contrast tan that all but
  // vanishes against dirt, sand, or dry-grass satellite imagery. Route every tile through
  // the escout-roadboost protocol (see below) to add a dark halo behind every line/label
  // and punch up contrast/saturation, so county roads stay readable on any terrain.
  const ESRI_ROADS_RAW_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}';
  const ESRI_ROADS_TILES = `escout-roadboost://${ESRI_ROADS_RAW_TILES}`;
  // Esri's own transportation tiles fall back to genuinely blank tiles for sparse rural
  // road networks above roughly z16 (confirmed by direct inspection across multiple
  // states) — the service's minor-road symbology only renders within a scale band that
  // doesn't extend to close-in zoom. Capping the SOURCE at this zoom means MapLibre
  // overzooms (upscales) the last tile that actually has content instead of requesting a
  // truly empty native tile, so county roads stay visible — just a little softer — when a
  // hunter zooms in close, rather than disappearing outright. Town/city road detail is
  // still crisp at this zoom, so populated areas lose very little.
  const ROADS_SOURCE_MAXZOOM = 15;
  // Esri World Boundaries & Places — county/city names and other place labels, layered
  // above roads in Hybrid mode for extra context.
  const ESRI_PLACES_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
  const ESRI_ATTR = 'Esri, Maxar, Earthstar Geographics';
  // USGS The National Map — free, no-key topographic raster basemap tiles (used for the
  // standalone Topo basemap option).
  const USGS_TOPO_TILES = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
  const USGS_TOPO_ATTR = 'USGS The National Map';
  // USGS 3DEP elevation ImageServer — dynamically renders real contour lines (10ft
  // interval, from actual lidar/DEM elevation data) as a transparent PNG overlay so
  // contour lines are visible over ANY basemap, not baked into a single topo tile set.
  const USGS_CONTOUR_SERVICE =
    'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
  const USGS_CONTOUR_RULE = encodeURIComponent(JSON.stringify({ rasterFunction: 'Preset 10ft Contour Interval' }));
  const USGS_CONTOUR_RAW_TILES =
    `${USGS_CONTOUR_SERVICE}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&renderingRule=${USGS_CONTOUR_RULE}&f=image`;
  const USGS_CONTOUR_ATTR = 'USGS 3DEP';
  // The service always renders contour lines as near-black pixels, which disappear into
  // shadows/tree cover on satellite imagery. Route the tile through the escout-recolor
  // protocol (see below) to repaint every opaque pixel a bright, high-contrast color while
  // keeping the original line shape (alpha channel) untouched.
  const CONTOUR_LINE_COLOR = 'ff6a00'; // vivid orange — reads clearly over green/brown terrain
  const USGS_CONTOUR_TILES = `escout-recolor://${CONTOUR_LINE_COLOR}/${USGS_CONTOUR_RAW_TILES}`;
  // USGS Hydro Cached — real named streams, rivers, ponds & lakes (National Hydrography
  // Dataset), rendered in blue on a transparent background. Layered together with the
  // contour overlay so "Topo Contours" shows both elevation lines AND water/creeks.
  const USGS_HYDRO_TILES = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}';
  const USGS_HYDRO_ATTR = 'USGS NHD';
  // Regrid nationwide parcel boundary tiles — free, no-key public reference layer
  const PARCEL_TILES = 'https://tiles.arcgis.com/tiles/KzeiCaQsMoeCfoCq/arcgis/rest/services/Regrid_Nationwide_Parcel_Boundaries_v1/MapServer/tile/{z}/{y}/{x}';
  const PARCEL_ATTR = 'Regrid';
  // US state boundary lines (US Census cartographic boundary data, public domain), bundled
  // locally so they render clearly and consistently on every basemap.
  const STATE_BOUNDARIES_URL = './assets/data/us-states.geojson';
  // PAD-US (Protected Areas Database of the US) — real public/protected land ownership
  // polygons (USFS national forest, BLM, state WMA/wildlife areas, DOD, FWS refuges, etc.).
  // This is the actual "hunting data" layer: hunters need to know which ground is
  // public-access vs. private.
  // Uses the PAD-US 4.1 "Landforms" service rather than the original PAD_US/MapServer
  // endpoint: direct comparison of both services' query results confirmed the original
  // service's PADUS4_0_FeeManagers layer only carries the Category='Fee' record type
  // (fee-simple land ownership), silently dropping every polygon filed under
  // Category='Designation' — which is exactly how many USACE reservoir/lake project
  // boundaries are recorded (the Corps holds much of a reservoir's shoreline via easement
  // or project designation rather than outright fee ownership). Mark Twain Lake, MO is a
  // confirmed real-world case: its ~19,400-acre USACE-managed lake boundary exists ONLY as
  // a Category='Designation' record and was completely invisible through the old service,
  // while the small Mark Twain State Park (Category='Fee', unrelated NPS-adjacent land)
  // rendered fine — this made it look like the whole lake was missing public-land data.
  // The Landforms/PADUS4_1Fee layer carries both Fee AND Designation categories (verified
  // via direct query — Yellowstone and Mark Twain National Forest also gained their
  // Proclamation/Designation-boundary polygons, in addition to the interior Fee parcels
  // both services already agreed on), so switching to it is a strict superset fix with no
  // loss of existing coverage. Same field schema, same dynamic (non tile-cached) MapServer
  // export {bbox-epsg-3857} export pattern already used for the 3DEP contour overlay.
  const USGS_PADUS_SERVICE = 'https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_Landforms/MapServer/export';
  // This layer (PADUS4_1Fee) already carries every public land agency in one dataset —
  // USFS, BLM, NPS, FWS, state WMAs/parks, county/city land, AND the Army Corps of
  // Engineers (Mang_Name='USACE', e.g. Corps lake and river-project land like the
  // Tenn-Tom Waterway/Okatibbee Lake recreation areas in Mississippi) — verified present
  // via the service's own query endpoint. No definitionExpression filter is applied below,
  // so every one of those managers, Corps of Engineers included, renders through
  // unfiltered. NOTE: PAD-US's per-project USACE coverage is inconsistent — some projects
  // (Okatibbee) are digitized as the full project footprint (land + water), while others
  // (Mark Twain Lake, MO) only got the reservoir's water surface digitized as a
  // Category='Designation' record, missing the tens of thousands of acres of surrounding
  // Corps-managed land that's actually open to public hunting. See the separate
  // USACE_CWLDM_* source below, which fixes that gap nationwide rather than special-casing
  // Mark Twain Lake.
  // The service's default per-agency symbology renders in muted pastel fills that wash out
  // against dark satellite imagery. Override it via the dynamicLayers parameter with a bold
  // single-color renderer (bright green — the color hunters expect public land to be marked
  // in) so the boundary reads as a clear, high-contrast highlight on ANY basemap, satellite
  // included, instead of relying on the service's own low-contrast default rendering.
  const PADUS_HIGHLIGHT_COLOR = [57, 255, 20]; // vivid "public land green"
  // Fill kept very faint (low alpha) and the outline thin so the highlight reads as a light
  // tint with a crisp boundary line, not a heavy block of color hiding the terrain/imagery
  // underneath it — the outline stays close to fully opaque so the boundary itself is still
  // easy to spot even though the fill is barely-there.
  const PADUS_DYNAMIC_LAYERS = encodeURIComponent(JSON.stringify([{
    id: 0,
    source: { type: 'mapLayer', mapLayerId: 0 },
    drawingInfo: {
      renderer: {
        type: 'simple',
        symbol: {
          type: 'esriSFS',
          style: 'esriSFSSolid',
          color: [...PADUS_HIGHLIGHT_COLOR, 10],
          outline: { type: 'esriSLS', style: 'esriSLSSolid', color: [...PADUS_HIGHLIGHT_COLOR, 210], width: 0.75 },
        },
      },
    },
  }]));
  const USGS_PADUS_TILES =
    `${USGS_PADUS_SERVICE}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&layers=show:0&dynamicLayers=${PADUS_DYNAMIC_LAYERS}&f=image`;
  const USGS_PADUS_ATTR = 'USGS PAD-US';
  // USACE's own real-estate system of record (REMIS "Civil Works Land Data Migration"),
  // queried directly rather than through PAD-US. Reason: PAD-US's per-reservoir USACE
  // coverage is inconsistent (see note above) — some Corps lake projects are digitized as
  // the full project footprint, others (confirmed case: Mark Twain Lake, MO) only got the
  // water surface digitized, silently dropping the surrounding project land that's the
  // actual public hunting ground. REMIS layer 5 ("Site") is the Corps' own authoritative
  // per-project real-estate boundary — verified directly against Mark Twain Lake: computing
  // the polygon's true area (Albers equal-area projection) gives ~65,000 acres, matching
  // the official USACE Master Plan's stated 54,741-acre project area plus 9,740 acres of
  // flowage easement (~64,500 acres total) — versus PAD-US's 19,446 acres for the same
  // reservoir, i.e. water only. Rendered as a second, independent green-highlight overlay
  // alongside (not replacing) the PAD-US layer above: for projects PAD-US already digitizes
  // correctly the two simply overlap harmlessly, and for gaps like Mark Twain Lake this is
  // the layer that actually fills them in. This is a nationwide fix, not a Mark-Twain-only
  // special case — REMIS covers every USACE Civil Works district's real estate the same way.
  const USACE_CWLDM_SERVICE = 'https://geospatial.sec.usace.army.mil/server/rest/services/REMIS/cwldm/MapServer/export';
  const USACE_CWLDM_DYNAMIC_LAYERS = encodeURIComponent(JSON.stringify([{
    id: 5,
    source: { type: 'mapLayer', mapLayerId: 5 },
    drawingInfo: {
      renderer: {
        type: 'simple',
        symbol: {
          type: 'esriSFS',
          style: 'esriSFSSolid',
          color: [...PADUS_HIGHLIGHT_COLOR, 10],
          outline: { type: 'esriSLS', style: 'esriSLSSolid', color: [...PADUS_HIGHLIGHT_COLOR, 210], width: 0.75 },
        },
      },
    },
  }]));
  const USACE_CWLDM_TILES =
    `${USACE_CWLDM_SERVICE}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&layers=show:5&dynamicLayers=${USACE_CWLDM_DYNAMIC_LAYERS}&f=image`;
  const USACE_CWLDM_ATTR = 'USACE REMIS';

  // Statewide cadastral (parcel) services — free, no-key, publicly queryable ArcGIS
  // MapServer/FeatureServer endpoints covering 29 states with real owner name, address,
  // acreage, and/or assessed-value fields, used to power live parcel attribute lookups on
  // click. States without a validated live source fall back to a clearly labeled estimate.
  const STATE_PARCEL_CONFIG = {
    "Alaska": { mode: "single", service: "https://services1.arcgis.com/7HDiw78fcUiM2BWn/arcgis/rest/services/AK_Parcels/FeatureServer", layerId: 0, fieldMap: { owner: "owner", acres: [], siteAddress: null, siteCity: "local_gov", parcelId: "parcel_id", value: "total_value" }, attribution: "State of Alaska DNR / Alaska Statewide Parcels (gis.data.alaska.gov, hosted on ArcGIS Online)" },
    "Arizona": { mode: "single", service: "https://azgeo.az.gov/arcgis/rest/services/TerraSystems/AZParcelFeatures/FeatureServer", layerId: 0, fieldMap: { owner: null, acres: [], siteAddress: "AZ_Address", siteCity: "AZ_PlaceName", parcelId: "AZ_APN", value: null }, attribution: "Arizona State Land Department / AZGeo Data Hub (azgeo.az.gov)" },
    "Arkansas": { mode: "single", service: "https://gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Planning_Cadastre/FeatureServer", layerId: 6, fieldMap: { owner: "ownername", acres: ["taxarea", "Shape__Area::sqm"], siteAddress: "adrlabel", siteCity: "adrcity", parcelId: "parcelid", value: "assessvalue" }, attribution: "Arkansas GIS Office (AGISO) statewide Planning_Cadastre parcel layer" },
    "Colorado": { mode: "single", service: "https://gis.colorado.gov/public/rest/services/Address_and_Parcel/Colorado_Public_Parcels/FeatureServer", layerId: 0, fieldMap: { owner: "owner", acres: ["landAcres"], siteAddress: "situsAdd", siteCity: "sitAddCty", parcelId: "parcel_id", value: "apprValTot" }, attribution: "Colorado Department of Local Affairs / gis.colorado.gov (Colorado_Public_Parcel_Composite)" },
    "Connecticut": { mode: "single", service: "https://services3.arcgis.com/3FL1kr7L4LvwA2Kb/arcgis/rest/services/Connecticut_CAMA_and_Parcel_Layer_2024/FeatureServer", layerId: 0, fieldMap: { owner: "Owner", acres: ["Land_Acres"], siteAddress: "Location_1", siteCity: "Town_Name", parcelId: "Parcel_ID", value: "Assessed_Total" }, attribution: "Connecticut statewide CAMA & Parcel Layer (state GIS Office / CT municipal COG data collection, per CGS Sec. 4d-90-92)" },
    "District of Columbia": { mode: "single", service: "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/DC_Property_Basemap_WebMercator/MapServer", layerId: 2, fieldMap: { owner: "OWNERNAME", acres: ["LANDAREA::sqft"], siteAddress: "PREMISEADD", siteCity: null, parcelId: "SSL", value: "NEWTOTAL" }, attribution: "DC Office of the Chief Technology Officer / DC GIS (DCGIS_DATA - Owner Polygons, Common Ownership Layer)" },
    "Florida": { mode: "single", service: "https://gis.arpc.org/server/rest/services/Florida_Statewide_Cadastral_MIL1/MapServer", layerId: 0, fieldMap: { owner: "ONAME", acres: ["ACRES", "LNDSQFOOT"], siteAddress: "PHYADDR1", siteCity: "PHYCITY", parcelId: "PARCELID", value: "JV" }, attribution: "Florida Dept. of Revenue Property Tax Oversight statewide cadastral (via ARPC hosting)" },
    "Hawaii": { mode: "single", service: "https://geodata.hawaii.gov/arcgis/rest/services/ParcelsZoning/MapServer", layerId: 25, fieldMap: { owner: null, acres: ["gisacres"], siteAddress: null, siteCity: "county", parcelId: "tmk_txt", value: null }, attribution: "Hawaii Statewide GIS Program, Office of Planning and Sustainable Development (geodata.hawaii.gov)" },
    "Idaho": { mode: "single", service: "https://gis.idwr.idaho.gov/hosting/rest/services/Reference/Parcels/MapServer", layerId: 0, fieldMap: { owner: "OWNER", acres: [], siteAddress: null, siteCity: null, parcelId: "PIN", value: null }, attribution: "Idaho Department of Water Resources GIS (gis.idwr.idaho.gov) - Reference Parcels" },
    "Iowa": { mode: "single", service: "https://services3.arcgis.com/kd9gaiUExYqUbnoq/arcgis/rest/services/Iowa_Parcels_2017/FeatureServer", layerId: 0, fieldMap: { owner: "DEEDHOLDER", acres: [], siteAddress: null, siteCity: "COUNTYNAME", parcelId: "STATEPARID", value: null }, attribution: "University of Iowa / Iowa Statewide Parcel Data, 2017 (IGIC)" },
    "Maryland": { mode: "single", service: "https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_ParcelBoundaries/MapServer", layerId: 0, fieldMap: { owner: null, acres: ["ACRES", "POLYACRES", "LANDAREA::sqft"], siteAddress: "ADDRESS", siteCity: "CITY", parcelId: "ACCTID", value: "NFMTTLVL" }, attribution: "MD iMap (Maryland Department of Planning / SDAT)" },
    "Minnesota": { mode: "single", service: "https://enterprise.gisdata.mn.gov/aghost/rest/services/us_mn_state_mngeo/plan_parcels_open/FeatureServer", layerId: 1, fieldMap: { owner: "owner_name", acres: ["acres_poly", "acres_deed"], siteAddress: "st_name", siteCity: "ctu_name", parcelId: "county_pin", value: "emv_total" }, attribution: "Minnesota Geospatial Commons / MnGeo Statewide Parcel Dataset (plan_parcels_open)" },
    "Mississippi": { mode: "county-routed", service: "https://gis.mississippi.edu/server/rest/services/Cadastral/MS_Parcels_Aprl2024/MapServer", excludeLayerIds: [0], fieldMap: { owner: "OWNNAME", acres: ["TOTAL_AC", "GISACRES", "TAXACRES"], siteAddress: "SITEADD", siteCity: "SCITY", parcelId: "PARNO", value: ["TOTVAL", "LANDVAL"] }, attribution: "Mississippi Automated Resource Information System (MARIS)" },
    "Montana": { mode: "single", service: "https://gis.dnrc.mt.gov/arcgis/rest/services/DNRALL/Cadastral/MapServer", layerId: 0, fieldMap: { owner: "OwnerName", acres: ["TotalAcres", "GISAcres"], siteAddress: "AddressLine1", siteCity: "CityStateZip", parcelId: "PARCELID", value: "TotalValue" }, attribution: "Montana DNRC / Montana State Library Cadastral" },
    "Nebraska": { mode: "single", service: "https://giscat.ne.gov/enterprise/rest/services/StatewideParcelsExternal/FeatureServer", layerId: 0, fieldMap: { owner: null, acres: ["Acres_Deeded", "GIS_Acres"], siteAddress: "Situs_Address", siteCity: "Ph_City", parcelId: "Parcel_ID", value: "Total_Assessed_Value" }, attribution: "Nebraska GIS Hub / Office of the CIO - Statewide Parcels (compiled from County Assessor CAMA data)" },
    "Nevada": { mode: "single", service: "https://gis.dot.nv.gov/agsphs/rest/services/Reference/Statewide_Parcels/MapServer", layerId: 0, fieldMap: { owner: "OwnerName", acres: ["Acres"], siteAddress: "SiteAddress", siteCity: "SiteCity", parcelId: "APN", value: null }, attribution: "Nevada Department of Transportation GIS (gis.dot.nv.gov) - Statewide Parcels" },
    "New Jersey": { mode: "single", service: "https://maps.nj.gov/arcgis/rest/services/Framework/Cadastral/MapServer", layerId: 0, fieldMap: { owner: "OWNER_NAME", acres: ["CALC_ACRE"], siteAddress: "PROP_LOC", siteCity: "MUN_NAME", parcelId: "PAMS_PIN", value: "NET_VALUE" }, attribution: "NJ Office of GIS (NJOGIS)" },
    "New Mexico": { mode: "county-routed", service: "https://gis.ose.nm.gov/server_s/rest/services/Parcels/County_Parcels_2025/MapServer", fieldMap: { owner: "Owner1", acres: ["LandArea"], siteAddress: "SitusAddressAll", siteCity: "SitusCity", parcelId: "UPC", value: null }, attribution: "New Mexico Office of the State Engineer (gis.ose.nm.gov)" },
    "New York": { mode: "single", service: "https://gisservices.its.ny.gov/arcgis/rest/services/NYS_Tax_Parcels_Public/MapServer", layerId: 1, fieldMap: { owner: "PRIMARY_OWNER", acres: ["ACRES", "CALC_ACRES"], siteAddress: "PARCEL_ADDR", siteCity: "MUNI_NAME", parcelId: "PRINT_KEY", value: "TOTAL_AV" }, attribution: "NYS GIS Clearinghouse (NYS ITS Geospatial Services)" },
    "North Carolina": { mode: "single", service: "https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer", layerId: 1, fieldMap: { owner: "ownname", acres: ["gisacres"], siteAddress: "siteadd", siteCity: "scity", parcelId: "parno", value: "parval" }, attribution: "NC OneMap / NC Center for Geographic Information and Analysis (NCCGIA)" },
    "North Dakota": { mode: "two-step-join", service: "https://services1.arcgis.com/GOcSXpzwBHyk2nog/arcgis/rest/services/NDGISHUB_Parcels/FeatureServer", layerId: 0, joinLayerId: 1, joinField: "UniqueGISID", fieldMap: { owner: "OwnerName", acres: ["DeededAcres", "CalculatedAcres"], siteAddress: "PropertyAddress", siteCity: "PropertyCity", parcelId: "UniqueParcelID", value: "TotalValue" }, attribution: "North Dakota GIS Hub / NDGISHUB Statewide Parcel Project (AppGeo)" },
    "Ohio": { mode: "single", service: "https://gis.ohiodnr.gov/arcgis/rest/services/OIT_Services/odnr_landbase/MapServer", layerId: 4, fieldMap: { owner: "OWNER1", acres: ["ASSR_ACRES", "CALC_ACRES"], siteAddress: null, siteCity: "COUNTY", parcelId: "STATEWIDE_PIN", value: null }, attribution: "Ohio Department of Natural Resources / Ohio Statewide Parcels - Live" },
    "Texas": { mode: "single", service: "https://services1.arcgis.com/1mtXwieMId59thmg/arcgis/rest/services/2019_Texas_Parcels_StratMap/FeatureServer", layerId: 0, fieldMap: { owner: "OWNER_NAME", acres: ["Shape__Area::sqm"], siteAddress: "SITUS_ADDR", siteCity: null, parcelId: "GEO_ID", value: null }, attribution: "Texas Geographic Information Office (TxGIO) StratMap statewide land parcels" },
    "Utah": { mode: "single", service: "https://services1.arcgis.com/99lidPhWCzftIe9K/arcgis/rest/services/UtahStatewideParcels/FeatureServer", layerId: 0, fieldMap: { owner: null, acres: [], siteAddress: "PARCEL_ADD", siteCity: "PARCEL_CITY", parcelId: "PARCEL_ID", value: null }, attribution: "Utah AGRC/UGRC Statewide Parcels" },
    "Vermont": { mode: "single", service: "https://services1.arcgis.com/BkFxaEFNwHqX3tAw/arcgis/rest/services/FS_VCGI_VTPARCELS_WM_NOCACHE_v2/FeatureServer", layerId: 1, fieldMap: { owner: "OWNER1", acres: ["ACRESGL"], siteAddress: "LOCAPROP", siteCity: "TOWN", parcelId: "SPAN", value: "REAL_FLV" }, attribution: "Vermont Center for Geographic Information (VCGI) - VTPARCELS w/ joined Grand List data" },
    "Washington": { mode: "single", service: "https://wisaard.dahp.wa.gov/server/rest/services/County_Parcels/MapServer", layerId: 0, fieldMap: { owner: null, acres: [], siteAddress: "SITUS_ADDRESS", siteCity: "SITUS_CITY_NM", parcelId: "PARCEL_ID_NR", value: "VALUE_LAND" }, attribution: "Washington Dept. of Archaeology & Historic Preservation - WISAARD statewide parcel aggregate" },
    "West Virginia": { mode: "single", service: "https://services.wvgis.wvu.edu/arcgis/rest/services/Planning_Cadastre/WV_Parcels/MapServer", layerId: 0, fieldMap: { owner: "FullOwnerName", acres: ["CALC_ACRE"], siteAddress: "FullPhysicalAddress", siteCity: null, parcelId: "GISPID", value: null }, attribution: "WV GIS Technical Center (WVGIS)" },
    "Wisconsin": { mode: "single", service: "https://services3.arcgis.com/n6uYoouQZW75n5WI/arcgis/rest/services/Wisconsin_Statewide_Parcels_DB/FeatureServer", layerId: 0, fieldMap: { owner: "OWNERNME1", acres: ["ASSDACRES", "DEEDACRES", "GISACRES"], siteAddress: "SITEADRESS", siteCity: "PLACENAME", parcelId: "PARCELID", value: "CNTASSDVALUE" }, attribution: "Wisconsin State Cartographer's Office / V12 Wisconsin Statewide Parcels" },
    "Wyoming": { mode: "single", service: "https://gis2.statelands.wyo.gov/arcgis/rest/services/basesde/Parcels2024/MapServer", layerId: 0, fieldMap: { owner: "ownername1", acres: ["landgrossa"], siteAddress: "locationad", siteCity: null, parcelId: "parcelnb", value: "actualvalu" }, attribution: "Wyoming Office of State Lands and Investments (statelands.wyo.gov)" },
  };

  // Esri World Imagery is natively tiled to z19 almost everywhere. Declaring a higher
  // source maxzoom lets MapLibre overzoom (upscale) the sharpest available tile instead of
  // requesting nonexistent z20+ tiles that return blank "data not yet available" imagery —
  // this raises perceived resolution and removes the hard zoom ceiling.
  const IMAGERY_SOURCE_MAXZOOM = 19;

  function rasterStyle(withPlaces, vintageId, seasonId) {
    // Real road lines, street names, and route-number shields are layered on top of the
    // satellite imagery on BOTH the standard satellite basemap and Hybrid — so road data
    // is visible by default, not hidden behind a separate mode.
    const sources = {
      'escout-sat': {
        type: 'raster',
        tiles: [satTilesFor(vintageId || 'live', seasonId)],
        tileSize: 256,
        maxzoom: IMAGERY_SOURCE_MAXZOOM,
        // Leaf-Off blends in the real MARIS statewide Mississippi mosaic (see
        // escout-leafoff protocol), so credit that source alongside Esri for any tile that
        // may have come from it.
        attribution: seasonId === 'leafoff' ? `${ESRI_ATTR} · ${MARIS_LEAFOFF_ATTR}` : ESRI_ATTR,
      },
      'escout-roads': {
        type: 'raster',
        tiles: [ESRI_ROADS_TILES],
        tileSize: 256,
        maxzoom: ROADS_SOURCE_MAXZOOM,
        attribution: ESRI_ATTR,
      },
    };
    const layers = [
      { id: 'escout-sat-layer', type: 'raster', source: 'escout-sat', paint: { 'raster-resampling': 'linear' } },
      { id: 'escout-roads-layer', type: 'raster', source: 'escout-roads', paint: { 'raster-resampling': 'linear' } },
    ];
    // Hybrid additionally layers county/city place labels above the road data.
    if (withPlaces) {
      sources['escout-places'] = { type: 'raster', tiles: [ESRI_PLACES_TILES], tileSize: 256, maxzoom: IMAGERY_SOURCE_MAXZOOM };
      layers.push({ id: 'escout-places-layer', type: 'raster', source: 'escout-places', paint: { 'raster-resampling': 'linear' } });
    }
    return { version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sources, layers };
  }

  function topoRasterStyle() {
    return {
      version: 8,
      glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
      sources: {
        'escout-topo-base': { type: 'raster', tiles: [USGS_TOPO_TILES], tileSize: 256, maxzoom: 16, attribution: USGS_TOPO_ATTR },
      },
      layers: [{ id: 'escout-topo-base-layer', type: 'raster', source: 'escout-topo-base', paint: { 'raster-resampling': 'linear' } }],
    };
  }

  let currentImageryVintage = 'live';
  function styleFor(basemapKey) {
    if (basemapKey === 'satellite') return rasterStyle(false, currentImageryVintage, currentImagerySeason);
    if (basemapKey === 'hybrid') return rasterStyle(true, currentImageryVintage, currentImagerySeason);
    return STYLES[basemapKey];
  }
  const STYLES = {
    satellite: rasterStyle(false, 'live', 'leafon'),
    hybrid: rasterStyle(true, 'live', 'leafon'),
    topo: topoRasterStyle(),
  };

  // Layer toggle state — single source of truth shared between the map layers and the Intel panel switches
  const layerState = {
    property: true,
    public: false,
    contours: false,
    slope: false,
    landcover: false,
    water: false,
    wind: true,
    cams: false,
    sightings: false,
  };

  /* ---------------- Subscription (client-side demo — no payment processor) ---------------- */
  // Approximate state bounding boxes, used to tell which state the map is currently viewing so
  // the right per-state cadastral/property-line web service can be queried in
  // fetchParcelDetails(). Source: US Census
  // TIGER-derived bounding boxes (https://gist.github.com/Duder-onomy/2bdc789c3711d2e8364cbdb219db8bf8);
  // Alaska, Hawaii, Wisconsin, Wyoming and DC corrected against documented extents.
  const STATE_BOUNDS = {
    'Alabama': [[-88.4731, 30.1375], [-84.8882, 35.0080]],
    'Alaska': [[-179.1505, 51.2097], [-129.9795, 71.4410]],
    'Arizona': [[-114.8184, 31.3322], [-109.0452, 37.0043]],
    'Arkansas': [[-94.6178, 33.0041], [-89.6422, 36.4996]],
    'California': [[-124.4820, 32.5295], [-114.1308, 42.0095]],
    'Colorado': [[-109.0603, 36.9924], [-102.0416, 41.0024]],
    'Connecticut': [[-73.7278, 40.9667], [-71.7870, 42.0506]],
    'Delaware': [[-75.7890, 38.4511], [-74.9846, 39.8394]],
    'District of Columbia': [[-77.1198, 38.7916], [-76.9094, 38.9958]],
    'Florida': [[-87.6349, 24.3963], [-79.9743, 31.0010]],
    'Georgia': [[-85.6052, 30.3558], [-80.7514, 35.0008]],
    'Hawaii': [[-160.2471, 18.9105], [-154.8066, 22.2356]],
    'Idaho': [[-117.2430, 41.9881], [-111.0436, 49.0008]],
    'Illinois': [[-91.5131, 36.9701], [-87.0199, 42.5083]],
    'Indiana': [[-88.0997, 37.7717], [-84.7846, 41.7614]],
    'Iowa': [[-96.6397, 40.3756], [-90.1401, 43.5011]],
    'Kansas': [[-102.0518, 36.9931], [-94.5882, 40.0031]],
    'Kentucky': [[-89.5715, 36.4967], [-81.9645, 39.1475]],
    'Louisiana': [[-94.0432, 28.9210], [-88.8170, 33.0195]],
    'Maine': [[-71.0842, 42.9561], [-66.9251, 47.4598]],
    'Maryland': [[-79.4872, 37.8856], [-75.0396, 39.7229]],
    'Massachusetts': [[-73.5081, 41.1863], [-69.8615, 42.8867]],
    'Michigan': [[-90.4186, 41.6961], [-82.1228, 48.3061]],
    'Minnesota': [[-97.2393, 43.4994], [-89.4834, 49.3845]],
    'Mississippi': [[-91.6550, 30.1478], [-88.0980, 34.9961]],
    'Missouri': [[-95.7741, 35.9957], [-89.0988, 40.6136]],
    'Montana': [[-116.0500, 44.3582], [-104.0396, 49.0011]],
    'Nebraska': [[-104.0535, 40.0000], [-95.3081, 43.0017]],
    'Nevada': [[-120.0057, 35.0019], [-114.0396, 42.0022]],
    'New Hampshire': [[-72.5571, 42.6970], [-70.5341, 45.3058]],
    'New Jersey': [[-75.5634, 38.7888], [-73.8851, 41.3574]],
    'New Mexico': [[-109.0502, 31.3323], [-103.0009, 37.0001]],
    'New York': [[-79.7625, 40.4774], [-71.8527, 45.0159]],
    'North Carolina': [[-84.3219, 33.7529], [-75.4001, 36.5880]],
    'North Dakota': [[-104.0493, 45.9350], [-96.5544, 49.0005]],
    'Ohio': [[-84.8203, 38.4032], [-80.5190, 42.3232]],
    'Oklahoma': [[-103.0026, 33.6192], [-94.4312, 37.0021]],
    'Oregon': [[-124.7035, 41.9918], [-116.4635, 46.2991]],
    'Pennsylvania': [[-80.5211, 39.7198], [-74.6895, 42.5147]],
    'Rhode Island': [[-71.9070, 41.0555], [-71.1205, 42.0189]],
    'South Carolina': [[-83.3540, 32.0333], [-78.4993, 35.2155]],
    'South Dakota': [[-104.0577, 42.4799], [-96.4363, 45.9455]],
    'Tennessee': [[-90.3103, 34.9830], [-81.6469, 36.6781]],
    'Texas': [[-106.6457, 25.8371], [-93.5078, 36.5007]],
    'Utah': [[-114.0539, 36.9980], [-109.0411, 42.0014]],
    'Vermont': [[-73.4377, 42.7269], [-71.4654, 45.0167]],
    'Virginia': [[-83.6754, 36.5408], [-75.2312, 39.4660]],
    'Washington': [[-124.8361, 45.5437], [-116.9174, 49.0024]],
    'West Virginia': [[-82.6447, 37.2015], [-77.7190, 40.6388]],
    'Wisconsin': [[-92.8892, 42.4919], [-86.2495, 47.3025]],
    'Wyoming': [[-111.0569, 40.9948], [-104.0522, 45.0059]],
  };
  const STATE_LIST = Object.keys(STATE_BOUNDS).sort();

  // Precise state detection. The STATE_BOUNDS rectangles above are a fallback ONLY — bounding
  // boxes for neighboring states overlap heavily (e.g. Louisiana's box covers most of southern
  // Mississippi, including Jackson; Arkansas's box covers the Delta; Alabama's box covers the
  // eastern border counties), and since stateAt() used to return the first alphabetical match,
  // real Mississippi parcel clicks in Jackson, Hattiesburg, Gulfport, Natchez, the Delta, and
  // the eastern border counties were silently misidentified as a neighboring state. That routed
  // them to the generic "no live data for this state" estimate instead of a real MARIS lookup —
  // i.e. "parcel information not registering" for a large share of the state. Fixed by testing
  // the point against the actual state boundary polygons (the same GeoJSON already bundled for
  // the state-line map overlay) instead of rectangles.
  let statePolygons = null; // [{ name, bbox, polygons: [ [ring, ring...], ... ] }], filled in once the boundary file loads
  // Named distinctly from the pre-existing pointInRing([px,py], ring) below (used for selected-
  // parcel scoping) since that one takes a [lng,lat] pair, not (lng, lat) — a same-named second
  // top-level function declaration here would silently win and break both call sites.
  function pointInRingLngLat(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function pointInPolygonRings(lng, lat, rings) {
    // rings[0] is the exterior boundary; any further rings are holes to subtract from it.
    if (!rings.length || !pointInRingLngLat(lng, lat, rings[0])) return false;
    for (let i = 1; i < rings.length; i++) {
      if (pointInRingLngLat(lng, lat, rings[i])) return false;
    }
    return true;
  }
  function bboxOfPolygons(polygons) {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    polygons.forEach((rings) => rings.forEach((ring) => ring.forEach((pt) => {
      if (pt[0] < minLng) minLng = pt[0];
      if (pt[0] > maxLng) maxLng = pt[0];
      if (pt[1] < minLat) minLat = pt[1];
      if (pt[1] > maxLat) maxLat = pt[1];
    })));
    return [[minLng, minLat], [maxLng, maxLat]];
  }
  fetch(STATE_BOUNDARIES_URL)
    .then((res) => res.json())
    .then((geojson) => {
      statePolygons = geojson.features.map((f) => {
        // Normalize both Polygon and MultiPolygon geometries into an array of polygons,
        // each itself an array of rings, so downstream code handles both the same way.
        const polygons = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
        return { name: f.properties.name, polygons, bbox: bboxOfPolygons(polygons) };
      });
    })
    .catch(() => {
      /* statePolygons stays null — stateAt() below falls back to the coarse bounding-box method */
    });

  function stateAt(lng, lat) {
    if (statePolygons) {
      for (const st of statePolygons) {
        const b = st.bbox;
        if (lng < b[0][0] || lng > b[1][0] || lat < b[0][1] || lat > b[1][1]) continue; // cheap pre-filter
        if (st.polygons.some((rings) => pointInPolygonRings(lng, lat, rings))) return st.name;
      }
      return null;
    }
    // Fallback for the brief window before the precise boundary polygons finish loading (or if
    // the fetch fails, e.g. offline) — coarse and known to misclassify border areas, but only
    // used transiently since the fetch above kicks off immediately at script load.
    for (const name of STATE_LIST) {
      const b = STATE_BOUNDS[name];
      if (lng >= b[0][0] && lng <= b[1][0] && lat >= b[0][1] && lat <= b[1][1]) return name;
    }
    return null;
  }

  // Subscription state syncs with the real backend (Stripe Checkout + Billing Portal),
  // keyed server-side by the X-Visitor-Id header below. On the sandboxed preview iframe
  // (opaque origin) localStorage is blocked, so we fall back to an in-memory id there —
  // but on the real published origin this id is generated once and persisted durably so
  // the same visitor keeps their subscription/waypoints across reloads and future visits.
  function getOrCreateVisitorId() {
    const KEY = 'escout_visitor_id';
    try {
      let id = localStorage.getItem(KEY);
      if (!id) {
        id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        localStorage.setItem(KEY, id);
      }
      return id;
    } catch (e) {
      // localStorage unavailable (e.g. opaque-origin sandboxed preview) — fall back to a
      // long-lived cookie, then finally an in-memory id that survives only this page load.
      try {
        const match = document.cookie.match(/(?:^|; )escout_visitor_id=([^;]+)/);
        if (match) return decodeURIComponent(match[1]);
        const id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        document.cookie = `escout_visitor_id=${encodeURIComponent(id)}; max-age=${60 * 60 * 24 * 365 * 5}; path=/; SameSite=Lax`;
        return id;
      } catch (e2) {
        if (!window.__escoutVisitorIdMemo) window.__escoutVisitorIdMemo = `mem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return window.__escoutVisitorIdMemo;
      }
    }
  }
  const VISITOR_ID = getOrCreateVisitorId();
  const API = '__PORT_8000__'.startsWith('__') ? 'http://localhost:8000' : '__PORT_8000__';
  let subscription = { tier: 'free', state: null };
  let subscriptionLoaded = false;
  async function apiFetch(path, options) {
    const opts = { ...(options || {}) };
    // Identity travels as a `vid` URL query parameter, not a header or cookie. The hosting
    // proxy in front of the published site was confirmed (via live diagnostics) to silently
    // overwrite any custom request header (X-Visitor-Id) AND to strip any Set-Cookie the
    // backend tries to issue -- both are why premium/comp status kept reverting to Free.
    // A query parameter is part of the request URL itself, which the proxy must preserve
    // to route the request at all, so it survives untouched. The header is kept only as a
    // harmless legacy fallback for any environment without the proxy in front of it.
    opts.headers = { ...(opts.headers || {}), 'X-Visitor-Id': VISITOR_ID };
    opts.credentials = 'include';
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${API}${path}${sep}vid=${encodeURIComponent(VISITOR_ID)}`, opts);
    if (!res.ok) {
      let msg = 'Request failed';
      try { msg = (await res.json()).detail || msg; } catch (e) { /* ignore */ }
      throw new Error(msg);
    }
    return res.json();
  }
  async function loadSubscription() {
    try {
      const data = await apiFetch('/api/subscription');
      subscription = {
        tier: data.tier || 'free',
        state: data.state || null,
        source: data.source || null,
        expiresAt: data.expiresAt || null,
      };
    } catch (e) {
      subscription = { tier: 'free', state: null };
    }
    subscriptionLoaded = true;
    refreshGatingUI();
  }
  async function startCheckout(plan) {
    const origin = window.location.href.split('?')[0];
    const data = await apiFetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan, origin }),
    });
    // Opened in a new tab — the preview runs in a sandboxed iframe that can't top-navigate
    // to an external domain like Stripe Checkout.
    window.open(data.url, '_blank');
  }
  async function openBillingPortal() {
    const origin = window.location.href.split('?')[0];
    const data = await apiFetch('/api/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin }),
    });
    window.open(data.url, '_blank');
  }
  async function confirmCheckoutReturn() {
    const params = new URLSearchParams(window.location.search);
    const checkoutState = params.get('checkout');
    if (!checkoutState) return;
    const sessionId = params.get('session_id');
    // Strip the checkout params from the URL immediately so a reload doesn't re-trigger this.
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
    if (checkoutState === 'cancelled') {
      toast('Checkout cancelled — no charge was made');
      return;
    }
    if (checkoutState === 'success' && sessionId) {
      try {
        const data = await apiFetch(`/api/checkout/confirm?session_id=${encodeURIComponent(sessionId)}`);
        if (data.confirmed) {
          subscription = { tier: data.tier, state: null };
          refreshGatingUI();
          toast('Premium plan active — Scout AI, property lines & topo layers unlocked');
        } else {
          toast('Payment is still processing — check back in a moment');
        }
      } catch (e) {
        toast('Could not confirm checkout — try Manage Billing to check your status');
      }
    }
  }

  // Redeems a complimentary code against whichever storage context is currently running —
  // shared by the ?redeem=CODE URL flow and the manual "Have a code?" field in the pricing
  // modal. The manual field matters because iOS gives a home-screen-installed app entirely
  // separate storage from Safari: a link opened in Safari can never activate an app icon
  // that's already on the home screen, so redeeming must be possible from inside that icon.
  async function redeemCode(code) {
    if (!code) return false;
    try {
      const data = await apiFetch('/api/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      subscription = { tier: data.tier, state: null, source: 'comp', expiresAt: data.expiresAt };
      refreshGatingUI();
      const until = data.expiresAt ? new Date(data.expiresAt * 1000).toLocaleDateString() : null;
      toast(
        until
          ? `Complimentary Premium activated — active through ${until}`
          : 'Complimentary Premium activated'
      );
      return true;
    } catch (e) {
      toast(e.message || 'This code is invalid or has already been used');
      return false;
    }
  }

  async function confirmRedeemReturn() {
    // A complimentary-access link the owner sends looks like ?redeem=CODE. Opening it once
    // activates premium for exactly this visitor — see /api/redeem in api_server.py.
    const params = new URLSearchParams(window.location.search);
    const code = params.get('redeem');
    if (!code) return;
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
    await redeemCode(code);
  }

  // ---- Last-viewed map position: persisted server-side per visitor (same X-Visitor-Id
  // pattern as subscriptions) so the sandboxed preview iframe's blocked localStorage isn't
  // a problem, and the position follows the visitor across devices/reloads either way. ----
  let hasSavedView = false;
  let viewSaveTimer = null;
  function scheduleSaveViewState() {
    if (viewSaveTimer) clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(() => {
      const c = map.getCenter();
      apiFetch('/api/view-state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lng: c.lng, lat: c.lat, zoom: map.getZoom() }),
      }).catch(() => {}); // best-effort — a missed save just means the next moveend retries
    }, 700);
  }
  async function loadAndApplySavedView() {
    try {
      const data = await apiFetch('/api/view-state');
      if (data && typeof data.lng === 'number' && typeof data.lat === 'number') {
        hasSavedView = true;
        map.jumpTo({ center: [data.lng, data.lat], zoom: typeof data.zoom === 'number' ? data.zoom : 15.6 });
      }
    } catch (e) {
      // No saved view yet (or request failed) — keep the default CENTER.
    }
  }

  // ---- Saved waypoints: loaded once on startup and merged onto the map/journal. ----
  function addSavedWaypointToMap(wp) {
    return addUserWaypoint(
      wp.type,
      { lng: wp.lng, lat: wp.lat },
      { label: wp.label, note: wp.note, confidence: wp.confidence },
      { id: wp.id, skipSave: true }
    );
  }
  async function loadSavedWaypoints() {
    try {
      const data = await apiFetch('/api/waypoints');
      (data.waypoints || []).forEach((wp) => addSavedWaypointToMap(wp));
      if (activeTab === 'journal') renderJournal();
    } catch (e) {
      // Pins just won't load this session — dropping new ones still works and will
      // sync normally.
    }
  }

  async function confirmSharedWaypointsReturn() {
    // A pin-sharing link looks like ?wp=CODE (see the Share button in the Hunt Journal).
    // Opening it once copies those pins into this visitor's own waypoints.
    const params = new URLSearchParams(window.location.search);
    const code = params.get('wp');
    if (!code) return;
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, '', cleanUrl);
    try {
      const data = await apiFetch(`/api/waypoints/share/${encodeURIComponent(code)}/import`, { method: 'POST' });
      const created = data.waypoints || [];
      created.forEach((wp) => addSavedWaypointToMap(wp));
      if (activeTab === 'journal') renderJournal();
      if (created.length) {
        toast(`Added ${created.length} shared pin${created.length === 1 ? '' : 's'} to your map`);
        map.flyTo({ center: [created[0].lng, created[0].lat], zoom: 15.4, duration: 900 });
      } else {
        toast('This shared link has no pins to add');
      }
    } catch (e) {
      toast(e.message || 'This share link is invalid or has expired');
    }
  }

  // ---- Sharing dropped pins with other visitors ----
  function waypointShareLink(code) {
    return window.location.origin + window.location.pathname + '?wp=' + encodeURIComponent(code);
  }
  function openShareModal(link, count) {
    const modal = document.getElementById('shareModal');
    const input = document.getElementById('shareLinkInput');
    const countEl = document.getElementById('shareModalCount');
    if (!modal || !input) return;
    input.value = link;
    if (countEl) countEl.textContent = count === 1 ? 'Sharing 1 pin' : `Sharing ${count} pins`;
    modal.classList.add('open');
  }
  async function copyShareLink(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Link copied');
    } catch (e) {
      toast('Could not copy — select and copy manually');
    }
  }
  async function shareWaypoints(ids) {
    try {
      const data = await apiFetch('/api/waypoints/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ids && ids.length ? { ids } : {}),
      });
      openShareModal(waypointShareLink(data.code), data.count);
    } catch (e) {
      toast(e.message || "Couldn't create a share link — try again");
    }
  }

  function currentMapState() {
    const c = map.getCenter();
    return stateAt(c.lng, c.lat);
  }
  // Single Premium plan gates every paid feature nationwide — property/ownership lookups,
  // Scout AI, and the topo basemap + contour overlay. Free unlocks everything else
  // (satellite/hybrid basemaps, habitat/wind layers, unlimited waypoints, trail cams, journal).
  function hasPremiumAccess() {
    return subscription.tier === 'premium';
  }
  function hasPropertyAccess() {
    return hasPremiumAccess();
  }
  function hasScoutAccess() {
    return hasPremiumAccess();
  }
  function hasTopoAccess() {
    return hasPremiumAccess();
  }
  const pricingModal = document.getElementById('pricingModal');
  function openPricingModal() {
    pricingModal.classList.add('open');
  }
  function closePricingModal() {
    pricingModal.classList.remove('open');
  }
  function updatePlanChip() {
    const btn = document.getElementById('planChipBtn');
    const label = document.getElementById('planChipLabel');
    if (!btn || !label) return;
    btn.classList.toggle('is-free', subscription.tier === 'free');
    btn.classList.toggle('is-paid', subscription.tier !== 'free');
    if (subscription.tier === 'free') label.textContent = 'Free Plan';
    else if (subscription.source === 'comp') label.textContent = 'Premium · Complimentary';
    else label.textContent = 'Premium';
  }

  // High-contrast gold used for the Lines & Area measure tool — distinct from waypoint
  // colors and the amber Scout AI scan sweep, and legible over dark forest canopy.
  const MEASURE_COLOR = '#f2c94c';

  /* ---------------- Waypoint icon catalog (onX-style categories) ---------------- */
  const WAYPOINT_TYPES = [
    { id: 'stand', label: 'Tree Stand', color: '#b98552', glyph: '<path d="M13 25V10M21 25V10M13 14h8M13 18h8M13 22h8"/>' },
    { id: 'blind', label: 'Ground Blind', color: '#8a7a53', glyph: '<path d="M9 24l8-14 8 14z"/><path d="M9 24h16"/>' },
    { id: 'bedding', label: 'Bedding Area', color: '#8fb381', glyph: '<path d="M10 22c0-5 3-9 7-9s7 4 7 9M10 22h14"/>' },
    { id: 'feeding', label: 'Feeding Area', color: '#c9b34a', glyph: '<path d="M11 23c8 1 12-5 12-13-8 0-13 4-13 11 0 .7.3 1.6 1 2z"/><path d="M11 23l7-9"/>' },
    { id: 'water', label: 'Water Source', color: '#7c9aa8', glyph: '<path d="M17 9s7 8 7 13a7 7 0 11-14 0c0-5 7-13 7-13z"/>' },
    { id: 'camera', label: 'Trail Camera', color: '#cfa94e', glyph: '<path d="M9 13h11l3-2v10l-3-2H9z"/>' },
    { id: 'rub', label: 'Rub / Scrape', color: '#c17361', glyph: '<path d="M17 9v16"/><path d="M12 13l10-3"/><path d="M12 19l10-3"/>' },
    { id: 'blood', label: 'Blood Trail', color: '#a3493b', glyph: '<circle cx="13" cy="13" r="2" fill="currentColor" stroke="none"/><circle cx="19" cy="18" r="2.6" fill="currentColor" stroke="none"/><circle cx="15" cy="24" r="1.6" fill="currentColor" stroke="none"/>' },
    { id: 'kill', label: 'Kill Site', color: '#8a3f3f', glyph: '<circle cx="17" cy="17" r="7"/><circle cx="17" cy="17" r="3"/><path d="M17 8v3M17 23v3M8 17h3M23 17h3"/>' },
    { id: 'corridor', label: 'Travel Corridor', color: '#6f93a8', glyph: '<path d="M10 24l7-11 7 11"/>' },
    { id: 'parking', label: 'Parking', color: '#8a93a6', glyph: '<rect x="11" y="11" width="12" height="16" rx="3"/><text x="17" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" stroke="none">P</text>' },
    { id: 'gate', label: 'Gate / Access', color: '#9c8f6b', glyph: '<path d="M9 24V12M25 24V12M9 14h16M9 20h16"/>' },
    { id: 'camp', label: 'Camp', color: '#a06b45', glyph: '<path d="M17 10c3 4 5 6 5 9a5 5 0 01-10 0c0-1.5.6-2.8 1.5-4 .3 1 1 1.6 1.7 1.2-.4-2 .5-4 1.8-6.2z"/>' },
    { id: 'danger', label: 'Danger / Hazard', color: '#c1614f', glyph: '<path d="M17 9l9 16H8z"/><path d="M17 15v4M17 22h.01"/>' },
    { id: 'glassing', label: 'Glassing Point', color: '#7c93a0', glyph: '<circle cx="13" cy="20" r="4"/><circle cx="21" cy="20" r="4"/><path d="M13 16V12h8v4"/>' },
    { id: 'pin', label: 'General Pin', color: '#a89c85', glyph: '<path d="M17 26s7-7 7-13a7 7 0 10-14 0c0 6 7 13 7 13z"/><circle cx="17" cy="13" r="2.5" fill="currentColor" stroke="none"/>' },
  ];
  function wpDef(id) {
    return WAYPOINT_TYPES.find((w) => w.id === id) || WAYPOINT_TYPES[WAYPOINT_TYPES.length - 1];
  }
  function waypointGlyphSvg(def) {
    return `<svg viewBox="0 0 34 34"><circle cx="17" cy="17" r="16" fill="#1d1911" stroke="${def.color}" stroke-width="2"/><g fill="none" stroke="${def.color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" color="${def.color}">${def.glyph}</g></svg>`;
  }

  let currentBasemap = 'satellite';
  let currentImagerySeason = 'leafon';
  root.dataset.basemap = currentBasemap;
  root.dataset.season = currentImagerySeason;

  // The USGS 3DEP ImageServer that renders contour lines is a dynamic, non-cached render
  // service — it can take several seconds to respond on a cold request and occasionally
  // drops individual tile requests under load, which otherwise makes contour lines look
  // like they're randomly "missing" as the map pans. Retry transient failures a couple of
  // times with a short backoff before giving up, so a slow/flaky response doesn't
  // permanently blank that tile until the next pan/zoom happens to re-request it.
  async function fetchWithRetry(url, attempts = 3, delayMs = 400) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        const resp = await fetch(url);
        if (resp.ok) return resp;
        lastErr = new Error(`fetch failed (${resp.status})`);
      } catch (e) {
        lastErr = e;
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
    throw lastErr;
  }

  // Recolors any raster tile's opaque pixels to a solid target color while preserving the
  // original alpha shape — used to turn the USGS contour service's near-black lines into a
  // bright, clearly-visible color. URL shape: escout-recolor://<hexColorNoHash>/<real-url>
  maplibregl.addProtocol('escout-recolor', async (params) => {
    const rest = params.url.slice('escout-recolor://'.length);
    const splitAt = rest.indexOf('/');
    const color = '#' + rest.slice(0, splitAt);
    const realUrl = rest.slice(splitAt + 1);
    const resp = await fetchWithRetry(realUrl);
    if (!resp.ok) throw new Error(`escout-recolor: tile fetch failed (${resp.status})`);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return { data: await outBlob.arrayBuffer() };
  });
  // Applies a contrast/saturation/clarity boost plus a real unsharp-mask edge-enhancement
  // pass to satellite imagery tiles on arrival, for a visibly crisper, better-defined look
  // beyond what a flat CSS filter alone can achieve. URL shape: escout-sharpen://<real-url>
  maplibregl.addProtocol('escout-sharpen', async (params) => {
    const realUrl = params.url.slice('escout-sharpen://'.length);
    const resp = await fetchWithRetry(realUrl);
    if (!resp.ok) throw new Error(`escout-sharpen: tile fetch failed (${resp.status})`);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const w = bitmap.width, h = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.filter = 'contrast(122%) saturate(130%) brightness(103%)';
    ctx.drawImage(bitmap, 0, 0);
    try {
      // Unsharp mask: subtract a slightly blurred copy back out of the base image to
      // amplify edge contrast, giving genuinely crisper detail rather than just a flatter
      // contrast/saturation bump (the source tiles can't get literally higher-resolution).
      // A slightly wider blur radius + stronger amount than a first pass specifically helps
      // counteract the softening from MapLibre's GPU overzoom (upscaling z19 tiles past the
      // native z19 source maxzoom to fill zoom levels 20-21) without introducing halo
      // artifacts on the still-native-resolution zoom levels.
      const base = ctx.getImageData(0, 0, w, h);
      const blurCanvas = document.createElement('canvas');
      blurCanvas.width = w;
      blurCanvas.height = h;
      const bctx = blurCanvas.getContext('2d');
      bctx.filter = 'blur(1.3px)';
      bctx.drawImage(canvas, 0, 0);
      const blurred = bctx.getImageData(0, 0, w, h);
      const amount = 0.75;
      const out = ctx.createImageData(w, h);
      for (let i = 0; i < base.data.length; i += 4) {
        out.data[i] = Math.max(0, Math.min(255, base.data[i] + amount * (base.data[i] - blurred.data[i])));
        out.data[i + 1] = Math.max(0, Math.min(255, base.data[i + 1] + amount * (base.data[i + 1] - blurred.data[i + 1])));
        out.data[i + 2] = Math.max(0, Math.min(255, base.data[i + 2] + amount * (base.data[i + 2] - blurred.data[i + 2])));
        out.data[i + 3] = base.data[i + 3];
      }
      ctx.putImageData(out, 0, 0);
    } catch (e) {
      // getImageData can throw on a tainted canvas in some environments — fall back to
      // the plain contrast/saturation/brightness filter pass already drawn above.
    }
    const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    return { data: await outBlob.arrayBuffer() };
  });
  // Esri's World Transportation service renders rural/unclassified county roads in a pale,
  // low-contrast tan that reads fine against a white background but all but disappears
  // over dirt, sand, dry grass, or shadowed tree cover in satellite imagery (confirmed by
  // direct pixel sampling — the line color sits at roughly equal, high, muted RGB values,
  // i.e. low saturation, so it blends into any similarly light-toned terrain). Rather than
  // trying to selectively recolor just that one road class — fragile, since exact colors
  // shift with zoom and would risk mis-tinting highway shields/labels — trace a soft dark
  // halo behind every opaque pixel (via canvas shadow, the same silhouette-blur technique
  // real printed maps use for line casings) and then punch up contrast/saturation on top.
  // The halo alone guarantees every road, at every color, reads against both dark and light
  // backgrounds; the contrast/saturation pass makes the already-bold highway colors pop
  // too. URL shape: escout-roadboost://<real-url>
  maplibregl.addProtocol('escout-roadboost', async (params) => {
    const realUrl = params.url.slice('escout-roadboost://'.length);
    const resp = await fetchWithRetry(realUrl);
    if (!resp.ok) throw new Error(`escout-roadboost: tile fetch failed (${resp.status})`);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const w = bitmap.width, h = bitmap.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = 2.5;
    // Drawn twice at the same position: the visible pixels are identical (fully covered by
    // the crisp, unshadowed pass below), but the shadow itself compounds into a thicker,
    // more solid dark halo peeking out past every line and label's edge.
    ctx.drawImage(bitmap, 0, 0);
    ctx.drawImage(bitmap, 0, 0);
    ctx.restore();
    ctx.filter = 'contrast(135%) saturate(160%) brightness(108%)';
    ctx.drawImage(bitmap, 0, 0);
    ctx.filter = 'none';
    const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return { data: await outBlob.arrayBuffer() };
  });

  // MARIS/MDEQ statewide leaf-off aerial mosaic — real winter (Jan-Mar leaf-off flight
  // season) county orthophotography covering all 82 Mississippi counties, flown 2016-2024
  // at 6-12in resolution. Confirmed by direct testing: unlike Esri/NAIP (NAIP is leaf-on by
  // federal mandate; Esri Wayback doesn't reliably re-capture rural tiles in winter), this
  // service's pixels are genuinely bare-tree/dormant-canopy photography, not a color filter.
  const MARIS_LEAFOFF_EXPORT = 'https://gis.mississippi.edu/server/rest/services/Raster/Local_High_Res_2025/MapServer/export';
  const MARIS_LEAFOFF_ATTR = 'MARIS / MDEQ Local High Resolution Imagery (real leaf-off, MS only)';
  // No free nationwide leaf-off imagery source exists (verified: NAIP is leaf-on by design;
  // true leaf-off coverage is a patchwork of individual state programs), so outside
  // Mississippi the escout-leafoff protocol below still falls back to the real December
  // Wayback tile with this grade on top, same rationale as the WAYBACK_WINTER_RELEASE_ID
  // comment above. Kept theme-independent (previously two separate dark/light values lived
  // in style.css's now-removed [data-season='leafoff'] canvas filter) because grading now
  // happens per-tile inside this protocol — a DOM-level CSS filter can no longer selectively
  // spare the real MARIS pixels while still grading the fallback pixels within the same
  // canvas, so the split has to happen at the tile level instead.
  const LEAFOFF_FALLBACK_GRADE = 'grayscale(0.62) contrast(1.13) brightness(1.14) saturate(0.62) hue-rotate(80deg)';

  function webMercatorToLonLat(mx, my) {
    const R = 6378137.0;
    const lon = (mx / R) * (180 / Math.PI);
    const lat = (Math.PI / 2 - 2 * Math.atan(Math.exp(-my / R))) * (180 / Math.PI);
    return [lon, lat];
  }
  // Precise point-in-Mississippi test, reusing the same bundled state boundary polygons (and
  // pointInPolygonRings helper) that stateAt() uses elsewhere for parcel/subscription routing
  // — falls back to the coarse STATE_BOUNDS rectangle only in the brief window before the
  // polygon file finishes loading.
  function isMississippiPoint(lng, lat) {
    if (statePolygons) {
      const ms = statePolygons.find((s) => s.name === 'Mississippi');
      if (ms) {
        const b = ms.bbox;
        if (lng < b[0][0] || lng > b[1][0] || lat < b[0][1] || lat > b[1][1]) return false;
        return ms.polygons.some((rings) => pointInPolygonRings(lng, lat, rings));
      }
    }
    const b = STATE_BOUNDS['Mississippi'];
    return lng >= b[0][0] && lng <= b[1][0] && lat >= b[0][1] && lat <= b[1][1];
  }

  // Serves real leaf-off imagery for Mississippi (MARIS statewide mosaic) and a graded real-
  // December-tile fallback everywhere else, deciding per-tile so a single raster source can
  // span both. URL shape: escout-leafoff://{z}/{x}/{y}/{bbox-epsg-3857} — MapLibre substitutes
  // all four placeholders (including the bbox one, the same mechanism already used for the
  // 3DEP contour / PAD-US / NLCD dynamic-export overlays elsewhere in this file) before this
  // handler ever runs, so no tile-math needs to be reimplemented here.
  maplibregl.addProtocol('escout-leafoff', async (params) => {
    const m = params.url.match(/^escout-leafoff:\/\/(\d+)\/(-?\d+)\/(-?\d+)\/(-?[0-9.eE+-]+),(-?[0-9.eE+-]+),(-?[0-9.eE+-]+),(-?[0-9.eE+-]+)$/);
    if (!m) throw new Error(`escout-leafoff: bad url ${params.url}`);
    const z = +m[1], x = +m[2], y = +m[3];
    const minX = +m[4], minY = +m[5], maxX = +m[6], maxY = +m[7];

    async function fallbackBitmap() {
      const rawUrl = WAYBACK_TILE_TEMPLATE.replace('{releaseId}', WAYBACK_WINTER_RELEASE_ID).replace('{z}', z).replace('{y}', y).replace('{x}', x);
      const resp = await fetchWithRetry(rawUrl);
      if (!resp.ok) throw new Error(`escout-leafoff fallback: tile fetch failed (${resp.status})`);
      return createImageBitmap(await resp.blob());
    }
    function gradedFallbackCanvas(bitmap) {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.filter = LEAFOFF_FALLBACK_GRADE;
      ctx.drawImage(bitmap, 0, 0);
      ctx.filter = 'none';
      return canvas;
    }

    const corners = [
      webMercatorToLonLat(minX, maxY),
      webMercatorToLonLat(maxX, maxY),
      webMercatorToLonLat(minX, minY),
      webMercatorToLonLat(maxX, minY),
    ];
    const flags = corners.map(([lng, lat]) => isMississippiPoint(lng, lat));
    const anyIn = flags.some(Boolean);
    const allIn = flags.every(Boolean);

    if (!anyIn) {
      // Nowhere near Mississippi — no real leaf-off source exists here, so use the graded
      // real-December-tile fallback exactly as before.
      const canvas = gradedFallbackCanvas(await fallbackBitmap());
      const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      return { data: await outBlob.arrayBuffer() };
    }

    let marisBitmap = null;
    try {
      const marisUrl = `${MARIS_LEAFOFF_EXPORT}?bbox=${minX},${minY},${maxX},${maxY}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`;
      const resp = await fetchWithRetry(marisUrl, 2, 300);
      if (resp.ok) marisBitmap = await createImageBitmap(await resp.blob());
    } catch (e) {
      // MARIS unreachable — fall through to the graded fallback below.
    }

    if (marisBitmap && allIn) {
      // Entirely inside Mississippi and the real mosaic responded — use it directly, no
      // fallback fetch needed (saves a second round-trip across the app's primary coverage
      // area, since Mississippi's 82 counties are fully covered by this mosaic).
      const canvas = document.createElement('canvas');
      canvas.width = marisBitmap.width;
      canvas.height = marisBitmap.height;
      canvas.getContext('2d').drawImage(marisBitmap, 0, 0);
      const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return { data: await outBlob.arrayBuffer() };
    }

    // Border tile straddling the state line (or MARIS didn't respond) — draw the graded
    // fallback first, then the real MARIS photo on top with its own alpha channel intact, so
    // a tile that's half in/half out of Mississippi blends the real photo and the fallback
    // seamlessly instead of showing a hard edge or a transparent hole.
    const canvas = gradedFallbackCanvas(await fallbackBitmap());
    if (marisBitmap) canvas.getContext('2d').drawImage(marisBitmap, 0, 0);
    const outBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return { data: await outBlob.arrayBuffer() };
  });

  const map = new maplibregl.Map({
    container: 'map',
    style: STYLES.satellite,
    center: CENTER,
    zoom: 15.6,
    // Esri World Imagery's native tiles top out at z19 (IMAGERY_SOURCE_MAXZOOM above), so
    // every zoom level past that is a GPU upscale of the sharpest available tile. One extra
    // level (z20) still reads as reasonably crisp once sharpened; two levels (z21) magnifies
    // a single 256px tile 4x and looks distractingly soft no matter how much the tile itself
    // is sharpened beforehand. Capping at 20 keeps "zoom all the way in" genuinely useful
    // instead of bottoming out in visible blur.
    maxZoom: 20,
    pitch: 0,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');
  // The default compass control is just a bare rotation arrow — inject real N/E/S/W
  // letter markings into its icon span so hunters can read true heading at a glance.
  // MapLibre rotates that exact span's `transform` to match map bearing internally, so
  // anything appended inside it (our letters + needle) rotates along with it for free —
  // the injected "N" always points to true geographic north, however the map is rotated.
  function enhanceCompassRose() {
    const btn = document.querySelector('.maplibregl-ctrl-compass');
    const icon = btn && btn.querySelector('.maplibregl-ctrl-icon');
    if (!icon || icon.dataset.roseInjected) return;
    icon.dataset.roseInjected = 'true';
    icon.insertAdjacentHTML(
      'beforeend',
      '<span class="compass-tick n" aria-hidden="true">N</span>' +
        '<span class="compass-tick e" aria-hidden="true">E</span>' +
        '<span class="compass-tick s" aria-hidden="true">S</span>' +
        '<span class="compass-tick w" aria-hidden="true">W</span>' +
        '<span class="compass-needle" aria-hidden="true"></span>'
    );
  }
  enhanceCompassRose();
  map.on('load', enhanceCompassRose);

  // Tile-loading indicator: surfaces a small "Loading imagery" pill whenever the
  // satellite/topo raster source is actively fetching tiles for the current view — panning
  // or zooming into an area with slow/uncached tiles otherwise just looks frozen or blurry
  // with no feedback that fresh imagery is on its way.
  (function setupTileLoadingIndicator() {
    const el = document.getElementById('tileLoading');
    if (!el) return;
    const WATCHED_SOURCES = new Set(['escout-sat', 'escout-roads', 'escout-places', 'escout-topo-base']);
    let hideTimer = null;
    function show() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      el.classList.add('visible');
    }
    function hideSoon() {
      if (hideTimer) clearTimeout(hideTimer);
      // Small delay avoids a flash-hide/flash-show flicker between consecutive tile batches.
      hideTimer = setTimeout(() => el.classList.remove('visible'), 220);
    }
    map.on('dataloading', (e) => {
      if (e && WATCHED_SOURCES.has(e.sourceId)) show();
    });
    map.on('idle', hideSoon);
    map.on('error', (e) => {
      if (e && e.sourceId && WATCHED_SOURCES.has(e.sourceId)) hideSoon();
    });
  })();
  // "Go to current location" — built-in geolocate control: on click, centers/zooms to the
  // device's GPS position and keeps a live pulsing dot on the map while tracking.
  const geolocateControl = new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserHeading: true,
    showAccuracyCircle: true,
    fitBoundsOptions: { maxZoom: 17 },
  });
  map.addControl(geolocateControl, 'bottom-right');
  geolocateControl.on('error', (err) => {
    const denied = err && err.code === 1;
    toast(denied ? 'Location access denied — enable it in your browser/device settings' : 'Could not get your current location', 3600);
  });
  // Auto-center on the user's location at launch, but only if location permission
  // has ALREADY been granted — never force a fresh permission prompt on open.
  // The Permissions API lets us check the current grant state without triggering
  // the browser's prompt; only a 'granted' state programmatically fires the same
  // GeolocateControl flow the location button uses, reusing its existing fly-to,
  // pulsing dot, and error-toast behavior for free.
  function autoLocateIfAlreadyPermitted() {
    if (hasSavedView) return; // the visitor has a real last-viewed spot — don't override it with a GPS jump
    if (!navigator.permissions || !navigator.permissions.query) return; // unsupported: leave default view, no prompt
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((status) => {
        if (status.state === 'granted') geolocateControl.trigger();
      })
      .catch(() => {}); // querying itself failing (older browsers) — silently skip, no prompt
  }
  // Resolve the saved-view fetch BEFORE deciding whether to auto-locate, so a returning
  // visitor's last position always wins over a fresh GPS fix.
  map.on('load', () => {
    loadAndApplySavedView().finally(autoLocateIfAlreadyPermitted);
  });
  loadSavedWaypoints();
  map.scrollZoom.setWheelZoomRate(1 / 380);

  function addBaseLayers() {
    try {
    // Real nationwide parcel/property boundary lines (public cadastral records via Regrid, free tile layer)
    if (!map.getSource('escout-parcels')) {
      map.addSource('escout-parcels', {
        type: 'raster',
        tiles: [PARCEL_TILES],
        tileSize: 256,
        minzoom: 15,
        maxzoom: 17,
        attribution: PARCEL_ATTR,
      });
      map.addLayer({
        id: 'escout-parcels-layer',
        type: 'raster',
        source: 'escout-parcels',
        paint: { 'raster-opacity': 0.95, 'raster-resampling': 'linear' },
      });
      syncPropertyLayerVisibility();
    }
    // Real elevation contour lines — dynamically rendered from actual USGS 3DEP lidar/DEM
    // data (10ft interval, index lines bolded) as a transparent-background PNG, so the
    // lines themselves are crisp and legible over any basemap instead of a whole faded-out
    // topo basemap image (roads/labels/shading included) stacked at low opacity.
    if (!map.getSource('escout-topo-overlay')) {
      map.addSource('escout-topo-overlay', {
        type: 'raster',
        tiles: [USGS_CONTOUR_TILES],
        tileSize: 256,
        minzoom: 9,
        maxzoom: 19,
        attribution: USGS_CONTOUR_ATTR,
      });
      map.addLayer({
        id: 'escout-topo-overlay-layer',
        type: 'raster',
        source: 'escout-topo-overlay',
        paint: { 'raster-opacity': 0.9, 'raster-resampling': 'linear' },
      });
      map.setLayoutProperty('escout-topo-overlay-layer', 'visibility', layerState.contours ? 'visible' : 'none');
    }
    // Real named streams, rivers, ponds & lakes (USGS National Hydrography Dataset) — shown
    // together with the contour lines above so the "Topo Contours" toggle surfaces both
    // elevation shape AND water/creeks in one pass.
    if (!map.getSource('escout-hydro')) {
      map.addSource('escout-hydro', {
        type: 'raster',
        tiles: [USGS_HYDRO_TILES],
        tileSize: 256,
        maxzoom: 16,
        attribution: USGS_HYDRO_ATTR,
      });
      map.addLayer({
        id: 'escout-hydro-layer',
        type: 'raster',
        source: 'escout-hydro',
        paint: { 'raster-opacity': 0.95, 'raster-resampling': 'linear' },
      });
      map.setLayoutProperty('escout-hydro-layer', 'visibility', layerState.contours ? 'visible' : 'none');
    }
    // Dedicated "Water Sources" habitat layer — same USGS NHD hydro tiles as the contour
    // overlay above, but its own independent source/layer so the Habitat Data toggle works
    // standalone (creeks, ponds, seasonal drainage) without requiring Topo Contours too.
    if (!map.getSource('escout-water')) {
      map.addSource('escout-water', {
        type: 'raster',
        tiles: [USGS_HYDRO_TILES],
        tileSize: 256,
        maxzoom: 16,
        attribution: USGS_HYDRO_ATTR,
      });
      map.addLayer({
        id: 'escout-water-layer',
        type: 'raster',
        source: 'escout-water',
        paint: { 'raster-opacity': 0.95, 'raster-resampling': 'linear' },
      });
      map.setLayoutProperty('escout-water-layer', 'visibility', layerState.water ? 'visible' : 'none');
    }
    // Real classified land cover (USDA NLCD 2021) — forest, crop, pasture, wetland & water
    // shading for the "Land Cover (NLCD)" habitat toggle. Kept at partial opacity since it's
    // a full-coverage area raster, not just lines, so the basemap/imagery stays visible
    // underneath for context.
    if (!map.getSource('escout-nlcd')) {
      map.addSource('escout-nlcd', {
        type: 'raster',
        tiles: [NLCD_TILES],
        tileSize: 256,
        maxzoom: 15,
        attribution: NLCD_ATTR,
      });
      map.addLayer({
        id: 'escout-nlcd-layer',
        type: 'raster',
        source: 'escout-nlcd',
        paint: { 'raster-opacity': 0.55, 'raster-resampling': 'nearest' },
      });
      map.setLayoutProperty('escout-nlcd-layer', 'visibility', layerState.landcover ? 'visible' : 'none');
    }
    // Public/protected land ownership polygons (USFS national forest, BLM, state wildlife
    // management areas, DOD, FWS refuges, etc.) — real hunting-relevant data showing which
    // ground is public-access vs. private. Dynamic MapServer export (not tile-cached), so
    // keep the request volume in check with a moderate maxzoom and let MapLibre overzoom
    // the last fetched tile beyond that instead of hammering the service at every zoom step.
    if (!map.getSource('escout-public-land')) {
      map.addSource('escout-public-land', {
        type: 'raster',
        tiles: [USGS_PADUS_TILES],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 14,
        attribution: USGS_PADUS_ATTR,
      });
      map.addLayer({
        id: 'escout-public-land-layer',
        type: 'raster',
        source: 'escout-public-land',
        // The tile image already bakes in a deliberately bold outline + light fill (see the
        // dynamicLayers renderer override above), so keep raster-opacity high — a lower value
        // here would just mute the highlight outline back into the muddy default look.
        paint: { 'raster-opacity': 0.92, 'raster-resampling': 'linear' },
      });
      map.setLayoutProperty('escout-public-land-layer', 'visibility', layerState.public ? 'visible' : 'none');
    }
    // USACE's own real-estate boundary layer (see USACE_CWLDM_* comment above) — fills the
    // gap where PAD-US only digitized a Corps reservoir's water surface and missed the
    // surrounding project land. Drawn as its own source/layer stacked with the PAD-US one
    // above (same toggle, same styling) rather than merged into a single source, so either
    // service having an outage only takes out its own half of the highlight, not both.
    if (!map.getSource('escout-usace-lands')) {
      map.addSource('escout-usace-lands', {
        type: 'raster',
        tiles: [USACE_CWLDM_TILES],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 14,
        attribution: USACE_CWLDM_ATTR,
      });
      map.addLayer({
        id: 'escout-usace-lands-layer',
        type: 'raster',
        source: 'escout-usace-lands',
        paint: { 'raster-opacity': 0.92, 'raster-resampling': 'linear' },
      });
      map.setLayoutProperty('escout-usace-lands-layer', 'visibility', layerState.public ? 'visible' : 'none');
    }
    // State boundary lines — always on, on every basemap, with a bright dashed line plus a
    // dark casing so the border reads clearly whether it crosses open field, water, or
    // dense tree cover.
    if (!map.getSource('escout-states')) {
      map.addSource('escout-states', { type: 'geojson', data: STATE_BOUNDARIES_URL });
      map.addLayer({
        id: 'escout-states-casing',
        type: 'line',
        source: 'escout-states',
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#1a1006', 'line-width': 3.2, 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'escout-states-line',
        type: 'line',
        source: 'escout-states',
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#ff2d55', 'line-width': 1.6, 'line-dasharray': [3, 1.6] },
      });
      map.addLayer({
        id: 'escout-states-label',
        type: 'symbol',
        source: 'escout-states',
        maxzoom: 9,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 12,
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.08,
        },
        paint: { 'text-color': '#ffffff', 'text-halo-color': '#1a1006', 'text-halo-width': 1.4 },
      });
    }
    // Lines & Area measure tool layers — re-added after every basemap switch (setStyle wipes
    // custom layers), then immediately repopulated with whatever the user had drawn.
    if (!map.getSource('escout-measure')) {
      map.addSource('escout-measure', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'escout-measure-fill',
        type: 'fill',
        source: 'escout-measure',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': MEASURE_COLOR, 'fill-opacity': 0.16 },
      });
      map.addLayer({
        id: 'escout-measure-line',
        type: 'line',
        source: 'escout-measure',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': MEASURE_COLOR, 'line-width': 3, 'line-dasharray': [2, 1.4] },
      });
      map.addLayer({
        id: 'escout-measure-points',
        type: 'circle',
        source: 'escout-measure',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 5,
          'circle-color': '#12100c',
          'circle-stroke-color': MEASURE_COLOR,
          'circle-stroke-width': 2.5,
        },
      });
      syncMeasureLayer();
    }
    // Select Scan Area tool layers — a hand-drawn polygon preview in the same orange as
    // the committed scan-scope highlight below, so what you trace is what you'll get.
    if (!map.getSource('escout-area-select')) {
      map.addSource('escout-area-select', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({
        id: 'escout-area-select-fill',
        type: 'fill',
        source: 'escout-area-select',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#ff9a3d', 'fill-opacity': 0.16 },
      });
      map.addLayer({
        id: 'escout-area-select-line',
        type: 'line',
        source: 'escout-area-select',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ff9a3d', 'line-width': 3, 'line-dasharray': [1.6, 1.2] },
      });
      map.addLayer({
        id: 'escout-area-select-points',
        type: 'circle',
        source: 'escout-area-select',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 5,
          'circle-color': '#1a0f04',
          'circle-stroke-color': '#ff9a3d',
          'circle-stroke-width': 2.5,
        },
      });
      if (typeof syncAreaSelectLayer === 'function') syncAreaSelectLayer();
    }
    ensureSelectedParcelLayer();
    renderSelectedParcelLayer();
    } catch (e) { console.error('addBaseLayers failed:', e); }
  }
  map.on('load', addBaseLayers);
  map.on('style.load', addBaseLayers);
  // MapLibre does not always fire 'style.load' on setStyle() (diffed updates can
  // skip it), so fall back to 'styledata' + isStyleLoaded() polling to guarantee
  // custom layers (parcels, contours, hydro, state boundaries, measure tool) are
  // re-added after every basemap switch. addBaseLayers() is idempotent (guards on
  // map.getSource/getLayer existence) so calling it repeatedly is safe.
  map.on('styledata', () => { if (map.isStyleLoaded()) addBaseLayers(); });
  map.on('idle', addBaseLayers);
  window.__escoutMap = map; // debug hook

  /* ---- mobile search/basemap drawer ---- */
  const mobileToolsBtn = document.getElementById('mobileToolsBtn');
  const topbarTools = document.getElementById('topbarTools');
  if (mobileToolsBtn && topbarTools) {
    mobileToolsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !topbarTools.classList.contains('open');
      topbarTools.classList.toggle('open', willOpen);
      mobileToolsBtn.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) {
        const input = document.getElementById('searchInput');
        if (input) input.focus();
      }
    });
    document.addEventListener('click', (e) => {
      if (!topbarTools.contains(e.target) && e.target !== mobileToolsBtn && !mobileToolsBtn.contains(e.target)) {
        topbarTools.classList.remove('open');
        mobileToolsBtn.setAttribute('aria-expanded', 'false');
      }
    });
    // basemap pill taps should close the drawer once a style is chosen
    topbarTools.querySelectorAll('.basemap-pills button').forEach((btn) => {
      btn.addEventListener('click', () => {
        topbarTools.classList.remove('open');
        mobileToolsBtn.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* ---- basemap switch ---- */
  document.querySelectorAll('.basemap-pills button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.style === 'topo' && !hasTopoAccess()) {
        toast('Upgrade to Premium to unlock the Topo basemap');
        openPricingModal();
        return;
      }
      document.querySelectorAll('.basemap-pills button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentBasemap = btn.dataset.style;
      root.dataset.basemap = currentBasemap;
      map.setStyle(styleFor(currentBasemap));
      // MapLibre's setStyle() takes an in-place "diff" path for similar styles (default
      // diff:true) which synchronously patches sources/layers without ever firing
      // 'style.load' or an immediate 'idle' — that only happens later once tile loading
      // settles, which left custom layers (parcels, contours, hydro, state boundaries,
      // measure tool) missing for several seconds after every basemap switch. The diff
      // itself runs synchronously inside setStyle(), so re-adding our layers right here
      // (addBaseLayers is idempotent) restores them instantly with no visible gap.
      addBaseLayers();
      // Seasonal imagery control lives in the Intel Layers panel now (see renderIntel), not a
      // topbar dropdown — only Satellite/Hybrid support it, so refresh the panel in place if
      // it's currently open to reflect the enabled/disabled state for the new basemap.
      if (activeTab === 'intel') renderIntel();
      syncVintageVisibility();
      toast('Basemap switched to ' + btn.textContent.trim());
    });
  });

  /* ---- seasonal imagery switch (control lives in the Intel Layers panel, see renderIntel) ---- */
  const SEASON_LABELS = { leafon: 'Leaf-On (summer canopy)', fall: 'Fall (peak foliage color)' };
  const SEASON_SHORT = { leafon: 'Leaf-On', fall: 'Fall', leafoff: 'Winter' };
  // Leaf-Off's label depends on where the map is currently centered: the escout-leafoff
  // protocol (see the addProtocol registration above) serves real MARIS statewide Mississippi
  // leaf-off aerial photography for MS locations and a graded real-December-Wayback-tile
  // fallback everywhere else, so the label should say which one the user is actually looking
  // at rather than a single caption that's only accurate for one of the two cases.
  function leafoffLabel() {
    const c = map.getCenter();
    return isMississippiPoint(c.lng, c.lat)
      ? 'Winter / Leaf-Off — real MS leaf-off aerial photography (MARIS)'
      : 'Winter / Leaf-Off — real Dec-dated capture + winter grade (MS-only real leaf-off photos apply when panned into Mississippi)';
  }
  function seasonLabel(seasonId) {
    return seasonId === 'leafoff' ? leafoffLabel() : SEASON_LABELS[seasonId];
  }
  function seasonControlEnabled() {
    return currentBasemap === 'satellite' || currentBasemap === 'hybrid';
  }
  function selectSeason(seasonId) {
    if (!seasonControlEnabled() || seasonId === currentImagerySeason) return;
    currentImagerySeason = seasonId;
    root.dataset.season = currentImagerySeason;
    // "Winter / Leaf-Off" swaps the actual satellite tile source to a real December-dated
    // Esri Wayback capture (see WAYBACK_WINTER_RELEASE_ID) instead of just tinting the live
    // tile, so the basemap has to be rebuilt here exactly like a vintage change does. The
    // capture-date (vintage) picker is disabled while this override is active since it has
    // no effect on top of it — picking a season other than Winter hands tile control back
    // to whatever vintage was last selected.
    map.setStyle(styleFor(currentBasemap));
    addBaseLayers();
    syncVintageVisibility();
    if (activeTab === 'intel') renderIntel();
    toast('Seasonal imagery: ' + seasonLabel(currentImagerySeason));
  }

  /* ---- imagery capture-date switch (cloud-cover workaround) ---- */
  const vintageSelectEl = document.getElementById('vintageSelect');
  const vintageTrigger = document.getElementById('vintageTrigger');
  const vintageTriggerLabel = document.getElementById('vintageTriggerLabel');
  const vintageMenu = document.getElementById('vintageMenu');
  function syncVintageVisibility() {
    const show = currentBasemap === 'satellite' || currentBasemap === 'hybrid';
    vintageSelectEl.classList.toggle('show', show);
    if (!show) vintageSelectEl.classList.remove('open');
    // Winter/Leaf-Off forces the tile source to a fixed December Wayback release, so the
    // capture-date picker has nothing to do while it's active — disable it rather than let
    // it look like it's choosing a date that's silently being ignored.
    const overridden = currentImagerySeason === 'leafoff';
    vintageTrigger.disabled = overridden;
    vintageSelectEl.classList.toggle('disabled', overridden);
    vintageTrigger.title = overridden
      ? 'Locked to the real December capture while Winter / Leaf-Off is selected'
      : 'Clouds in the way? Try an older cloud-free capture.';
    if (overridden) {
      vintageSelectEl.classList.remove('open');
      vintageTrigger.setAttribute('aria-expanded', 'false');
    }
  }
  syncVintageVisibility();

  vintageTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = !vintageSelectEl.classList.contains('open');
    vintageSelectEl.classList.toggle('open', willOpen);
    vintageTrigger.setAttribute('aria-expanded', String(willOpen));
  });
  document.addEventListener('click', (e) => {
    if (!vintageSelectEl.contains(e.target)) {
      vintageSelectEl.classList.remove('open');
      vintageTrigger.setAttribute('aria-expanded', 'false');
    }
  });
  vintageMenu.querySelectorAll('button[data-vintage]').forEach((btn) => {
    btn.addEventListener('click', () => {
      vintageMenu.querySelectorAll('button[data-vintage]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentImageryVintage = btn.dataset.vintage;
      const v = imageryVintage(currentImageryVintage);
      vintageTriggerLabel.textContent = v.id === 'live' ? 'Live' : v.label;
      vintageSelectEl.classList.remove('open');
      vintageTrigger.setAttribute('aria-expanded', 'false');
      map.setStyle(styleFor(currentBasemap));
      addBaseLayers();
      toast(v.id === 'live' ? 'Imagery: back to live capture' : `Imagery: showing ${v.label} capture`);
    });
  });

  /* ---------------- Right panel ---------------- */
  const panel = document.getElementById('panel');
  const panelBody = document.getElementById('panelBody');
  const panelTitle = document.getElementById('panelTitle');
  const panelSub = document.getElementById('panelSub');
  const tabs = ['intel', 'scout', 'cams', 'journal'];
  let activeTab = null;

  const TAB_META = {
    intel: { title: 'Intel Layers', sub: 'Toggle map data for this view' },
    scout: { title: 'Scout AI', sub: 'AI terrain analysis for this view' },
    cams: { title: 'Trail Cameras', sub: '3 cameras linked to this property' },
    journal: { title: 'Hunt Journal', sub: 'Logged sits & observations' },
  };

  function openPanel(tab) {
    activeTab = tab;
    panel.classList.add('open');
    panelTitle.textContent = TAB_META[tab].title;
    panelSub.textContent = TAB_META[tab].sub;
    document.querySelectorAll('.rail-btn[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    renderPanel(tab);
  }
  function closePanel() {
    panel.classList.remove('open');
    document.querySelectorAll('.rail-btn[data-tab]').forEach((b) => b.classList.remove('active'));
    activeTab = null;
  }
  document.getElementById('panelClose').addEventListener('click', closePanel);

  document.querySelectorAll('.rail-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (activeTab === btn.dataset.tab) {
        closePanel();
      } else {
        openPanel(btn.dataset.tab);
      }
    });
  });

  /* ---- Intel layers tab ---- */
  const LAYER_ICONS = {
    property: '<svg class="li" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3z" stroke-dasharray="3 2"/></svg>',
    public: '<svg class="li" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 21V9l8-6 8 6v12"/><path d="M9 21v-6h6v6"/></svg>',
    contours: '<svg class="li" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12c3-4 6 4 9 0s6 4 9 0"/><path d="M2 17c3-4 6 4 9 0s6 4 9 0"/></svg>',
    landcover: '<svg class="li" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M2 12h20" opacity="0"/><path d="M12 22c4-3 7-7 7-12a7 7 0 10-14 0c0 5 3 9 7 12z"/></svg>',
    water: '<svg class="li" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2s7 7.5 7 12a7 7 0 11-14 0c0-4.5 7-12 7-12z"/></svg>',
    wind: '<svg class="li" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 8h9a3 3 0 100-3"/><path d="M2 13h13a3 3 0 110 3"/><path d="M2 18h6"/></svg>',
    cams: '<svg class="li" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="15" height="12" rx="2"/><path d="M17 10l5-3v10l-5-3"/></svg>',
    sightings: '<svg class="li" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>',
  };

  const LAYER_DEFS = [
    { group: 'Property & Access', rows: [
      { id: 'property', title: 'Private Land Boundaries', desc: 'Nationwide parcel boundary lines (public cadastral records)', on: true, map: true },
      { id: 'public', title: 'Public Land (USFS / WMA / USACE)', desc: 'National forest, wildlife area & Army Corps of Engineers bounds, highlighted in green', on: false, map: true },
    ]},
    { group: 'Terrain', rows: [
      { id: 'contours', title: 'Topo Contours', desc: 'Elevation contour lines + streams/water (USGS)', on: false, map: true },
      { id: 'slope', title: 'Slope & Aspect Shading', desc: 'Highlights benches & leeward faces', on: false },
    ]},
    { group: 'Habitat Data', rows: [
      { id: 'landcover', title: 'Land Cover (NLCD)', desc: 'Forest, crop, and edge classification', on: false, map: true },
      { id: 'water', title: 'Water Sources', desc: 'Creeks, ponds, seasonal drainage', on: false, map: true },
    ]},
    { group: 'Conditions & Activity', rows: [
      { id: 'wind', title: 'Wind & Thermal Forecast', desc: 'Live wind direction, next 72 hrs', on: true },
      { id: 'cams', title: 'Trail Cameras', desc: 'Show linked camera pins on map', on: false, map: true },
      { id: 'sightings', title: 'Historical Sightings', desc: 'Your logged deer observations', on: false },
    ]},
  ];

  function renderIntel() {
    panelBody.innerHTML = '';
    const propertyUnlocked = hasPropertyAccess();
    const topoUnlocked = hasTopoAccess();
    // Seasonal imagery lives here now instead of the topbar/search row, so it sits alongside
    // the other map-affecting toggles a hunter is already scanning through. It's a 3-way
    // pill choice rather than a plain on/off switch, so it's built by hand instead of going
    // through the generic LAYER_DEFS row renderer used below.
    const seasonGroup = document.createElement('div');
    const seasonTitle = document.createElement('div');
    seasonTitle.className = 'layer-group-title';
    seasonTitle.textContent = 'Seasonal Imagery';
    seasonGroup.appendChild(seasonTitle);
    const seasonEnabled = seasonControlEnabled();
    const seasonRow = document.createElement('div');
    seasonRow.className = 'layer-row layer-row-season' + (seasonEnabled ? '' : ' is-disabled');
    seasonRow.innerHTML = `
      <svg class="li" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2c4 3 6 7 6 11a6 6 0 01-12 0c0-4 2-8 6-11z"/></svg>
      <div class="li-text">
        <div class="li-title">Imagery Season</div>
        <div class="li-desc">${seasonEnabled ? seasonLabel(currentImagerySeason) : 'Switch basemap to Satellite or Hybrid to change season'}</div>
        <div class="season-pills">
          <button type="button" class="season-pill ${currentImagerySeason === 'leafon' ? 'active' : ''}" data-season-pill="leafon" ${seasonEnabled ? '' : 'disabled'}>Leaf-On</button>
          <button type="button" class="season-pill ${currentImagerySeason === 'fall' ? 'active' : ''}" data-season-pill="fall" ${seasonEnabled ? '' : 'disabled'}>Fall</button>
          <button type="button" class="season-pill ${currentImagerySeason === 'leafoff' ? 'active' : ''}" data-season-pill="leafoff" ${seasonEnabled ? '' : 'disabled'}>Winter</button>
        </div>
      </div>`;
    seasonGroup.appendChild(seasonRow);
    panelBody.appendChild(seasonGroup);
    seasonRow.querySelectorAll('.season-pill').forEach((pill) => {
      pill.addEventListener('click', () => selectSeason(pill.dataset.seasonPill));
    });
    LAYER_DEFS.forEach((group) => {
      const g = document.createElement('div');
      const t = document.createElement('div');
      t.className = 'layer-group-title';
      t.textContent = group.group;
      g.appendChild(t);
      group.rows.forEach((row) => {
        const r = document.createElement('div');
        const locked = (row.id === 'property' && !propertyUnlocked) || (row.id === 'contours' && !topoUnlocked);
        r.className = 'layer-row' + (locked ? ' is-locked' : '');
        const control = locked
          ? `<span class="lock-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>Upgrade</span>`
          : `<button class="switch ${layerState[row.id] ? 'on' : ''}" data-layer="${row.id}" aria-label="Toggle ${row.title}"></button>`;
        r.innerHTML = `${LAYER_ICONS[row.id] || ''}<div class="li-text"><div class="li-title">${row.title}</div><div class="li-desc">${row.desc}</div></div>${control}`;
        if (locked) {
          r.addEventListener('click', () => openPricingModal());
        }
        g.appendChild(r);
      });
      panelBody.appendChild(g);
    });
    panelBody.querySelectorAll('.switch').forEach((sw) => {
      sw.addEventListener('click', () => {
        sw.classList.toggle('on');
        applyLayerToggle(sw.dataset.layer, sw.classList.contains('on'));
      });
    });
  }

  function applyLayerToggle(id, on) {
    const label = LAYER_DEFS.flatMap((g) => g.rows).find((r) => r.id === id);
    layerState[id] = on;
    if (id === 'property') syncPropertyLayerVisibility();
    if (id === 'contours') { setVis('escout-topo-overlay-layer', on && hasTopoAccess()); setVis('escout-hydro-layer', on && hasTopoAccess()); }
    if (id === 'landcover') setVis('escout-nlcd-layer', on);
    if (id === 'water') setVis('escout-water-layer', on);
    if (id === 'public') {
      setVis('escout-public-land-layer', on);
      setVis('escout-usace-lands-layer', on);
      if (on) {
        padusErrorToastShown = false;
        toast('Public land boundaries loading — look for bold green outlines in a few seconds. A viewport with no public/protected land nearby will simply show none.', 4600);
        return;
      }
    }
    if (id === 'cams') toggleCamMarkers(on);
    if (id === 'wind') toggleWindHud(on);
    if (label) toast((label.title) + (on ? ' enabled' : ' disabled'));
  }
  function setVis(layerId, on) {
    if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none');
  }
  // Both public-land sources (PAD-US and the USACE REMIS overlay) are live, non-cached
  // ArcGIS export services — unlike a normal cached tile source, either can occasionally
  // time out or error under load. When that happens MapLibre just silently drops the tile,
  // which looks identical to "no public land here" from the user's side. Surface a one-time
  // toast when we detect a real service error while the layer is toggled on, so a genuine
  // outage doesn't get mistaken for a broken toggle.
  let padusErrorToastShown = false;
  map.on('error', (e) => {
    const url = (e && e.error && e.error.url) || (e && e.tile && e.tile.url) || '';
    const isPadus = typeof url === 'string' && (url.indexOf('PAD-US') !== -1 || url.indexOf('cwldm') !== -1);
    if (isPadus && layerState.public && !padusErrorToastShown) {
      padusErrorToastShown = true;
      toast('Public land data service is having trouble loading right now — the green highlight may be temporarily missing. Try panning or reopening the layer in a moment.');
      setTimeout(() => { padusErrorToastShown = false; }, 45000);
    }
  });
  function syncPropertyLayerVisibility() {
    setVis('escout-parcels-layer', layerState.property && hasPropertyAccess());
  }

  /* ---- Trail cam markers ---- */
  const camPoints = [
    [CENTER[0] - 0.006, CENTER[1] + 0.005],
    [CENTER[0] + 0.009, CENTER[1] - 0.003],
    [CENTER[0] - 0.012, CENTER[1] - 0.008],
  ];
  let camMarkers = [];
  function toggleCamMarkers(on) {
    if (on) {
      camPoints.forEach((pt, i) => {
        const el = document.createElement('div');
        el.className = 'escout-marker';
        el.innerHTML = '<span class="marker-pop">' + camSvg() + '</span>';
        const m = new maplibregl.Marker({ element: el }).setLngLat(pt).addTo(map);
        m.getElement().addEventListener('click', () =>
          new maplibregl.Popup({ offset: 18 })
            .setLngLat(pt)
            .setHTML(`<div class="popup-title">Trail Cam ${i + 1}</div><div class="popup-desc">Last activity: ${['Today, 6:42am','Yesterday, 7:15pm','2 days ago, 6:58am'][i]}</div>`)
            .addTo(map)
        );
        camMarkers.push(m);
      });
    } else {
      camMarkers.forEach((m) => m.remove());
      camMarkers = [];
    }
  }
  function camSvg() {
    return '<svg viewBox="0 0 34 34"><circle cx="17" cy="17" r="16" fill="#131c1f" stroke="#f2c14e" stroke-width="2"/><path d="M9 13h11l3-2v10l-3-2H9z" fill="none" stroke="#f2c14e" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  }

  /* ---- Cams tab (list) ---- */
  function renderCams() {
    panelBody.innerHTML = `<div class="layer-group-title">Linked Cameras</div>`;
    const data = [
      { name: 'Cam 1 — Creek Crossing', time: 'Today, 6:42am', tag: '14 photos' },
      { name: 'Cam 2 — Field Edge', time: 'Yesterday, 7:15pm', tag: '8 photos' },
      { name: 'Cam 3 — Ridge Trail', time: '2 days ago, 6:58am', tag: '21 photos' },
    ];
    data.forEach((c) => {
      const el = document.createElement('div');
      el.className = 'cam-card';
      el.innerHTML = `<div class="cam-thumb">${camSvg().replace(/#131c1f|#f2c14e/g, (m) => (m === '#131c1f' ? 'none' : 'currentColor'))}</div><div class="cam-meta"><div class="li-title"><span class="status-dot"></span>${c.name}</div><div class="li-desc">${c.time} · ${c.tag}</div></div>`;
      panelBody.appendChild(el);
    });
    const hint = document.createElement('div');
    hint.className = 'scout-footnote';
    hint.textContent = 'Enable the Trail Cameras layer in Intel to show camera pins on the map.';
    panelBody.appendChild(hint);
  }

  /* ---- Journal tab ---- */
  function renderJournal() {
    panelBody.innerHTML = `<div class="layer-group-title">Recent Sits</div>`;
    const data = [
      { name: 'Evening sit — East Bench Stand', time: 'Aug 27 · Wind NW 6mph', tag: '2 does, 1 young buck' },
      { name: 'Morning sit — Creek Bottom', time: 'Aug 24 · Wind SW 4mph', tag: 'No sightings' },
      { name: 'Evening sit — Ridge Corridor', time: 'Aug 19 · Wind N 9mph', tag: '1 mature buck (tracked)' },
    ];
    data.forEach((c) => {
      const el = document.createElement('div');
      el.className = 'log-card';
      el.innerHTML = `<div class="cam-thumb"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3 6 6 1-4.5 4.5L18 20l-6-3-6 3 1.5-6.5L3 9l6-1z"/></svg></div><div class="log-meta"><div class="li-title">${c.name}</div><div class="li-desc">${c.time}</div><div class="li-desc">${c.tag}</div></div>`;
      panelBody.appendChild(el);
    });

    const wpTitleRow = document.createElement('div');
    wpTitleRow.className = 'layer-group-title-row';
    wpTitleRow.innerHTML = `<div class="layer-group-title">Your Waypoints</div>${
      userWaypoints.length ? '<button type="button" class="text-link-btn" id="shareAllWpBtn">Share all</button>' : ''
    }`;
    panelBody.appendChild(wpTitleRow);
    const shareAllBtn = wpTitleRow.querySelector('#shareAllWpBtn');
    if (shareAllBtn) shareAllBtn.addEventListener('click', () => shareWaypoints());
    if (!userWaypoints.length) {
      const empty = document.createElement('div');
      empty.className = 'wp-log-empty';
      empty.textContent = 'No waypoints yet — use the Waypoint tool on the map, or drop a Scout AI pick, to add one here.';
      panelBody.appendChild(empty);
    } else {
      userWaypoints.forEach((w) => {
        const def = wpDef(w.type);
        const row = document.createElement('div');
        row.className = 'wp-log-row';
        row.innerHTML = `<span class="wp-log-icon">${waypointGlyphSvg(def)}</span><div class="li-text"><div class="li-title">${escapeHtml(w.label)}</div><div class="li-desc">${escapeHtml(def.label)}${w.confidence != null ? ' · ' + escapeHtml(w.confidence) + '% match' : ''}</div></div><button class="wp-share-btn" data-share-wp="${w.id}" aria-label="Share this waypoint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6l6.8-3.8M8.6 13.4l6.8 3.8"/></svg></button><button data-remove-wp="${w.id}" aria-label="Remove waypoint"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>`;
        panelBody.appendChild(row);
        row.addEventListener('click', () => map.flyTo({ center: w.lngLat, zoom: 16.4, duration: 700 }));
        row.querySelector('[data-share-wp]').addEventListener('click', (e) => {
          e.stopPropagation();
          shareWaypoints([w.id]);
        });
        row.querySelector('[data-remove-wp]').addEventListener('click', (e) => {
          e.stopPropagation();
          removeUserWaypoint(w.id);
        });
      });
    }
  }

  /* ---------------- Scout AI ---------------- */
  // Real-data terrain analysis: samples an N×N grid of points across whatever the map is
  // currently framing, reads ACTUAL land cover (USDA/NLCD), elevation (USGS 3DEP), and wind
  // (Open-Meteo) at each point, then reasons over that real data to place bedding/stand/
  // corridor picks. If the frame has no farm/pasture cover, it will never invent a "field
  // edge" — it only uses language the sampled data actually supports.
  const NLCD_SERVICE = 'https://geo.fas.usda.gov/arcgis2/rest/services/G_Land_Cover/NLCD/MapServer';
  const NLCD_LAYER = 2;
  // Full visual NLCD overlay for the "Land Cover (NLCD)" habitat toggle — same USDA service
  // used for point-sampling above, exported as a classified raster (forest/crop/pasture/
  // wetland/water colors) so habitat cover is visible directly on the map, not just used
  // internally by Scout AI. Dynamic MapServer export, same {bbox-epsg-3857} pattern already
  // used for the contour and PAD-US overlays.
  const NLCD_TILES =
    `${NLCD_SERVICE}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&layers=show:${NLCD_LAYER}&f=image`;
  const NLCD_ATTR = 'USDA NLCD 2021';
  const GRID_N = 8; // 8x8 = 64 sample points per scan — finer terrain resolution so real corners, points and narrow pinches are actually distinguishable in the sampled grid instead of being averaged away
  // Minimum real-world separation enforced between the stand/bedding/corridor picks so the
  // three markers actually read as distinct spots on the map instead of stacking on top of
  // each other. Scaled to a fraction of the scanned frame's own diagonal (not a fixed yard
  // value) so it stays sensible whether the scan is a 20-acre food plot or a square-mile
  // view — clamped so it's never so tiny the pins touch, nor so large it forces separation
  // the frame can't actually provide.
  const MIN_PIN_SPACING_FRACTION = 0.16;
  const MIN_PIN_SPACING_FLOOR_YDS = 70;
  const MIN_PIN_SPACING_CEIL_YDS = 380;

  const LC_LABELS = {
    11: 'Open Water', 21: 'Developed (Open Space)', 22: 'Developed (Low Intensity)',
    23: 'Developed (Medium Intensity)', 24: 'Developed (High Intensity)', 31: 'Barren Land',
    41: 'Deciduous Forest', 42: 'Evergreen Forest', 43: 'Mixed Forest', 51: 'Dwarf Scrub',
    52: 'Shrub/Scrub', 71: 'Grassland/Herbaceous', 72: 'Sedge/Herbaceous', 73: 'Lichens',
    74: 'Moss', 81: 'Pasture/Hay', 82: 'Cultivated Crops', 90: 'Woody Wetlands',
    95: 'Emergent Herbaceous Wetlands',
  };
  function lcCategory(code) {
    if (code === 11) return 'water';
    if (code === 90 || code === 95) return 'wetland';
    if (code >= 21 && code <= 24) return 'developed';
    if (code === 31) return 'barren';
    if (code === 41 || code === 42 || code === 43) return 'forest';
    if (code === 51 || code === 52) return 'shrub';
    if (code >= 71 && code <= 74) return 'grass';
    if (code === 81) return 'pasture';
    if (code === 82) return 'crop';
    return 'unknown';
  }
  const isCoverCat = (cat) => cat === 'forest' || cat === 'shrub' || cat === 'wetland';
  const isFieldCat = (cat) => cat === 'pasture' || cat === 'crop';

  async function fetchLandCoverAt(lng, lat) {
    const ext = 0.01;
    const usp = new URLSearchParams({
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      sr: '4326',
      tolerance: '1',
      mapExtent: `${lng - ext},${lat - ext},${lng + ext},${lat + ext}`,
      imageDisplay: '2,2,96',
      returnGeometry: 'false',
      f: 'json',
    });
    const res = await fetch(`${NLCD_SERVICE}/identify?${usp.toString()}`);
    if (!res.ok) throw new Error('NLCD service error ' + res.status);
    const data = await res.json();
    const attrs = data.results && data.results[0] && data.results[0].attributes;
    if (!attrs) return null;
    const code = parseInt(attrs['Raster.Value'], 10);
    if (Number.isNaN(code)) return null;
    return { code, label: attrs['Raster.NLCD Land Cover Class'] || LC_LABELS[code] || 'Unclassified' };
  }
  async function fetchElevationAt(lng, lat) {
    const usp = new URLSearchParams({ x: lng, y: lat, units: 'Feet', wkid: '4326', includeDate: 'false' });
    const res = await fetch(`https://epqs.nationalmap.gov/v1/json?${usp.toString()}`);
    if (!res.ok) throw new Error('Elevation service error ' + res.status);
    const data = await res.json();
    const v = parseFloat(data.value);
    return Number.isFinite(v) && v > -9998 ? v : null;
  }
  async function fetchLiveWind(lng, lat) {
    const usp = new URLSearchParams({
      latitude: lat, longitude: lng, current: 'wind_speed_10m,wind_direction_10m',
      wind_speed_unit: 'mph', timezone: 'auto',
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${usp.toString()}`);
    if (!res.ok) throw new Error('Wind service error ' + res.status);
    const data = await res.json();
    const speed = data.current && data.current.wind_speed_10m;
    const dir = data.current && data.current.wind_direction_10m;
    if (speed == null || dir == null) return null;
    const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const compass = dirs[Math.round(dir / 22.5) % 16];
    return { speed: Math.round(speed), compass, dir };
  }

  let liveWind = null; // { speed, compass, dir } — populated at scan time, and now also by the header HUD chip below, from real data
  let lastAnalysis = null; // diagnostic summary of the most recent scan, for the empty/limited states

  /* ---------------- Live wind HUD chip (header) ---------------- */
  // The "Wind & Thermal Forecast" Intel toggle previously did nothing at all — flipping it
  // had zero effect anywhere in the app, and the header's "Wind SW 6mph" readout was static
  // placeholder text that never changed. This wires the toggle to a real, free, no-key wind
  // API (the same Open-Meteo endpoint Scout AI already uses at scan time) so the header shows
  // the actual current wind for whatever the map is centered on, with an arrow that rotates to
  // point downwind — the direction a hunter's scent will actually carry.
  const windHudChip = document.getElementById('windHudChip');
  const windHudLabel = document.getElementById('windHudLabel');
  const windDirArrow = document.getElementById('windDirArrow');
  let windHudTimer = null;
  let windHudInFlight = false;
  async function refreshWindHud() {
    if (!layerState.wind || windHudInFlight || !windHudLabel) return;
    windHudInFlight = true;
    const c = map.getCenter();
    try {
      const wind = await fetchLiveWind(c.lng, c.lat);
      if (!layerState.wind) return; // toggled off while the request was in flight
      if (wind) {
        windHudLabel.textContent = `${wind.compass} ${wind.speed}mph`;
        // Arrow default points up (north/0°). `dir` is the direction wind blows FROM (standard
        // meteorological convention, matching the "SW" label); rotating by dir+180 instead
        // points the arrow the direction it blows TOWARD — i.e. downwind.
        if (windDirArrow) windDirArrow.style.transform = `rotate(${(wind.dir + 180) % 360}deg)`;
        liveWind = wind; // keep Scout AI's own frame-stat reading in sync with the header too
      } else {
        windHudLabel.textContent = 'Unavailable';
      }
    } catch (e) {
      windHudLabel.textContent = 'Unavailable';
    } finally {
      windHudInFlight = false;
    }
  }
  function toggleWindHud(on) {
    if (windHudChip) windHudChip.hidden = !on;
    if (windHudTimer) { clearInterval(windHudTimer); windHudTimer = null; }
    if (on) {
      refreshWindHud();
      windHudTimer = setInterval(refreshWindHud, 10 * 60 * 1000); // wind drifts slowly; refresh every 10 min
    }
  }

  /* ---------------- Selected-parcel scoping for Scout AI ---------------- */
  // When a hunter taps a specific parcel (Property Boundaries layer on), that parcel
  // becomes the active scan scope: Scout AI samples only inside its footprint and every
  // suggested pin lands within that boundary instead of scattering across the whole map
  // frame. `ring` is an array of [lng, lat] pairs (closed polygon, real cadastral shape
  // for Mississippi parcels, or a labeled-estimate circle sized to the estimated acreage
  // everywhere else where live boundary geometry isn't wired up yet).
  let selectedParcel = null; // { ring, bbox, label, acres, real }

  function pointInRing([px, py], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }
  function ringBBox(ring) {
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    ring.forEach(([lng, lat]) => {
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    });
    return { w, e, s, n };
  }
  function ringAreaAcres(ring) {
    const lat0 = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
    const pts = ring.map(([lng, lat]) => [lng * mPerDegLng, lat * mPerDegLat]);
    let area = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      area += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
    }
    return Math.abs(area / 2) / 4046.8564224;
  }
  function selectedParcelGeoJSON() {
    if (!selectedParcel) return { type: 'FeatureCollection', features: [] };
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [selectedParcel.ring] } }],
    };
  }
  function ensureSelectedParcelLayer() {
    if (map.getSource('escout-selected-parcel')) return;
    map.addSource('escout-selected-parcel', { type: 'geojson', data: selectedParcelGeoJSON() });
    map.addLayer({
      id: 'escout-selected-parcel-fill',
      type: 'fill',
      source: 'escout-selected-parcel',
      paint: { 'fill-color': '#ff9a3d', 'fill-opacity': 0.14 },
    });
    map.addLayer({
      id: 'escout-selected-parcel-line',
      type: 'line',
      source: 'escout-selected-parcel',
      layout: { 'line-join': 'round' },
      paint: { 'line-color': '#ff9a3d', 'line-width': 3, 'line-dasharray': [1.6, 1.2] },
    });
  }
  function renderSelectedParcelLayer() {
    ensureSelectedParcelLayer();
    const src = map.getSource('escout-selected-parcel');
    if (src) src.setData(selectedParcelGeoJSON());
    const vis = selectedParcel ? 'visible' : 'none';
    ['escout-selected-parcel-fill', 'escout-selected-parcel-line'].forEach((id) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    });
  }
  function clearSelectedParcel(silent) {
    if (!selectedParcel) return;
    selectedParcel = null;
    renderSelectedParcelLayer();
    scanned = false;
    clearResultMarkers();
    activeResults = [];
    lastAnalysis = null;
    if (activeTab === 'scout') renderScout();
    if (!silent) toast('Custom area cleared — Scout AI will scan the current map view');
  }
  // The only caller of this is the custom "Select Scan Area" draw tool — clicking a parcel
  // for info no longer routes through here, so Scout AI's scan scope is always either the
  // current map view (no selectedParcel) or a user-drawn custom area (kind: 'custom').
  function setSelectedParcel(ring, meta) {
    selectedParcel = { ring, bbox: ringBBox(ring), label: meta.label, acres: meta.acres, real: !!meta.real, kind: 'custom' };
    renderSelectedParcelLayer();
    scanned = false;
    clearResultMarkers();
    activeResults = [];
    lastAnalysis = null;
    if (activeTab === 'scout') renderScout();
  }

  function metersBetween(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function yardsBetween(lat1, lng1, lat2, lng2) {
    return Math.round(metersBetween(lat1, lng1, lat2, lng2) * 1.09361);
  }
  // Real corner-to-corner distance of the scanned frame, used to scale how far apart the
  // stand/bedding/corridor picks must be (see MIN_PIN_SPACING_* above).
  function frameDiagonalYards(bounds) {
    return yardsBetween(bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast());
  }
  function minPinSpacingYards(bounds) {
    const diag = frameDiagonalYards(bounds);
    return Math.max(MIN_PIN_SPACING_FLOOR_YDS, Math.min(MIN_PIN_SPACING_CEIL_YDS, diag * MIN_PIN_SPACING_FRACTION));
  }
  // Walks a score-sorted candidate list and returns the first (i.e. highest-scoring) entry
  // that keeps at least `minYards` from every already-placed pin in `avoidPts`. Falls back
  // to the plain top-scoring entry if the frame is too small/sparse for any candidate to
  // clear that spacing — a real but tightly-packed suggestion still beats no suggestion.
  function pickSpaced(scoredArr, avoidPts, minYards, getLngLat) {
    if (!scoredArr.length) return null;
    if (!avoidPts || !avoidPts.length) return scoredArr[0];
    const spaced = scoredArr.find((item) => {
      const [lng, lat] = getLngLat(item);
      return avoidPts.every((p) => yardsBetween(lat, lng, p[1], p[0]) >= minYards);
    });
    return spaced || scoredArr[0];
  }

  async function sampleGrid(bounds, ring) {
    // Inset the grid slightly so sample points don't sit exactly on the frame edge.
    const w = bounds.getWest(), e = bounds.getEast(), s = bounds.getSouth(), n = bounds.getNorth();
    const insetLng = (e - w) * 0.08, insetLat = (n - s) * 0.08;
    const w2 = w + insetLng, e2 = e - insetLng, s2 = s + insetLat, n2 = n - insetLat;
    const cells = [];
    for (let r = 0; r < GRID_N; r++) {
      for (let c = 0; c < GRID_N; c++) {
        const lat = n2 - (r / (GRID_N - 1)) * (n2 - s2); // row 0 = north
        const lng = w2 + (c / (GRID_N - 1)) * (e2 - w2); // col 0 = west
        // With a parcel selected, only cells actually inside its real boundary are
        // eligible to host a suggested pin — neighbors outside it still get sampled
        // so edge/corridor detection near the property line still has real context.
        cells.push({ r, c, lng, lat, inParcel: ring ? pointInRing([lng, lat], ring) : true });
      }
    }
    await Promise.all(
      cells.map(async (cell) => {
        const [lc, elev] = await Promise.all([
          fetchLandCoverAt(cell.lng, cell.lat).catch(() => null),
          fetchElevationAt(cell.lng, cell.lat).catch(() => null),
        ]);
        cell.code = lc ? lc.code : null;
        cell.label = lc ? lc.label : 'No data';
        cell.category = lc ? lcCategory(lc.code) : 'unknown';
        cell.elev = elev;
      })
    );
    return cells;
  }
  function cellAt(cells, r, c) {
    if (r < 0 || c < 0 || r >= GRID_N || c >= GRID_N) return null;
    return cells[r * GRID_N + c];
  }
  function neighbors(cells, cell) {
    return [cellAt(cells, cell.r - 1, cell.c), cellAt(cells, cell.r + 1, cell.c), cellAt(cells, cell.r, cell.c - 1), cellAt(cells, cell.r, cell.c + 1)].filter(Boolean);
  }
  function nearestOfCategory(cells, from, predicate, excludeSelf) {
    let best = null, bestD = Infinity;
    cells.forEach((cell) => {
      if (excludeSelf && cell === from) return;
      if (!predicate(cell.category)) return;
      const d = yardsBetween(from.lat, from.lng, cell.lat, cell.lng);
      if (d < bestD) { bestD = d; best = cell; }
    });
    return best ? { cell: best, yards: bestD } : null;
  }
  // ---- Geometry & terrain-shape helpers (used by the scoring models below) ----
  function bearingDeg(lat1, lng1, lat2, lng2) {
    const toRad = (d) => (d * Math.PI) / 180, toDeg = (r) => (r * 180) / Math.PI;
    const phi1 = toRad(lat1), phi2 = toRad(lat2), dLng = toRad(lng2 - lng1);
    const y = Math.sin(dLng) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  function angularDiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }
  const COMPASS8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function compass8(deg) {
    return COMPASS8[Math.round(deg / 45) % 8];
  }
  // True 8-direction slope aspect from a 4-neighbor elevation gradient (Horn-style central
  // difference), replacing the old north/south-only check — this actually distinguishes a
  // SW-facing bench from a due-south one, and gives a real steepness magnitude for ranking.
  function computeAspect(cells, cell) {
    const n = cellAt(cells, cell.r - 1, cell.c), s = cellAt(cells, cell.r + 1, cell.c);
    const w = cellAt(cells, cell.r, cell.c - 1), e = cellAt(cells, cell.r, cell.c + 1);
    if (!n || !s || !w || !e || [n, s, w, e].some((x) => x.elev == null)) return null;
    const dNS = n.elev - s.elev; // positive => north side higher => slope faces south
    const dWE = w.elev - e.elev; // positive => west side higher => slope faces east
    const grade = Math.sqrt(dNS * dNS + dWE * dWE);
    if (grade < 3) return null; // too flat in this grid spacing to call a real aspect
    const faceBearing = (((Math.atan2(dWE, -dNS) * 180) / Math.PI) + 360) % 360;
    return { faceBearing, dirLabel: compass8(faceBearing), grade };
  }
  // Local relief: this cell's elevation minus the average of its sampled neighbors.
  // Positive = a real local knob (good vantage/bedding core); negative = a local draw or
  // saddle (a natural low-resistance travel line), independent of which axis it runs along.
  function localRelief(cells, cell) {
    if (cell.elev == null) return null;
    const nbs = neighbors(cells, cell).filter((n) => n.elev != null);
    if (!nbs.length) return null;
    const avg = nbs.reduce((sum, n) => sum + n.elev, 0) / nbs.length;
    return cell.elev - avg;
  }
  // Approximate equirectangular projection to local meters, centered on `origin` — fine
  // for the small (sub few-mile) extents a single scan covers.
  function toLocalMeters(origin, pt) {
    const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
    const x = toRad(pt[0] - origin[0]) * Math.cos(toRad(origin[1])) * R;
    const y = toRad(pt[1] - origin[1]) * R;
    return [x, y];
  }
  function distPointToSegmentYards(pt, a, b) {
    const P = toLocalMeters(a, pt), A = [0, 0], B = toLocalMeters(a, b);
    const abx = B[0] - A[0], aby = B[1] - A[1];
    const apx = P[0] - A[0], apy = P[1] - A[1];
    const lenSq = abx * abx + aby * aby;
    let t = lenSq > 0 ? (apx * abx + apy * aby) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = A[0] + t * abx, cy = A[1] + t * aby;
    const dx = P[0] - cx, dy = P[1] - cy;
    return Math.round(Math.sqrt(dx * dx + dy * dy) * 1.09361);
  }
  // Wind favorability for a stand at (standLng, standLat) given deer are expected to be
  // toward (refLng, refLat) — a nearby field, bedding pocket, or corridor cell. Uses the
  // shared live `liveWind` reading (already populated by the header wind HUD off real
  // Open-Meteo data). Scent travels the direction the wind blows TOWARD (dir+180 from the
  // meteorological "from" direction); if that's roughly opposite the bearing toward the
  // deer, the hunter's scent is carried away from them — favorable.
  function windFavorability(standLng, standLat, refLng, refLat) {
    if (!liveWind || liveWind.dir == null || (standLng === refLng && standLat === refLat)) return null;
    const scentBearing = (liveWind.dir + 180) % 360;
    const toRefBearing = bearingDeg(standLat, standLng, refLat, refLng);
    const diff = angularDiff(scentBearing, toRefBearing);
    if (diff >= 110) return { verdict: 'favorable', diff };
    if (diff <= 60) return { verdict: 'unfavorable', diff };
    return { verdict: 'neutral', diff };
  }

  // Season-driven scoring weights — these actually change WHICH physical cell gets picked
  // as the stand/bedding/corridor location for a given viewport, not just the reason text
  // attached to whatever cell would have won anyway. Grounded in real deer-behavior
  // seasonality: early season deer are still keyed hard on standing crop as a food source;
  // by late season most row crop is harvested so remaining green browse (pasture/food
  // plots) and thermal cover matter more, and deer get pressure-wary; the rut shifts
  // priority off pure feeding edges and onto travel corridors/bedding proximity as bucks
  // cruise looking for does.
  const SEASON_PROFILE = {
    early: {
      cropBonus: 3.5, pastureBonus: 0.75,
      disturbanceBias: 1, windWeight: 1,
      corridorFieldWeight: 1.3, corridorTerrainWeight: 0.85,
      beddingSeclusionBonus: 1.5, beddingSouthBonus: 0,
    },
    rut: {
      cropBonus: 1.25, pastureBonus: 1,
      disturbanceBias: 0.7, windWeight: 1.35,
      corridorFieldWeight: 0.85, corridorTerrainWeight: 1.45,
      beddingSeclusionBonus: 2.75, beddingSouthBonus: 0.5,
    },
    late: {
      cropBonus: 0.6, pastureBonus: 2.75,
      disturbanceBias: 1.45, windWeight: 1.2,
      corridorFieldWeight: 1.05, corridorTerrainWeight: 1.05,
      beddingSeclusionBonus: 2.5, beddingSouthBonus: 3,
    },
  };
  const seasonProfile = (season) => SEASON_PROFILE[season] || SEASON_PROFILE.early;

  function buildFieldEdgeStand(cells, season) {
    const profile = seasonProfile(season);
    const edgeCells = cells.filter((c) => c.inParcel && isCoverCat(c.category) && neighbors(cells, c).some((n) => isFieldCat(n.category)));
    if (!edgeCells.length) return null;
    const developed = cells.filter((c) => c.category === 'developed' || c.category === 'barren');
    // Score every real edge cell instead of just grabbing the middle of an unordered list —
    // a cover point poking into a field on two or three sides (a peninsula) or an inside
    // corner where two field edges meet are the two strongest, most specific stand setups,
    // and both get rewarded here over a plain single-sided edge.
    const scored = edgeCells.map((cell) => {
      const nbs = neighbors(cells, cell);
      const fieldNbs = nbs.filter((n) => isFieldCat(n.category));
      const fieldNb = fieldNbs[0];
      let score = fieldNbs.length >= 2 ? 6 : 3; // point/peninsula vs. a plain single-side edge
      // Inside corner: two field neighbors on perpendicular sides (e.g. one N/S + one E/W).
      const hasVertField = fieldNbs.some((n) => n.r !== cell.r);
      const hasHorizField = fieldNbs.some((n) => n.c !== cell.c);
      if (fieldNbs.length >= 2 && hasVertField && hasHorizField) score += 4;
      // Crop vs. pasture actually matters by season: standing row crop is the dominant food
      // draw early, but is usually harvested by late season, when remaining green pasture/
      // food-plot edges become the relatively stronger food-source pick instead.
      const hasCropNb = fieldNbs.some((n) => n.category === 'crop');
      const hasPastureNb = fieldNbs.some((n) => n.category === 'pasture');
      if (hasCropNb) score += profile.cropBonus;
      if (hasPastureNb) score += profile.pastureBonus;
      const relief = localRelief(cells, cell);
      if (relief != null && relief > 0) score += Math.min(relief / 6, 3); // slight vantage over the field
      const nearDisturbance = developed.some((d) => yardsBetween(cell.lat, cell.lng, d.lat, d.lng) < 120);
      if (nearDisturbance) score -= 3 * profile.disturbanceBias;
      const wind = fieldNb ? windFavorability(cell.lng, cell.lat, fieldNb.lng, fieldNb.lat) : null;
      if (wind && wind.verdict === 'favorable') score += 3 * profile.windWeight;
      if (wind && wind.verdict === 'unfavorable') score -= 4 * profile.windWeight;
      return { cell, fieldNb, fieldNbs, score, wind, relief, hasCropNb, hasPastureNb };
    }).sort((a, b) => b.score - a.score);
    const pick = scored[0];
    const { cell, fieldNb, fieldNbs, hasCropNb } = pick;
    const seasonNote = season === 'late'
      ? (hasCropNb
          ? 'This crop edge is likely already harvested by late season — treat it as a fallback and lean on the pasture/food-plot side of this pick, which holds green browse deer are still keying on this time of year.'
          : 'One of the few remaining standing food sources this late in the year — worth checking for pressure before committing.')
      : season === 'rut'
      ? 'Even during the rut, does keep using this edge to feed, which pulls cruising bucks past it too, though bucks themselves are spending more time checking corridors than feeding here.'
      : (hasCropNb
          ? 'Classic early-season pattern: standing crop is still the strongest food draw in the area, and deer stage in the timber before stepping into the open to feed near last light.'
          : 'Classic early-season pattern: deer stage in the timber before stepping into the open to feed near last light.');
    const bits = [];
    let name;
    if (fieldNbs.length >= 2) {
      name = `${fieldNb.label} Point Stand`;
      bits.push(`This point of ${cell.label} juts into ${fieldNb.label} with field cover on ${fieldNbs.length} sides in the sampled grid — a true peninsula deer have to walk around, not just a straight tree line.`);
    } else {
      name = `${fieldNb.label} Edge Stand`;
      bits.push(`This point sits in mapped ${cell.label} right where it borders ${fieldNb.label} — a real, sampled field edge, not a guess.`);
    }
    bits.push(seasonNote);
    if (pick.relief != null && pick.relief > 3) bits.push('It also sits slightly higher than the field around it, giving a real elevation advantage for glassing the approach.');
    if (pick.wind) {
      if (pick.wind.verdict === 'favorable') bits.push(`Today's wind (${liveWind.compass} ${liveWind.speed}mph) carries your scent away from the field, not into it — a sound wind for this setup.`);
      else if (pick.wind.verdict === 'unfavorable') bits.push(`Fair warning: today's wind (${liveWind.compass} ${liveWind.speed}mph) is blowing your scent toward the field — better as a plan B on a different wind.`);
    }
    const conf = Math.max(64, Math.min(95, Math.round(76 + pick.score * 2)));
    return { type: 'stand', name, conf, pt: [cell.lng, cell.lat], reason: bits.join(' ') };
  }
  function buildRidgeStand(cells, corridorCandidates, season) {
    const profile = seasonProfile(season);
    const withElev = cells.filter((c) => c.inParcel && c.elev != null && isCoverCat(c.category));
    const pool = withElev.length ? withElev : cells.filter((c) => c.inParcel && c.elev != null);
    if (!pool.length) return null;
    const elevs = pool.map((c) => c.elev);
    const maxElev = Math.max(...elevs), minElev = Math.min(...elevs), spread = Math.max(maxElev - minElev, 1);
    // Score by relative height in this frame, whether it's a genuine local knob (positive
    // relief, not just the edge-of-grid highest sample), interior-ness (a real vantage over
    // the sampled terrain rather than a point that's actually cut off by the frame edge),
    // proximity to any travel corridor already identified below, and wind favorability
    // relative to the nearest lower ground it would be watching.
    const scored = pool.map((cell) => {
      const heightScore = ((cell.elev - minElev) / spread) * 5;
      const relief = localRelief(cells, cell);
      const reliefScore = relief != null && relief > 0 ? Math.min(relief / 5, 3) : 0;
      const interior = cell.r > 0 && cell.r < GRID_N - 1 && cell.c > 0 && cell.c < GRID_N - 1;
      const nearestLow = nearestOfCategory(cells, cell, () => true, true);
      // Rut/late season weight corridor proximity more heavily here (bucks cruising terrain
      // funnels, or pressured deer sticking closer to travel routes) than early season, which
      // leans harder on raw elevation/vantage since there's no food-edge signal to work with
      // in a cover-only viewport.
      let corridorScore = 0;
      if (corridorCandidates && corridorCandidates.length) {
        const d = Math.min(...corridorCandidates.map((cc) => yardsBetween(cell.lat, cell.lng, cc.cell.lat, cc.cell.lng)));
        if (d < 250) corridorScore = 2 * profile.corridorTerrainWeight;
      }
      const wind = nearestLow ? windFavorability(cell.lng, cell.lat, nearestLow.cell.lng, nearestLow.cell.lat) : null;
      const windScore = wind ? (wind.verdict === 'favorable' ? 2 * profile.windWeight : wind.verdict === 'unfavorable' ? -2 * profile.windWeight : 0) : 0;
      const score = heightScore + reliefScore + (interior ? 1.5 : 0) + corridorScore + windScore;
      return { cell, score, wind, corridorScore };
    }).sort((a, b) => b.score - a.score);
    const pick = scored[0].cell;
    const bits = [`No farmed field edge is present in this view, so instead of inventing one, this pick uses real elevation data — ${pick.label} at roughly ${Math.round(pick.elev)} ft, standing out as the highest, most commanding ground actually sampled here.`];
    if (scored[0].corridorScore > 0) {
      bits.push(season === 'rut'
        ? "With no field in view, this vantage also sits close to a likely travel corridor — exactly where a cruising buck's rut movement is most likely to funnel past below."
        : season === 'late'
        ? 'It also sits close to a likely travel corridor, useful now that deer are leaning more on established routes as pressure builds late in the season.'
        : 'It also sits close to a likely travel corridor identified in this frame.');
    }
    const pickWind = scored[0].wind;
    if (pickWind && pickWind.verdict === 'favorable') bits.push(`Current wind (${liveWind.compass} ${liveWind.speed}mph) also favors watching from here — it carries your scent away from the lower ground you'd be glassing.`);
    return {
      type: 'stand',
      name: 'Ridge Vantage Stand',
      conf: Math.max(60, Math.min(90, Math.round(68 + scored[0].score))),
      pt: [pick.lng, pick.lat],
      reason: bits.join(' '),
    };
  }
  function buildBedding(cells, season, corridorCandidates, avoidPts, minSpacingYds) {
    const profile = seasonProfile(season);
    const interior = cells.filter((c) => c.inParcel && isCoverCat(c.category) && !neighbors(cells, c).some((n) => isFieldCat(n.category)));
    if (!interior.length) return null;
    const fieldCells = cells.filter((c) => isFieldCat(c.category));
    const scored = interior.map((cell) => {
      const aspect = computeAspect(cells, cell);
      const isSouthish = aspect && aspect.faceBearing >= 100 && aspect.faceBearing <= 260;
      let score = 0;
      if (isSouthish) score += profile.beddingSouthBonus;
      if (cell.category === 'wetland' || cell.category === 'shrub') score += 1;
      const water = nearestOfCategory(cells, cell, (cat) => cat === 'water' || cat === 'wetland', true);
      if (water && water.yards < 400) score += 1;
      // Seclusion: real distance from the nearest field/opening — thicker, further-tucked
      // cover reads as stronger bedding, especially for rut/late-season buck behavior.
      if (fieldCells.length) {
        const nearestField = fieldCells.reduce((best, f) => {
          const d = yardsBetween(cell.lat, cell.lng, f.lat, f.lng);
          return d < best ? d : best;
        }, Infinity);
        if (nearestField > 300) score += profile.beddingSeclusionBonus;
        else if (nearestField > 150) score += profile.beddingSeclusionBonus * 0.4;
      }
      // Steeper, more broken ground reads as thicker/nastier — real bedding cover deer favor
      // specifically because hunters and other predators avoid it.
      if (aspect && aspect.grade > 8) score += 1.5;
      // A slight bonus for sitting near — but not directly on — a likely travel corridor,
      // since real bedding areas open onto a corridor rather than floating in isolation.
      if (corridorCandidates && corridorCandidates.length) {
        const d = Math.min(...corridorCandidates.map((cc) => yardsBetween(cell.lat, cell.lng, cc.cell.lat, cc.cell.lng)));
        if (d > 40 && d < 300) score += 1.5;
      }
      return { cell, score, aspect, water };
    }).sort((a, b) => b.score - a.score);
    const best = pickSpaced(scored, avoidPts, minSpacingYds, (item) => [item.cell.lng, item.cell.lat]);
    const bits = [`Interior ${best.cell.label} sampled here, set back from any field edge in this view.`];
    if (best.aspect) {
      const isSouthish = best.aspect.faceBearing >= 100 && best.aspect.faceBearing <= 260;
      if (isSouthish && season === 'late') bits.push(`This slope reads ${best.aspect.dirLabel}-facing in the elevation data, so it catches winter sun and blocks the prevailing north wind — strong late-season thermal bedding.`);
      else if (isSouthish && season === 'rut') bits.push(`This slope reads ${best.aspect.dirLabel}-facing in the elevation data — a modest thermal edge that starts to matter as temperatures drop through the rut.`);
      else bits.push(`Elevation data shows this slope is ${best.aspect.dirLabel}-facing.`);
    }
    if (best.water && best.water.yards < 800) bits.push(`Nearest mapped water is about ${best.water.yards} yds away.`);
    if (fieldCells.length) {
      bits.push(season === 'rut' || season === 'late'
        ? 'Tucked well off any field edge sampled in this view — with pressure and buck cruising both up this time of year, that extra seclusion matters more than it does early season.'
        : 'Tucked well off any field edge sampled in this view — the kind of seclusion deer look for to bed undisturbed.');
    }
    return { type: 'bedding', name: `${best.cell.label} Interior Bedding`, conf: Math.max(62, Math.min(93, Math.round(72 + best.score * 2.4))), pt: [best.cell.lng, best.cell.lat], reason: bits.join(' ') };
  }
  // Builds one ranked list of every corridor-shaped candidate in the grid — field pinches,
  // creek/wetland travel lanes, and terrain saddles/draws (now checked on both axes plus
  // local relief, not just a single west-east line) — scored by how tight/genuine the
  // funnel actually is, instead of the old cascade that only ever looked past the first
  // pinch it found and never compared corridor types against each other.
  function rankCorridorCandidates(cells, season) {
    const profile = seasonProfile(season);
    const out = [];
    cells.forEach((c) => {
      if (!c.inParcel || !isCoverCat(c.category)) return;
      const w = cellAt(cells, c.r, c.c - 1), e = cellAt(cells, c.r, c.c + 1);
      const n = cellAt(cells, c.r - 1, c.c), sNode = cellAt(cells, c.r + 1, c.c);
      const horizPinch = w && e && isFieldCat(w.category) && isFieldCat(e.category);
      const vertPinch = n && sNode && isFieldCat(n.category) && isFieldCat(sNode.category);
      // Field-adjacent corridor types (pinches between two ag fields) are weighted by
      // corridorFieldWeight; natural/terrain corridor types (creek bottoms, saddles) are
      // weighted by corridorTerrainWeight — this is what makes rut/late scans actually
      // favor a different corridor type than early season when both are present in view,
      // instead of always picking the same fixed-score winner.
      if (horizPinch || vertPinch) {
        out.push({ type: 'corridor', name: 'Field Pinch Funnel', cell: c, score: 9 * profile.corridorFieldWeight,
          reason: `This ${c.label} strip is pinched between open field cover on both sides in the sampled grid — a genuine funnel deer use to cross between fields with minimal exposure.${season === 'early' ? ' With food sources still concentrated in the fields this early, this is exactly the kind of pinch deer are cutting through most.' : ''}` });
        return;
      }
      const nbs = neighbors(cells, c);
      const onFieldEdge = nbs.some((n2) => isFieldCat(n2.category));
      const nearWater = nbs.some((n2) => n2.category === 'water' || n2.category === 'wetland');
      if (!onFieldEdge && nearWater) {
        out.push({ type: 'corridor', name: 'Creek Bottom Travel Lane', cell: c, score: 6.5 * profile.corridorTerrainWeight,
          reason: `${c.label} bordering mapped water/wetland here — sheltered, low-visibility travel next to a real hydrology feature in this frame.${season === 'rut' ? ' Bucks favor drainages like this when cruising between bedding areas during the rut.' : season === 'late' ? ' With pressure up late in the season, deer lean harder on sheltered routes like this instead of crossing open ground.' : ''}` });
        return;
      }
      // Terrain saddle/draw: this cell reads as a genuine local low point relative to ALL
      // sampled neighbors (not just along one fixed axis), between cover on multiple sides.
      const relief = localRelief(cells, c);
      const coverNbs = nbs.filter((n2) => isCoverCat(n2.category));
      if (!onFieldEdge && relief != null && relief < -3 && coverNbs.length >= 2) {
        out.push({ type: 'corridor', name: 'Terrain Saddle Corridor', cell: c, score: (5 + Math.min(-relief / 4, 3)) * profile.corridorTerrainWeight,
          reason: `Elevation data shows this ${c.label} spot sits in a real low draw relative to the ground around it on ${coverNbs.length} sides — the path of least resistance through this terrain, and a likely travel route.${season === 'rut' ? ' Terrain funnels like this see heavy buck cruising traffic during the rut.' : season === 'late' ? ' Pressured, food-source-scarce deer fall back on terrain routes like this late in the season.' : ''}` });
      }
    });
    return out.sort((a, b) => b.score - a.score);
  }
  // Picks the best corridor candidate, optionally biased toward whichever candidate lies
  // closest to the straight line between the identified bedding area and stand/feeding
  // site — this is what actually ties the "corridor" pick to a real likely travel path
  // between the two other results, instead of surfacing an unrelated funnel elsewhere in
  // the frame.
  function pickBestCorridor(candidates, biasSegment, avoidPts, minSpacingYds) {
    if (!candidates.length) return null;
    const scored = candidates.map((cand) => {
      let score = cand.score;
      if (biasSegment) {
        const d = distPointToSegmentYards([cand.cell.lng, cand.cell.lat], biasSegment[0], biasSegment[1]);
        if (d < 500) score += (500 - d) / 80; // closer to the bedding<->stand line scores higher
      }
      return { cand, score };
    }).sort((a, b) => b.score - a.score);
    // The segment bias above rewards sitting near the stand<->bedding line, which includes
    // being right on top of either endpoint — exactly the clustering this is meant to avoid.
    // Re-apply the same real-world spacing floor here so the winning corridor candidate is a
    // genuine midpoint-ish connector, not a duplicate of a pin already placed.
    const picked = pickSpaced(scored, avoidPts, minSpacingYds, ({ cand }) => [cand.cell.lng, cand.cell.lat]);
    const { cand: best, score: bestScore } = picked;
    return { type: 'corridor', name: best.name, conf: Math.max(63, Math.min(94, Math.round(66 + bestScore * 2))), pt: [best.cell.lng, best.cell.lat], reason: best.reason + (biasSegment ? ' It also lines up closely with the direct line between the bedding area and the stand site above, reinforcing that this is a real connector between the two.' : '') };
  }

  async function analyzeViewport(bounds, season, ring) {
    const cells = await sampleGrid(bounds, ring);
    // hasField/hasCover only look at cells inside the selected parcel (or, with no
    // parcel selected, every cell is inParcel by default — same behavior as before).
    const usable = cells.filter((c) => c.inParcel && c.category !== 'unknown');
    const hasField = cells.some((c) => c.inParcel && isFieldCat(c.category));
    const hasCover = cells.some((c) => c.inParcel && isCoverCat(c.category));
    const results = [];
    const minSpacingYds = minPinSpacingYards(bounds);
    let corridorCandidates = [];
    if (hasCover) corridorCandidates = rankCorridorCandidates(cells, season);
    const stand = hasField ? buildFieldEdgeStand(cells, season) : buildRidgeStand(cells, corridorCandidates, season);
    if (stand) results.push(stand);
    let bedding = null;
    if (hasCover) {
      bedding = buildBedding(cells, season, corridorCandidates, stand ? [stand.pt] : null, minSpacingYds);
      if (bedding) results.push(bedding);
      const biasSegment = stand && bedding ? [stand.pt, bedding.pt] : null;
      const avoidPts = [stand, bedding].filter(Boolean).map((r) => r.pt);
      const corridor = pickBestCorridor(corridorCandidates, biasSegment, avoidPts, minSpacingYds);
      if (corridor) results.push(corridor);
    }
    return { cells, usableCount: usable.length, hasField, hasCover, results };
  }

  // Populated fresh at scan time from analyzeViewport() — this is the array everything else
  // (result cards, markers, fly-to) actually reads from. Every entry's `pt` is a real
  // coordinate drawn from sampled land-cover/elevation data for whatever the map is framing.
  let activeResults = [];
  function estimateVisibleAcres() {
    const b = map.getBounds();
    const midLat = (b.getNorth() + b.getSouth()) / 2;
    const mPerDegLat = 111320;
    const mPerDegLng = 111320 * Math.cos((midLat * Math.PI) / 180);
    const widthM = Math.abs(b.getEast() - b.getWest()) * mPerDegLng;
    const heightM = Math.abs(b.getNorth() - b.getSouth()) * mPerDegLat;
    return (widthM * heightM) / 4046.8564224;
  }
  function frameStatHtml() {
    const windLabel = liveWind ? `${liveWind.compass} · ${liveWind.speed}mph` : 'Scan for live reading';
    if (selectedParcel) {
      const acresTxt = Math.max(0.1, Math.round(selectedParcel.acres * 10) / 10).toLocaleString();
      return `Selected area: <strong>~${acresTxt} acres</strong> · Wind now: <strong>${windLabel}</strong>`;
    }
    return `Frame in view: <strong>~${Math.max(1, Math.round(estimateVisibleAcres())).toLocaleString()} acres</strong> · Wind now: <strong>${windLabel}</strong>`;
  }
  let currentSeason = 'early';
  let scanned = false;
  let scanning = false;
  let resultMarkers = [];
  // True once the user has explicitly saved or cleared the current batch of suggestions,
  // so renderResults() can show a distinct "cleared" message instead of the generic
  // no-cover/no-pattern empty states until the next scan.
  let suggestionsDismissed = false;

  function markerSvg(type) {
    const glyphs = {
      stand: '<circle cx="17" cy="17" r="16" fill="#1a0f04" stroke="#ff9a3d" stroke-width="2"/><circle cx="17" cy="17" r="9" fill="none" stroke="#ff9a3d" stroke-width="1.4"/><circle cx="17" cy="17" r="2.4" fill="#ff9a3d"/>',
      bedding: '<circle cx="17" cy="17" r="16" fill="#0f2019" stroke="#6ed897" stroke-width="2"/><path d="M10 20c0-4 3-8 7-8s7 4 7 8" fill="none" stroke="#6ed897" stroke-width="1.6"/><path d="M10 20h14" stroke="#6ed897" stroke-width="1.6"/>',
      corridor: '<circle cx="17" cy="17" r="16" fill="#0d1e26" stroke="#6fb3e0" stroke-width="2"/><path d="M10 21l7-9 7 9" fill="none" stroke="#6fb3e0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    };
    return `<svg viewBox="0 0 34 34">${glyphs[type]}</svg>`;
  }
  function tagIcon(type) {
    const paths = {
      stand: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>',
      bedding: '<path d="M4 19c0-5 3.5-9 8-9s8 4 8 9M4 19h16"/>',
      corridor: '<path d="M5 19l7-10 7 10"/>',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths[type]}</svg>`;
  }
  const TYPE_LABEL = { stand: 'Stand Site', bedding: 'Bedding Area', corridor: 'Travel Corridor' };

  function clearResultMarkers() {
    resultMarkers.forEach((m) => m.remove());
    resultMarkers = [];
  }

  const scanSteps = [
    'Pulling elevation & slope — USGS 3DEP…',
    'Reading forest & crop cover — NLCD…',
    'Checking creeks & wetlands in frame…',
    'Loading live wind — Open-Meteo…',
    'Modeling deer movement — Scout AI engine…',
  ];

  function renderScout() {
    if (!hasScoutAccess()) {
      const msg = 'Unlock AI terrain analysis — ranked bedding, travel corridor, and stand-site picks for this view — with Premium.';
      panelBody.innerHTML = `
        <div class="scout-locked">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>
          <h3>Scout AI is a paid feature</h3>
          <p>${msg}</p>
          <button class="btn btn-amber" id="scoutUnlockBtn">See plans</button>
        </div>`;
      document.getElementById('scoutUnlockBtn').addEventListener('click', () => openPricingModal());
      return;
    }
    const scopeLabel = selectedParcel ? 'your selected area' : 'this view';
    panelBody.innerHTML = `
      ${selectedParcel ? `
      <div class="scout-parcel-chip">
        <span class="scout-parcel-chip-dot"></span>
        <span class="scout-parcel-chip-label">Scanning area: <strong>${selectedParcel.label}</strong></span>
        <button type="button" id="clearParcelBtn" aria-label="Clear selection, scan the full map view instead">✕ Clear</button>
      </div>` : ''}
      <div>
        <div class="layer-group-title">Season Pattern</div>
        <div class="chip-row" id="seasonChips">
          <button class="chip ${currentSeason === 'early' ? 'on' : ''}" data-season="early">Early Season</button>
          <button class="chip ${currentSeason === 'rut' ? 'on' : ''}" data-season="rut">Rut</button>
          <button class="chip ${currentSeason === 'late' ? 'on' : ''}" data-season="late">Late Season</button>
        </div>
      </div>
      <div class="scout-cta">
        <div class="frame-stat">${frameStatHtml()}</div>
        <button class="btn btn-amber scan-btn" id="scanBtn" ${scanning ? 'disabled' : ''}>
          <svg class="scan-btn-icon" id="scanBtnIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2 2M17 17l2 2M4.9 19.1l2-2M17 7l2-2"/><circle cx="12" cy="12" r="4"/></svg>
          <span id="scanBtnLabel">${scanned ? 'Rescan ' : 'Scan '}${selectedParcel ? 'Selected Area' : 'This View'}</span>
        </button>
        <button type="button" class="btn btn-ghost draw-area-btn" id="drawAreaBtn">${selectedParcel ? 'Redraw' : 'Draw'} a custom scan area</button>
        <div class="scan-progress" id="scanProgress" aria-live="polite"></div>
      </div>
      <div id="scoutResultsWrap"></div>
      <div class="scout-footnote">Scout AI samples a grid of real points across ${scopeLabel === 'this view' ? "whatever you're viewing" : 'the selected boundary'} — actual NLCD land cover, USGS elevation, and live Open-Meteo wind — and only calls out field edges, water, or terrain features it actually finds in that data. Treat results as a scouting starting point — always confirm boundaries and access rights in the field.</div>
    `;
    document.getElementById('scanBtn').addEventListener('click', () => runScan());
    const clearParcelBtn = document.getElementById('clearParcelBtn');
    if (clearParcelBtn) clearParcelBtn.addEventListener('click', () => clearSelectedParcel());
    const drawAreaBtn = document.getElementById('drawAreaBtn');
    if (drawAreaBtn) drawAreaBtn.addEventListener('click', () => { closePanel(); armAreaSelectMode(); });
    panelBody.querySelectorAll('#seasonChips .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const season = chip.dataset.season;
        if (season === currentSeason) return;
        currentSeason = season;
        panelBody.querySelectorAll('#seasonChips .chip').forEach((c) => c.classList.toggle('on', c === chip));
        if (scanned) runScan(true);
      });
    });
    if (scanned) renderResults();
  }

  async function runScan(recalibrate) {
    if (scanning) return;
    scanning = true;
    suggestionsDismissed = false;
    // With a parcel selected, scan just its footprint (bbox padded to the polygon’s own
    // extent, then clipped per-cell to the real boundary in analyzeViewport) instead of
    // whatever the map happens to be framing — that's what actually confines every
    // suggested pin to land on that specific parcel.
    const bounds = selectedParcel
      ? new maplibregl.LngLatBounds([selectedParcel.bbox.w, selectedParcel.bbox.s], [selectedParcel.bbox.e, selectedParcel.bbox.n])
      : map.getBounds();
    const centerForWind = selectedParcel
      ? { lng: (selectedParcel.bbox.w + selectedParcel.bbox.e) / 2, lat: (selectedParcel.bbox.s + selectedParcel.bbox.n) / 2 }
      : map.getCenter();
    const ringForScan = selectedParcel ? selectedParcel.ring : null;
    const scopeLabel = selectedParcel ? 'your selected area' : 'this view';
    const seasonForScan = currentSeason;
    const overlay = document.getElementById('scanOverlay');
    const caption = document.getElementById('scanCaption');
    const scanBtn = document.getElementById('scanBtn');
    const scanBtnIcon = document.getElementById('scanBtnIcon');
    const scanBtnLabel = document.getElementById('scanBtnLabel');
    const scanProgress = document.getElementById('scanProgress');
    if (scanBtn) scanBtn.setAttribute('disabled', 'true');
    if (scanBtn) scanBtn.classList.add('scanning');
    overlay.classList.add('active');
    const firstCaption = recalibrate ? 'Recalibrating for ' + currentSeason + ' pattern…' : scanSteps[0];
    caption.textContent = firstCaption;
    if (scanProgress) scanProgress.textContent = firstCaption;
    if (scanBtnLabel) scanBtnLabel.textContent = 'Scanning…';
    let step = 0;
    const advance = (i) => {
      step = i;
      const text = scanSteps[Math.min(step, scanSteps.length - 1)];
      if (caption) caption.textContent = text;
      if (scanProgress) scanProgress.textContent = text;
    };
    const minStepMs = recalibrate ? 220 : 550;
    const tick = () => new Promise((res) => setTimeout(res, minStepMs));
    try {
      advance(0);
      const [analysis] = await Promise.all([analyzeViewport(bounds, seasonForScan, ringForScan), tick()]);
      advance(1);
      await tick();
      advance(2);
      const wind = await fetchLiveWind(centerForWind.lng, centerForWind.lat).catch(() => null);
      if (wind) liveWind = wind;
      advance(3);
      await tick();
      advance(4);
      await tick();
      activeResults = analysis.results;
      lastAnalysis = analysis;
      scanned = true;
      renderResults();
      dropResultMarkers();
      if (activeResults.length) {
        toast('Scout AI found ' + activeResults.length + ' likely spot' + (activeResults.length === 1 ? '' : 's') + ' from real terrain data on ' + scopeLabel);
      } else if (!analysis.hasCover) {
        toast('No forest, shrub, or wetland cover detected on ' + scopeLabel + (selectedParcel ? '' : ' — pan toward timber for a scout read'));
      } else {
        toast('Sampled ' + scopeLabel + ' but found no clear edge, bedding, or corridor pattern here');
      }
    } catch (err) {
      toast('Scout AI could not read terrain data for ' + scopeLabel + ' — check your connection and try again');
    } finally {
      scanning = false;
      overlay.classList.remove('active');
      if (scanBtn) {
        scanBtn.removeAttribute('disabled');
        scanBtn.classList.remove('scanning');
      }
      if (scanBtnLabel) scanBtnLabel.textContent = (scanned ? 'Rescan ' : 'Scan ') + (selectedParcel ? 'Selected Area' : 'This View');
      if (scanProgress) scanProgress.textContent = '';
      // Refresh the wind readout in the header line now that we may have a live reading.
      const frameStat = panelBody.querySelector('.frame-stat');
      if (frameStat) frameStat.innerHTML = frameStatHtml();
    }
  }

  async function addAllScoutResultsAsWaypoints() {
    if (!activeResults.length) return;
    const addAllBtn = document.getElementById('addAllResultsBtn');
    const clearBtn = document.getElementById('clearSuggestionsBtn');
    if (addAllBtn) addAllBtn.setAttribute('disabled', 'true');
    if (clearBtn) clearBtn.setAttribute('disabled', 'true');
    const toSave = activeResults.slice();
    try {
      const data = await apiFetch('/api/waypoints/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: toSave.map((r) => ({ type: r.type, lng: r.pt[0], lat: r.pt[1], label: r.name, note: r.reason, confidence: r.conf })),
        }),
      });
      (data.waypoints || []).forEach((wp) => addSavedWaypointToMap(wp));
      clearResultMarkers();
      activeResults = [];
      suggestionsDismissed = true;
      renderResults();
      toast(`Added ${toSave.length} suggested pin${toSave.length === 1 ? '' : 's'} to your map`);
    } catch (e) {
      toast(e.message || "Couldn't save those pins — try again");
      if (addAllBtn) addAllBtn.removeAttribute('disabled');
      if (clearBtn) clearBtn.removeAttribute('disabled');
    }
  }

  function clearScoutSuggestions() {
    if (!activeResults.length) return;
    clearResultMarkers();
    activeResults = [];
    suggestionsDismissed = true;
    renderResults();
    toast('Suggestions cleared');
  }

  function renderResults() {
    const wrap = document.getElementById('scoutResultsWrap');
    if (!wrap) return;
    if (!activeResults.length) {
      const msg = suggestionsDismissed
        ? 'Suggested pins cleared. Rescan to get new picks.'
        : lastAnalysis && !lastAnalysis.hasCover
        ? 'No forest, shrub, or wetland cover was found anywhere in this sampled view — Scout AI only works with real cover data, so pan toward timber, brush, or a woodlot and scan again.'
        : 'This view sampled cleanly, but no clear field edge, bedding pocket, or travel corridor stood out in the data. Try zooming out slightly or panning toward a cover/field boundary.';
      wrap.innerHTML = `<div class="layer-group-title">Recommended Locations</div><div class="scout-empty">${msg}</div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="layer-group-title">Recommended Locations</div>
      <div class="scout-bulk-actions">
        <button type="button" class="add-all-btn" id="addAllResultsBtn">Add all ${activeResults.length} to map</button>
        <button type="button" id="clearSuggestionsBtn">Clear suggestions</button>
      </div>
    `;
    activeResults.forEach((r, i) => {
      const card = document.createElement('div');
      card.className = 'result-card';
      card.innerHTML = `
        <div class="result-top">
          <span class="tag ${r.type}">${tagIcon(r.type)}${TYPE_LABEL[r.type]}</span>
          <span class="confidence"><strong>${r.conf}%</strong> match</span>
        </div>
        <div class="result-name">${r.name}</div>
        <div class="result-reason">${r.reason}</div>
        <div class="result-actions">
          <button data-fly="${i}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 3l-9 9M21 3l-6 18-4-8-8-4 18-6z"/></svg>Fly to spot</button>
          <button data-drop="${i}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.5 7-12a7 7 0 10-14 0c0 5.5 7 12 7 12z"/></svg>Drop waypoint</button>
        </div>`;
      wrap.appendChild(card);
    });
    const addAllBtn = document.getElementById('addAllResultsBtn');
    if (addAllBtn) addAllBtn.addEventListener('click', (e) => { e.stopPropagation(); addAllScoutResultsAsWaypoints(); });
    const clearBtn = document.getElementById('clearSuggestionsBtn');
    if (clearBtn) clearBtn.addEventListener('click', (e) => { e.stopPropagation(); clearScoutSuggestions(); });
    wrap.querySelectorAll('[data-fly]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = activeResults[+b.dataset.fly];
        map.flyTo({ center: r.pt, zoom: 16.2, duration: 900 });
      })
    );
    wrap.querySelectorAll('[data-drop]').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = activeResults[+b.dataset.drop];
        addUserWaypoint(r.type, { lng: r.pt[0], lat: r.pt[1] }, { label: r.name, note: r.reason, confidence: r.conf });
        toast(r.name + ' saved to Hunt Journal');
      })
    );
  }

  function dropResultMarkers() {
    clearResultMarkers();
    activeResults.forEach((r) => {
      const el = document.createElement('div');
      el.className = 'escout-marker';
      el.innerHTML = '<span class="marker-pop">' + markerSvg(r.type) + '</span>';
      const marker = new maplibregl.Marker({ element: el }).setLngLat(r.pt).addTo(map);
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        new maplibregl.Popup({ offset: 18, maxWidth: '270px' })
          .setLngLat(r.pt)
          .setHTML(
            `<div class="popup-title">${r.name}</div>` +
              `<div class="popup-desc"><strong>${TYPE_LABEL[r.type]}</strong> · <strong>${r.conf}%</strong> match confidence</div>` +
              `<div class="popup-desc">${r.reason}</div>`
          )
          .addTo(map);
      });
      resultMarkers.push(marker);
    });
    // Results are generated from real samples inside the current viewport, so they already
    // sit inside the frame the user was looking at — no camera jump needed.
  }

  function renderPanel(tab) {
    if (tab === 'intel') renderIntel();
    else if (tab === 'scout') renderScout();
    else if (tab === 'cams') renderCams();
    else if (tab === 'journal') renderJournal();
  }

  /* ---------------- Waypoint tool ---------------- */
  const waypointBtn = document.getElementById('waypointBtn');
  const modeBanner = document.getElementById('modeBanner');
  const modeBannerText = document.getElementById('modeBannerText');
  const waypointPicker = document.getElementById('waypointPicker');
  const wpGrid = document.getElementById('wpGrid');
  let waypointMode = null; // null, or an id from WAYPOINT_TYPES
  let userWaypoints = []; // { id, type, marker, lngLat, label, note, confidence }
  let wpCounter = 0;

  wpGrid.innerHTML = WAYPOINT_TYPES.map(
    (w) => `<button class="wp-item" type="button" data-wp-type="${w.id}"><span class="wp-swatch">${waypointGlyphSvg(w)}</span><span class="wp-label">${w.label}</span></button>`
  ).join('');

  function openWaypointPicker() {
    waypointPicker.classList.add('open');
  }
  function closeWaypointPicker() {
    waypointPicker.classList.remove('open');
  }
  function armWaypointMode(typeId) {
    disarmLineMode();
    if (typeof disarmAreaSelectMode === 'function') disarmAreaSelectMode();
    waypointMode = typeId;
    waypointBtn.classList.add('active');
    modeBanner.classList.add('show');
    modeBannerText.innerHTML = `Dropping <strong>${wpDef(typeId).label}</strong> — tap the map to place it`;
    map.getCanvas().style.cursor = 'crosshair';
  }
  function disarmWaypointMode() {
    waypointMode = null;
    waypointBtn.classList.remove('active');
    modeBanner.classList.remove('show');
    map.getCanvas().style.cursor = '';
  }

  waypointBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (waypointMode) {
      disarmWaypointMode();
      closeWaypointPicker();
      return;
    }
    if (waypointPicker.classList.contains('open')) {
      closeWaypointPicker();
    } else {
      disarmLineMode(); // opening the type grid should immediately exit line mode too,
      if (typeof disarmAreaSelectMode === 'function') disarmAreaSelectMode();
      openWaypointPicker(); // not just once a specific waypoint type is picked
    }
  });
  wpGrid.querySelectorAll('[data-wp-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeWaypointPicker();
      armWaypointMode(btn.dataset.wpType);
    });
  });
  document.getElementById('modeBannerClose').addEventListener('click', () => {
    if (waypointMode) disarmWaypointMode();
    if (lineMode) disarmLineMode();
    if (areaSelectMode) { disarmAreaSelectMode(); clearAreaSelectDraw(); }
  });
  document.addEventListener('click', (e) => {
    if (!waypointPicker.classList.contains('open')) return;
    if (waypointPicker.contains(e.target) || waypointBtn.contains(e.target)) return;
    closeWaypointPicker();
  });

  /* ---------------- Lines & Area measure tool (real distance/area, not a stub) ---------------- */
  const linesBtn = document.getElementById('linesBtn');
  const measureReadout = document.getElementById('measureReadout');
  const measureDistanceEl = document.getElementById('measureDistance');
  const measureAreaRow = document.getElementById('measureAreaRow');
  const measureAreaEl = document.getElementById('measureArea');
  const measureUndoBtn = document.getElementById('measureUndoBtn');
  const measureClearBtn = document.getElementById('measureClearBtn');
  const measureDoneBtn = document.getElementById('measureDoneBtn');

  let lineMode = false;
  let measurePoints = []; // [{ lng, lat }, ...] in click order
  let measureUnit = 'ft'; // 'ft' or 'yd' — toggled by the distance unit button
  const distUnitToggle = document.getElementById('distUnitToggle');

  // Great-circle distance in meters between two lng/lat points (haversine) — accurate
  // enough at hunting-property scale and needs no external geo library.
  function haversineMeters(a, b) {
    const R = 6371008.8;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function totalPathMeters(points) {
    let m = 0;
    for (let i = 1; i < points.length; i++) m += haversineMeters(points[i - 1], points[i]);
    return m;
  }

  // Planar shoelace area, computed in local equirectangular meters around the polygon's
  // own latitude band — accurate to well under 1% at the few-hundred-acre scale this tool
  // is used at, without needing a full geodesic-area library.
  function polygonAreaSqMeters(points) {
    if (points.length < 3) return 0;
    const R = 6371008.8;
    const lat0 = (points.reduce((s, p) => s + p.lat, 0) / points.length) * (Math.PI / 180);
    const xy = points.map((p) => ({
      x: (p.lng * Math.PI) / 180 * R * Math.cos(lat0),
      y: (p.lat * Math.PI) / 180 * R,
    }));
    let sum = 0;
    for (let i = 0; i < xy.length; i++) {
      const a = xy[i];
      const b = xy[(i + 1) % xy.length];
      sum += a.x * b.y - b.x * a.y;
    }
    return Math.abs(sum) / 2;
  }

  function formatDistance(meters, unit) {
    if (unit === 'yd') {
      const yd = meters * 1.09361;
      if (yd < 1000) return Math.round(yd).toLocaleString() + ' yd';
      return (yd / 1760).toFixed(2) + ' mi';
    }
    const ft = meters * 3.28084;
    if (ft < 1000) return Math.round(ft).toLocaleString() + ' ft';
    return (ft / 5280).toFixed(2) + ' mi';
  }
  function formatArea(sqMeters) {
    const acres = sqMeters / 4046.8564224;
    if (acres < 0.05) return Math.round(sqMeters * 10.7639).toLocaleString() + ' sq ft';
    return acres.toFixed(2) + ' ac';
  }

  function measureGeoJSON() {
    const coords = measurePoints.map((p) => [p.lng, p.lat]);
    const features = coords.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} }));
    if (coords.length >= 2) {
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
    }
    if (coords.length >= 3) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]]] },
        properties: {},
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function syncMeasureLayer() {
    const src = map.getSource('escout-measure');
    if (src) src.setData(measureGeoJSON());
  }

  function updateMeasureReadout() {
    const distM = totalPathMeters(measurePoints);
    measureDistanceEl.textContent = formatDistance(distM, measureUnit);
    if (measurePoints.length >= 3) {
      measureAreaRow.hidden = false;
      measureAreaEl.textContent = formatArea(polygonAreaSqMeters(measurePoints));
    } else {
      measureAreaRow.hidden = true;
    }
    measureUndoBtn.disabled = measurePoints.length === 0;
    measureClearBtn.disabled = measurePoints.length === 0;
  }

  function armLineMode() {
    disarmWaypointMode();
    closeWaypointPicker();
    if (typeof disarmAreaSelectMode === 'function') disarmAreaSelectMode();
    lineMode = true;
    linesBtn.classList.add('active');
    modeBanner.classList.add('show');
    modeBannerText.innerHTML = 'Lines &amp; Area — <strong>tap the map</strong> to add points';
    map.getCanvas().style.cursor = 'crosshair';
    measureReadout.classList.add('show');
    measureReadout.setAttribute('aria-hidden', 'false');
    updateMeasureReadout();
  }
  function disarmLineMode() {
    if (!lineMode) return;
    lineMode = false;
    linesBtn.classList.remove('active');
    modeBanner.classList.remove('show');
    map.getCanvas().style.cursor = '';
    // Keep the readout + drawn measurement visible after "Done" so the result can still be
    // reviewed — only hide it once there's genuinely nothing measured.
    if (measurePoints.length === 0) {
      measureReadout.classList.remove('show');
      measureReadout.setAttribute('aria-hidden', 'true');
    }
  }
  function clearMeasure() {
    measurePoints = [];
    syncMeasureLayer();
    updateMeasureReadout();
    if (!lineMode) {
      measureReadout.classList.remove('show');
      measureReadout.setAttribute('aria-hidden', 'true');
    }
  }

  distUnitToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    measureUnit = measureUnit === 'ft' ? 'yd' : 'ft';
    // Button always shows the OTHER unit — tapping it switches to that unit.
    distUnitToggle.textContent = measureUnit === 'ft' ? 'yd' : 'ft';
    distUnitToggle.dataset.unit = measureUnit;
    updateMeasureReadout();
  });
  linesBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (lineMode) {
      disarmLineMode();
      return;
    }
    armLineMode();
  });
  measureUndoBtn.addEventListener('click', () => {
    measurePoints.pop();
    syncMeasureLayer();
    updateMeasureReadout();
  });
  measureClearBtn.addEventListener('click', () => {
    clearMeasure();
    toast('Measurement cleared');
  });
  measureDoneBtn.addEventListener('click', () => {
    disarmLineMode();
    if (measurePoints.length >= 2) toast('Measurement saved on the map — tap Lines & Area again to add more or clear it');
  });

  /* ---------------- Select Scan Area tool ---------------- */
  // Lets a hunter trace an arbitrary boundary anywhere on the map by hand and use it as
  // the active Scout AI scan scope — the same `selectedParcel` mechanism a tapped cadastral
  // parcel already uses (grid sampling clipped to `ring`, bbox-based bounds/wind center),
  // just with a boundary the user draws instead of one pulled from parcel data. This is the
  // right move for land outside Mississippi (no live cadastral lookup yet), leased ground
  // that doesn't match a single parcel, or just scanning a specific stretch of a big tract.
  const areaSelectBtn = document.getElementById('areaSelectBtn');
  const areaSelectReadout = document.getElementById('areaSelectReadout');
  const areaSelectValueEl = document.getElementById('areaSelectValue');
  const areaSelectHintEl = document.getElementById('areaSelectHint');
  const areaSelectUndoBtn = document.getElementById('areaSelectUndoBtn');
  const areaSelectClearBtn = document.getElementById('areaSelectClearBtn');
  const areaSelectDoneBtn = document.getElementById('areaSelectDoneBtn');

  let areaSelectMode = false;
  let areaSelectPoints = []; // [{ lng, lat }, ...] in click order, open ring (not yet closed)

  function areaSelectGeoJSON() {
    const coords = areaSelectPoints.map((p) => [p.lng, p.lat]);
    const features = coords.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} }));
    if (coords.length === 2) {
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
    } else if (coords.length >= 3) {
      features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [...coords, coords[0]] }, properties: {} });
      features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]]] }, properties: {} });
    }
    return { type: 'FeatureCollection', features };
  }
  function syncAreaSelectLayer() {
    const src = map.getSource('escout-area-select');
    if (src) src.setData(areaSelectGeoJSON());
  }
  function updateAreaSelectReadout() {
    const n = areaSelectPoints.length;
    if (n >= 3) {
      areaSelectValueEl.textContent = formatArea(polygonAreaSqMeters(areaSelectPoints));
      areaSelectHintEl.textContent = 'Tap to add more points, or use this area';
    } else {
      areaSelectValueEl.textContent = n + ' point' + (n === 1 ? '' : 's');
      areaSelectHintEl.textContent = 'Add at least 3 points to trace a boundary';
    }
    areaSelectUndoBtn.disabled = n === 0;
    areaSelectClearBtn.disabled = n === 0;
    areaSelectDoneBtn.disabled = n < 3;
  }
  function armAreaSelectMode() {
    disarmWaypointMode();
    closeWaypointPicker();
    disarmLineMode();
    areaSelectMode = true;
    areaSelectBtn.classList.add('active');
    modeBanner.classList.add('show');
    modeBannerText.innerHTML = 'Select Scan Area — <strong>tap the map</strong> to trace a boundary';
    map.getCanvas().style.cursor = 'crosshair';
    areaSelectReadout.classList.add('show');
    areaSelectReadout.setAttribute('aria-hidden', 'false');
    updateAreaSelectReadout();
  }
  function disarmAreaSelectMode() {
    if (!areaSelectMode) return;
    areaSelectMode = false;
    areaSelectBtn.classList.remove('active');
    modeBanner.classList.remove('show');
    map.getCanvas().style.cursor = '';
    areaSelectReadout.classList.remove('show');
    areaSelectReadout.setAttribute('aria-hidden', 'true');
  }
  function clearAreaSelectDraw() {
    areaSelectPoints = [];
    syncAreaSelectLayer();
    updateAreaSelectReadout();
  }
  areaSelectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (areaSelectMode) {
      disarmAreaSelectMode();
      clearAreaSelectDraw();
      return;
    }
    armAreaSelectMode();
  });
  areaSelectUndoBtn.addEventListener('click', () => {
    areaSelectPoints.pop();
    syncAreaSelectLayer();
    updateAreaSelectReadout();
  });
  areaSelectClearBtn.addEventListener('click', () => {
    clearAreaSelectDraw();
    toast('Drawing cleared');
  });
  areaSelectDoneBtn.addEventListener('click', () => {
    if (areaSelectPoints.length < 3) return;
    const ring = areaSelectPoints.map((p) => [p.lng, p.lat]);
    ring.push(ring[0]);
    const acres = ringAreaAcres(ring);
    setSelectedParcel(ring, { label: 'Custom drawn area', acres, real: true, kind: 'custom' });
    disarmAreaSelectMode();
    clearAreaSelectDraw();
    toast('Scan area set — ' + Math.max(0.1, Math.round(acres * 10) / 10).toLocaleString() + ' acres — Scout AI will sample inside this boundary');
  });

  /* ---------------- Parcel info lookup (real cadastral data for 29 states, estimate elsewhere) ---------------- */
  function esriQueryUrl(base, layerId, params) {
    const usp = new URLSearchParams(Object.assign({ f: 'json', returnGeometry: 'false', outSR: '4326' }, params));
    return `${base}/${layerId}/query?${usp.toString()}`;
  }
  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  const PARCEL_FETCH_TIMEOUT_MS = 15000;
  async function esriPointQuery(base, layerId, lng, lat, outFields) {
    const url = esriQueryUrl(base, layerId, {
      geometry: `${lng},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: outFields || '*',
    });
    const res = await fetchWithTimeout(url, PARCEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error('Parcel service error ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Parcel query failed');
    return (data.features && data.features[0] && data.features[0].attributes) || null;
  }
  async function esriAttributeQuery(base, layerId, field, value) {
    const usp = new URLSearchParams({ f: 'json', outFields: '*', where: `${field}='${String(value).replace(/'/g, "''")}'` });
    const url = `${base}/${layerId}/query?${usp.toString()}`;
    const res = await fetchWithTimeout(url, PARCEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error('Parcel service error ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Parcel query failed');
    return (data.features && data.features[0] && data.features[0].attributes) || null;
  }
  async function esriIdentify(base, lng, lat) {
    const pad = 0.05;
    const usp = new URLSearchParams({
      geometry: JSON.stringify({ x: lng, y: lat }),
      geometryType: 'esriGeometryPoint',
      sr: '4326',
      layers: 'all',
      tolerance: '1',
      mapExtent: `${lng - pad},${lat - pad},${lng + pad},${lat + pad}`,
      imageDisplay: '400,400,96',
      returnGeometry: 'false',
      f: 'json',
    });
    const url = `${base}/identify?${usp.toString()}`;
    const res = await fetchWithTimeout(url, PARCEL_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error('Parcel service error ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'Parcel identify failed');
    return data.results || [];
  }
  // Pick the identify() result that actually looks like a parcel record (not a county
  // boundary, city-limits, or other reference layer sharing the same MapServer) by scoring
  // how many of the state's configured field names are present as literal attribute keys.
  function pickParcelCandidate(results, fieldMap, excludeLayerIds) {
    const excluded = new Set(excludeLayerIds || []);
    const fieldNames = [];
    [fieldMap.owner, fieldMap.siteAddress, fieldMap.siteCity, fieldMap.parcelId].forEach((f) => {
      if (typeof f === 'string') fieldNames.push(f);
    });
    (Array.isArray(fieldMap.acres) ? fieldMap.acres : []).forEach((f) => fieldNames.push(f.split('::')[0]));
    let best = null, bestScore = -1;
    for (const r of results) {
      if (excluded.has(r.layerId)) continue;
      const attrs = r.attributes || {};
      const score = fieldNames.reduce((n, f) => n + (f in attrs ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = attrs; }
    }
    return bestScore > 0 ? best : null;
  }
  const SQFT_PER_ACRE = 43560;
  const SQM_PER_ACRE = 4046.8564224;
  // Resolve a fieldMap key (a plain field name, an array of fallback field names, or null)
  // against a raw ArcGIS attributes object, applying a unit conversion when the field name
  // carries a "::sqft" / "::sqm" suffix (some state services report parcel area in raw
  // square feet or square meters rather than acres).
  function pickField(rawAttrs, key) {
    if (!key) return null;
    const candidates = Array.isArray(key) ? key : [key];
    for (const raw of candidates) {
      const [fieldName, unit] = raw.split('::');
      let v = rawAttrs[fieldName];
      if (v == null || v === '' || v === 'Null') continue;
      if (unit) {
        const n = parseFloat(v);
        if (Number.isNaN(n)) continue;
        v = unit === 'sqft' ? n / SQFT_PER_ACRE : unit === 'sqm' ? n / SQM_PER_ACRE : n;
      }
      return v;
    }
    return null;
  }
  function normalizeAttrs(rawAttrs, fieldMap) {
    return {
      owner: pickField(rawAttrs, fieldMap.owner),
      acres: pickField(rawAttrs, fieldMap.acres),
      siteAddress: pickField(rawAttrs, fieldMap.siteAddress),
      siteCity: pickField(rawAttrs, fieldMap.siteCity),
      parcelId: pickField(rawAttrs, fieldMap.parcelId),
      value: pickField(rawAttrs, fieldMap.value),
    };
  }
  function seededRandom(lng, lat, salt) {
    let h = 2166136261 ^ salt;
    const str = lng.toFixed(4) + ',' + lat.toFixed(4);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 10000) / 10000;
  }
  async function fetchParcelDetails(lngLat) {
    const lng = lngLat.lng, lat = lngLat.lat;
    const state = stateAt(lng, lat);
    const cfg = state && STATE_PARCEL_CONFIG[state];
    if (!cfg) {
      // No live cadastral feed wired up for this state yet — return a clearly labeled
      // estimate instead of fabricating a realistic owner name or parcel ID.
      const acres = (2 + seededRandom(lng, lat, 1) * 78).toFixed(1);
      return { kind: 'estimated', state, acres };
    }
    try {
      let rawAttrs = null;
      if (cfg.mode === 'single') {
        rawAttrs = await esriPointQuery(cfg.service, cfg.layerId, lng, lat, '*');
      } else if (cfg.mode === 'two-step-join') {
        const spatial = await esriPointQuery(cfg.service, cfg.layerId, lng, lat, cfg.joinField);
        const joinVal = spatial && spatial[cfg.joinField];
        if (!joinVal) return { kind: 'empty', state };
        rawAttrs = await esriAttributeQuery(cfg.service, cfg.joinLayerId, cfg.joinField, joinVal);
      } else if (cfg.mode === 'county-routed') {
        const results = await esriIdentify(cfg.service, lng, lat);
        rawAttrs = pickParcelCandidate(results, cfg.fieldMap, cfg.excludeLayerIds);
      }
      if (!rawAttrs) return { kind: 'empty', state };
      const attrs = normalizeAttrs(rawAttrs, cfg.fieldMap);
      return { kind: 'live', state, attrs, attribution: cfg.attribution };
    } catch (e) {
      return { kind: 'error', state };
    }
  }
  function fmtAcres(n) {
    if (n == null || Number.isNaN(n)) return null;
    const num = typeof n === 'number' ? n : parseFloat(n);
    if (Number.isNaN(num)) return null;
    return (Math.round(num * 10) / 10).toLocaleString() + ' ac';
  }
  function fmtMoney(n) {
    if (n == null) return null;
    const num = typeof n === 'number' ? n : parseFloat(n);
    if (!num || num <= 0) return null;
    return '$' + Math.round(num).toLocaleString();
  }
  function parcelPopupHtml(data) {
    if (data.kind === 'live') {
      const a = data.attrs;
      const acres = fmtAcres(a.acres);
      const value = fmtMoney(a.value);
      const address = [a.siteAddress, a.siteCity]
        .map((v) => (v == null ? '' : String(v)).trim())
        .filter((v) => v && v !== '0' && v.toLowerCase() !== 'null')
        .join(', ');
      const owner = a.owner ? String(a.owner).replace(/\s+/g, ' ').trim() : null;
      return (
        `<div class="popup-title">${owner || 'Parcel record'}</div>` +
        `<div class="popup-desc"><span class="tag bedding">Live parcel record</span></div>` +
        (acres ? `<div class="popup-desc"><strong>${acres}</strong>${data.state ? ' · ' + data.state : ''}</div>` : '') +
        (address ? `<div class="popup-desc">${address}</div>` : '') +
        (value ? `<div class="popup-desc">Assessed value: <strong>${value}</strong></div>` : '') +
        (a.parcelId ? `<div class="popup-desc">Parcel # ${a.parcelId}</div>` : '') +
        `<div class="popup-desc" style="opacity:.7;margin-top:4px;">Source: ${data.attribution || 'County/state cadastral records'}</div>`
      );
    }
    if (data.kind === 'estimated') {
      return (
        `<div class="popup-title">Parcel estimate</div>` +
        `<div class="popup-desc"><span class="tag stand">Estimated</span></div>` +
        `<div class="popup-desc"><strong>~${data.acres} ac</strong> (estimated from boundary shape)</div>` +
        `<div class="popup-desc">Live owner &amp; acreage records aren't wired up for ${data.state || 'this area'} yet.</div>`
      );
    }
    if (data.kind === 'empty') {
      return (
        `<div class="popup-title">No parcel found here</div>` +
        `<div class="popup-desc">Click directly inside a property boundary line to see owner &amp; acreage details${data.state ? ' in ' + data.state : ''}.</div>`
      );
    }
    return (
      `<div class="popup-title">Couldn't load parcel data</div>` +
      `<div class="popup-desc">The county records service didn't respond — try again in a moment.</div>`
    );
  }
  async function handleParcelClick(lngLat) {
    const loading = new maplibregl.Popup({ offset: 14, maxWidth: '270px' })
      .setLngLat(lngLat)
      .setHTML('<div class="popup-title">Looking up parcel…</div><div class="popup-desc">Checking county records</div>')
      .addTo(map);
    const data = await fetchParcelDetails(lngLat);
    if (!loading.isOpen()) return;
    // Parcel clicks are a pure info lookup now — they no longer set the Scout AI scan
    // scope. Mixing "show me who owns this" with "scan this for Scout AI" was confusing
    // (the boundary highlight and the Scout AI panel would change every time someone was
    // just checking ownership). Scout AI now only scans the current map view (frame) or
    // a boundary the user explicitly draws with the "Select Scan Area" tool.
    loading.setHTML(parcelPopupHtml(data));
  }

  function showWaypointPopup(record) {
    const def = wpDef(record.type);
    const confHtml = record.confidence != null ? `<div class="popup-desc"><strong>${escapeHtml(record.confidence)}%</strong> Scout AI match confidence</div>` : '';
    const noteHtml = record.note ? `<div class="popup-desc">${escapeHtml(record.note)}</div>` : '';
    const popup = new maplibregl.Popup({ offset: 18, maxWidth: '270px' })
      .setLngLat(record.lngLat)
      .setHTML(
        `<div class="popup-title">${escapeHtml(record.label)}</div><div class="popup-desc"><strong>${escapeHtml(def.label)}</strong></div>${confHtml}${noteHtml}` +
          '<div class="popup-btn-row">' +
          `<button class="popup-share-btn" type="button" data-wp-share="${record.id}">` +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.6l6.8-3.8M8.6 13.4l6.8 3.8"/></svg>Share</button>' +
          `<button class="popup-delete-btn" type="button" data-wp-delete="${record.id}">` +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>Remove</button>' +
          '</div>'
      )
      .addTo(map);
    // Delegate the click since the popup's DOM node is only created once .addTo() runs.
    popup.getElement().querySelector('[data-wp-share]').addEventListener('click', () => {
      shareWaypoints([record.id]);
    });
    popup.getElement().querySelector('[data-wp-delete]').addEventListener('click', () => {
      removeUserWaypoint(record.id);
      popup.remove();
    });
  }

  function addUserWaypoint(typeId, lngLat, meta, opts) {
    const def = wpDef(typeId);
    const lngLatObj = Array.isArray(lngLat) ? { lng: lngLat[0], lat: lngLat[1] } : { lng: lngLat.lng, lat: lngLat.lat };
    // Restored/imported pins already carry a server-assigned id (opts.id) and must not be
    // re-saved; freshly-dropped pins get a temporary local id that's swapped for the real
    // server id once the POST below resolves.
    wpCounter += 1;
    const id = (opts && opts.id) || 'wp-' + wpCounter;
    const el = document.createElement('div');
    el.className = 'escout-marker';
    el.innerHTML = '<span class="marker-pop">' + waypointGlyphSvg(def) + '</span>';
    const marker = new maplibregl.Marker({ element: el }).setLngLat(lngLatObj).addTo(map);
    const record = {
      id,
      type: typeId,
      marker,
      lngLat: lngLatObj,
      label: (meta && meta.label) || def.label,
      note: meta && meta.note,
      confidence: meta && meta.confidence,
    };
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      showWaypointPopup(record);
    });
    userWaypoints.push(record);
    if (activeTab === 'journal') renderJournal();
    if (!(opts && opts.skipSave)) {
      record._pendingSave = true;
      apiFetch('/api/waypoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: typeId,
          lng: lngLatObj.lng,
          lat: lngLatObj.lat,
          label: record.label,
          note: record.note,
          confidence: record.confidence,
        }),
      })
        .then((saved) => {
          record._pendingSave = false;
          if (record._deleteOnSave) {
            // Removed locally before this POST resolved — the pin only just got a real
            // server id, so delete it now instead of leaving an orphaned row behind.
            apiFetch('/api/waypoints/' + encodeURIComponent(saved.id), { method: 'DELETE' }).catch(() => {});
            return;
          }
          // Safe to mutate in place — `record` is the same object referenced by the click
          // handler closure above and by userWaypoints, so later removeUserWaypoint(id)
          // calls (using the new server id) still find it.
          record.id = saved.id;
        })
        .catch(() => {
          record._pendingSave = false;
          if (!record._deleteOnSave) toast("Pin dropped but couldn't be saved — it may not survive a reload");
        });
    }
    return record;
  }
  function removeUserWaypoint(id) {
    const idx = userWaypoints.findIndex((w) => w.id === id);
    if (idx === -1) return;
    const record = userWaypoints[idx];
    record.marker.remove();
    userWaypoints.splice(idx, 1);
    if (activeTab === 'journal') renderJournal();
    toast('Waypoint removed');
    if (record._pendingSave) {
      // Still waiting on the initial POST to assign a server id — flag it for deletion as
      // soon as that resolves rather than racing the create with a DELETE for an id that
      // doesn't exist on the server yet.
      record._deleteOnSave = true;
      return;
    }
    apiFetch('/api/waypoints/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {
      toast('Removed here, but the server copy may reappear on reload');
    });
  }

  map.on('click', (e) => {
    if (areaSelectMode) {
      areaSelectPoints.push({ lng: e.lngLat.lng, lat: e.lngLat.lat });
      syncAreaSelectLayer();
      updateAreaSelectReadout();
      return;
    }
    if (lineMode) {
      measurePoints.push({ lng: e.lngLat.lng, lat: e.lngLat.lat });
      syncMeasureLayer();
      updateMeasureReadout();
      return;
    }
    if (waypointMode) {
      addUserWaypoint(waypointMode, e.lngLat);
      toast(wpDef(waypointMode).label + ' dropped');
      return;
    }
    if (layerState.property) {
      if (!hasPropertyAccess()) {
        toast('Upgrade to view parcel boundaries & ownership here');
        return;
      }
      handleParcelClick(e.lngLat);
    }
  });

  /* ---------------- Offline & settings ---------------- */
  document.getElementById('offlineBtn').addEventListener('click', () => toast('Downloading this area for offline use…'));
  document.getElementById('settingsBtn').addEventListener('click', () => toast('Account & preferences'));

  /* ---------------- Search (basic named lookups) ---------------- */
  // Quick shortcuts for the original demo area — still work, but real address/coordinate
  // search below (via free OpenStreetMap geocoding) is what actually lets a user jump
  // anywhere in the country, which is what makes Scout AI analyze a genuinely new spot.
  const PLACES = {
    'tombigbee national forest': CENTER,
    'creek bottom': [CENTER[0] - 0.006, CENTER[1] - 0.015],
    'ridge trail': [CENTER[0] + 0.002, CENTER[1] - 0.006],
    home: CENTER,
  };
  const searchInput = document.getElementById('searchInput');
  let searchInFlight = false;

  function parseLatLng(raw) {
    const m = raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
    return { lat: a, lng: b };
  }

  async function geocodeAddress(query) {
    const url =
      'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('geocode request failed');
    const data = await res.json();
    if (!data.length) return null;
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), label: data[0].display_name };
  }

  async function runSearch() {
    const raw = searchInput.value.trim();
    if (!raw || searchInFlight) return;
    const q = raw.toLowerCase();

    // 1) Raw coordinates, e.g. "34.318, -88.852"
    const coords = parseLatLng(raw);
    if (coords) {
      map.flyTo({ center: [coords.lng, coords.lat], zoom: 15, duration: 900 });
      toast('Located: ' + coords.lat.toFixed(4) + ', ' + coords.lng.toFixed(4));
      return;
    }

    // 2) Built-in demo shortcuts
    const hit = Object.keys(PLACES).find((k) => k.includes(q) || q.includes(k));
    if (hit) {
      map.flyTo({ center: PLACES[hit], zoom: 15, duration: 900 });
      toast('Located: ' + hit.replace(/\b\w/g, (c) => c.toUpperCase()));
      return;
    }

    // 3) Real address / place-name search via free OpenStreetMap geocoding
    searchInFlight = true;
    toast('Searching for "' + raw + '"…');
    try {
      const place = await geocodeAddress(raw);
      if (place) {
        map.flyTo({ center: [place.lng, place.lat], zoom: 15, duration: 1000 });
        toast('Located: ' + place.label.split(',').slice(0, 2).join(','));
      } else {
        toast('No results for "' + raw + '" — try a full address, city, or lat/lng coordinates');
      }
    } catch (err) {
      toast('Search failed — check your connection and try again');
    } finally {
      searchInFlight = false;
    }
  }

  searchInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    runSearch();
  });

  /* ---------------- Pricing modal ---------------- */
  document.querySelectorAll('[data-open-pricing]').forEach((b) => b.addEventListener('click', () => openPricingModal()));
  document.getElementById('pricingClose').addEventListener('click', () => closePricingModal());
  pricingModal.addEventListener('click', (e) => {
    if (e.target === pricingModal) closePricingModal();
  });

  /* ---------------- Install app / PWA ---------------- */
  // Registers the service worker (app-shell caching for a real installable app) and wires
  // the Install modal opened from the rail's Settings button. Wrapped defensively — some
  // preview/sandboxed contexts don't allow service worker registration or the native install
  // prompt, so every branch degrades to a manual instruction instead of breaking the app.
  let deferredInstallPrompt = null;
  const installModal = document.getElementById('installModal');
  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  // iOS gives every browser (and every in-app browser) its own "Add to Home Screen" path —
  // there is no beforeinstallprompt event on iOS at all, so this is entirely UA-sniffed.
  // Kept as a set of narrow, well-known signatures rather than one broad "iphone" check.
  function detectBrowserContext() {
    const ua = navigator.userAgent || '';
    const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // In-app browsers (opened from inside another app's own webview) cannot add anything to
    // the Home Screen on iOS — there is no Share-sheet "Add to Home Screen" action available
    // inside them at all. The person has to back out to Safari/Chrome/Firefox first.
    const isInAppBrowser = /FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|TikTok|Snapchat|LinkedInApp|Twitter|GSA\/|Pinterest|WhatsApp/i.test(ua);
    const isChromeIOS = /CriOS/i.test(ua);
    const isFirefoxIOS = /FxiOS/i.test(ua);
    const isEdgeIOS = /EdgiOS/i.test(ua);
    return { isIOS, isInAppBrowser, isChromeIOS, isFirefoxIOS, isEdgeIOS };
  }
  function stepsHTML(steps) {
    return '<ol class="install-steps">' + steps.map((s) => '<li>' + s + '</li>').join('') + '</ol>';
  }
  function openInstallModal() {
    installModal.classList.add('open');
    refreshInstallModal();
  }
  function closeInstallModal() {
    installModal.classList.remove('open');
  }
  function refreshInstallModal() {
    const statusText = document.getElementById('installStatusText');
    const actionBtn = document.getElementById('installActionBtn');
    const manualHint = document.getElementById('installManualHint');
    if (isStandalone()) {
      statusText.textContent = "You're already running EScout as an installed app on this device.";
      actionBtn.style.display = 'none';
      manualHint.innerHTML = '';
      return;
    }
    actionBtn.style.display = '';
    if (deferredInstallPrompt) {
      statusText.textContent = 'Adds EScout to your home screen or desktop with its own icon — opens full-screen, no browser bar.';
      actionBtn.textContent = 'Install EScout';
      actionBtn.disabled = false;
      manualHint.innerHTML = '';
      return;
    }
    actionBtn.disabled = true;
    actionBtn.textContent = 'Install EScout';
    const { isIOS, isInAppBrowser, isChromeIOS, isFirefoxIOS, isEdgeIOS } = detectBrowserContext();
    if (isIOS && isInAppBrowser) {
      // Nothing to tap here — the install action genuinely doesn't exist in this context.
      actionBtn.style.display = 'none';
      statusText.textContent = "This link opened inside another app's built-in browser, which can't add anything to your Home Screen.";
      manualHint.innerHTML = stepsHTML([
        'Tap the <strong>\u2022\u2022\u2022</strong> or <strong>share</strong> icon in this app\'s toolbar.',
        'Choose <strong>"Open in Safari"</strong> (or "Open in Browser").',
        'Once EScout opens in Safari, come back to this same screen and follow the Safari steps.',
      ]);
    } else if (isIOS && isChromeIOS) {
      statusText.textContent = 'Chrome on iPhone adds apps to your Home Screen manually:';
      manualHint.innerHTML = stepsHTML([
        'Tap the <strong>Share</strong> icon (square with an arrow) to the right of the address bar.',
        'Scroll down and tap <strong>"Add to Home Screen."</strong>',
        'Tap <strong>Add</strong> in the top corner.',
      ]);
    } else if (isIOS && isFirefoxIOS) {
      statusText.textContent = 'Firefox on iPhone adds apps to your Home Screen manually:';
      manualHint.innerHTML = stepsHTML([
        'Tap the <strong>\u2022\u2022\u2022</strong> menu in the bottom toolbar.',
        'Tap <strong>Share</strong>, then <strong>"Add to Home Screen."</strong>',
        'Tap <strong>Add</strong> to confirm.',
      ]);
    } else if (isIOS && isEdgeIOS) {
      statusText.textContent = 'Edge on iPhone adds apps to your Home Screen manually:';
      manualHint.innerHTML = stepsHTML([
        'Tap the <strong>\u2022\u2022\u2022</strong> menu at the bottom of the screen.',
        'Tap <strong>Share</strong>, then <strong>"Add to Home Screen."</strong>',
        'Tap <strong>Add</strong> to confirm.',
      ]);
    } else if (isIOS) {
      // Real Safari. iOS has shipped a couple of different tab-bar layouts (Compact/Bottom/Top),
      // so the Share icon isn't always in the same spot — the "if you don't see it" fallback
      // covers that without needing to detect the exact layout.
      statusText.textContent = 'Safari on iPhone adds apps to your Home Screen manually:';
      manualHint.innerHTML = stepsHTML([
        'Tap the <strong>Share</strong> icon (square with an arrow pointing up). If you don\'t see it, tap <strong>\u2022\u2022\u2022</strong> first, then Share.',
        'Scroll down and tap <strong>"Add to Home Screen."</strong>',
        'Tap <strong>Add</strong> in the top-right corner.',
      ]);
    } else {
      statusText.textContent = 'Your browser handles installing this app manually:';
      manualHint.innerHTML = stepsHTML([
        'Look for an install icon (\u2295 or a monitor icon) in your address bar.',
        'Or open your browser menu and choose <strong>"Install EScout"</strong> / <strong>"Add to Home Screen."</strong>',
      ]);
    }
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installModal.classList.contains('open')) refreshInstallModal();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    toast('EScout installed — find it on your home screen or app launcher');
    refreshInstallModal();
  });
  document.getElementById('installBtn').addEventListener('click', () => openInstallModal());
  document.getElementById('installClose').addEventListener('click', () => closeInstallModal());
  installModal.addEventListener('click', (e) => {
    if (e.target === installModal) closeInstallModal();
  });
  document.getElementById('installActionBtn').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice.catch(() => null);
    deferredInstallPrompt = null;
    if (choice && choice.outcome === 'accepted') toast('Installing EScout…');
    refreshInstallModal();
  });
  // A dedicated link (?install=1) that opens straight to this modal on load, so it can be
  // shared with someone else and immediately put the install prompt in front of them —
  // instead of them having to find the rail's Settings button themselves first.
  const installLinkInput = document.getElementById('installLinkInput');
  const installLinkCopyBtn = document.getElementById('installLinkCopyBtn');
  if (installLinkInput) {
    installLinkInput.value = window.location.origin + window.location.pathname + '?install=1';
  }
  if (installLinkCopyBtn) {
    installLinkCopyBtn.addEventListener('click', () => copyShareLink(installLinkInput.value));
  }
  try {
    if (new URLSearchParams(window.location.search).get('install') === '1' && !isStandalone()) {
      // Give the browser a moment to fire beforeinstallprompt (Chrome/Edge/Android) before
      // opening, so the real "Install EScout" button is ready instead of the manual-steps
      // fallback flashing first. iOS Safari never fires that event — Apple gives web pages
      // no API to trigger or complete "Add to Home Screen" themselves, so on iOS this modal
      // can only show the same manual Share-icon steps a person would find on their own;
      // a truly one-tap automatic install there isn't possible in any web app.
      window.addEventListener('load', () => setTimeout(openInstallModal, 600));
    }
  } catch (e) { /* ignore malformed URL */ }

  /* ---------------- Share-pin modal ---------------- */
  const shareModal = document.getElementById('shareModal');
  document.getElementById('shareClose').addEventListener('click', () => shareModal.classList.remove('open'));
  shareModal.addEventListener('click', (e) => {
    if (e.target === shareModal) shareModal.classList.remove('open');
  });
  document.getElementById('shareCopyBtn').addEventListener('click', () => {
    const input = document.getElementById('shareLinkInput');
    input.select();
    copyShareLink(input.value);
  });
  document.getElementById('downloadSourceBtn').addEventListener('click', () => toast('Downloading EScout source (.zip)…'));
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // Tag the SW script URL with the same ?v= cache-buster already on this app.js
      // reference. Without this, the SW itself is fetched from a plain './sw.js' URL
      // that the CDN edge-caches for hours, so a returning visitor's browser can stay
      // stuck on a pre-deploy shell (missing whatever shipped in this release) until
      // that unversioned URL's cache happens to expire. A version-tagged URL is a
      // brand-new cache key on every deploy, so the update fetch always goes straight
      // to the network instead of waiting out someone else's cache window.
      const currentScript = document.currentScript || document.querySelector('script[src*="app.js"]');
      let swVersionParam = '';
      try {
        const v = currentScript && new URL(currentScript.src, window.location.href).searchParams.get('v');
        if (v) swVersionParam = '?v=' + v;
      } catch (e) { /* fall back to unversioned URL below */ }
      navigator.serviceWorker
        .register('./sw.js' + swVersionParam, { updateViaCache: 'none' })
        .then((reg) => {
          // Force an immediate check for a newer service worker (bypassing any stale
          // in-flight registration) so already-installed users pick up fixes without
          // waiting on the browser's own slow periodic update schedule.
          reg.update().catch(() => {});
          // If a new SW takes control while we're open (i.e. an update was already
          // waiting), do one clean reload so the fresh app shell takes effect right away
          // instead of silently running stale cached code until the next manual reopen.
          let reloadedForUpdate = false;
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (reloadedForUpdate) return;
            reloadedForUpdate = true;
            window.location.reload();
          });
        })
        .catch(() => {
          /* Some sandboxed/preview contexts block SW registration — the app works fine without
             it, it just won't be installable/offline-cached there. */
        });
    });
  }

  function refreshPricingModal() {
    document.querySelectorAll('.plan[data-plan]').forEach((card) => {
      const isCurrent = card.dataset.plan === subscription.tier;
      card.classList.toggle('is-current', isCurrent);
      let badge = card.querySelector('.plan-current-badge');
      if (isCurrent) {
        if (!badge) {
          badge = document.createElement('div');
          badge.className = 'plan-current-badge';
          card.appendChild(badge);
        }
        badge.textContent = subscription.source === 'comp' ? 'Complimentary' : 'Current plan';
      } else if (badge) {
        badge.remove();
      }
    });
    const isComp = subscription.source === 'comp';
    const billingBtn = document.getElementById('manageBillingBtn');
    if (billingBtn) billingBtn.style.display = subscription.tier === 'free' || isComp ? 'none' : '';
    const noteEl = document.getElementById('trialNoteText');
    if (noteEl) {
      if (isComp && subscription.expiresAt) {
        const until = new Date(subscription.expiresAt * 1000).toLocaleDateString();
        noteEl.textContent = `Complimentary Premium access — active through ${until}`;
      } else {
        noteEl.textContent = 'Secure payments via Stripe · cancel anytime';
      }
    }
    document.querySelectorAll('.plan-cta').forEach((b) => {
      if (b.dataset.cta === 'free') {
        if (isComp) {
          b.textContent = 'Continue free';
          b.disabled = true;
        } else {
          b.textContent = subscription.tier === 'free' ? 'Continue free' : 'Cancel / manage plan';
          b.disabled = false;
        }
      }
    });
  }

  function refreshGatingUI() {
    updatePlanChip();
    syncPropertyLayerVisibility();
    if (activeTab === 'intel') renderIntel();
    else if (activeTab === 'scout') renderScout();
    refreshPricingModal();
  }

  document.querySelectorAll('.plan-cta').forEach((b) =>
    b.addEventListener('click', async () => {
      const tier = b.dataset.cta;
      if (tier === 'free') {
        if (subscription.tier === 'free') {
          closePricingModal();
          return;
        }
        // Already on a paid plan — send them to the Billing Portal to actually cancel,
        // rather than just resetting local state (which wouldn't cancel the real charge).
        try {
          await openBillingPortal();
        } catch (e) {
          toast(e.message || 'Could not open billing portal');
        }
        return;
      }
      const originalLabel = b.textContent;
      b.disabled = true;
      b.textContent = 'Redirecting to secure checkout…';
      try {
        if (tier === 'premium') {
          await startCheckout('premium');
        }
        toast('Complete your purchase in the new tab that opened');
      } catch (e) {
        toast(e.message || 'Could not start checkout — try again');
      } finally {
        b.disabled = false;
        b.textContent = originalLabel;
      }
    })
  );

  const manageBillingBtn = document.getElementById('manageBillingBtn');
  manageBillingBtn.addEventListener('click', async () => {
    manageBillingBtn.disabled = true;
    try {
      await openBillingPortal();
    } catch (e) {
      toast(e.message || 'Could not open billing portal');
    } finally {
      manageBillingBtn.disabled = false;
    }
  });

  // Manual complimentary-code entry — lets a code be redeemed from inside whichever storage
  // context is currently running (e.g. an already-installed iOS home-screen app), since that
  // context can't be reached by tapping a ?redeem=CODE link, which always opens in Safari.
  const redeemToggle = document.getElementById('redeemToggle');
  const redeemForm = document.getElementById('redeemForm');
  const redeemInput = document.getElementById('redeemInput');
  const redeemSubmit = document.getElementById('redeemSubmit');
  if (redeemToggle && redeemForm && redeemInput && redeemSubmit) {
    redeemToggle.addEventListener('click', () => {
      const showing = redeemForm.style.display !== 'none';
      redeemForm.style.display = showing ? 'none' : 'flex';
      if (!showing) redeemInput.focus();
    });
    const submitRedeem = async () => {
      const code = redeemInput.value.trim();
      if (!code) return;
      redeemSubmit.disabled = true;
      const original = redeemSubmit.textContent;
      redeemSubmit.textContent = 'Applying\u2026';
      try {
        const ok = await redeemCode(code);
        if (ok) {
          redeemInput.value = '';
          redeemForm.style.display = 'none';
        }
      } finally {
        redeemSubmit.disabled = false;
        redeemSubmit.textContent = original;
      }
    };
    redeemSubmit.addEventListener('click', submitRedeem);
    redeemInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitRedeem();
    });
  }

  map.on('moveend', () => {
    // Keep the open panel (Intel acreage / Scout AI frame stat) in sync with the current
    // viewport for any tier that has map-dependent UI.
    refreshWindHud(); // no-op internally when the Wind & Thermal toggle is off
    scheduleSaveViewState();
    if (subscription.tier === 'free') return;
    if (activeTab === 'intel') renderIntel();
    else if (activeTab === 'scout') renderScout();
  });

  refreshPricingModal();
  updatePlanChip();
  toggleWindHud(layerState.wind);

  /* ---------------- Subscription sync on load ---------------- */
  confirmCheckoutReturn()
    .then(() => confirmRedeemReturn())
    .then(() => confirmSharedWaypointsReturn())
    .finally(() => loadSubscription());

  /* ---------------- Onboarding hint ---------------- */
  setTimeout(() => toast('Try the AI Scout tool — tap the glowing icon on the left dock', 4200), 900);
})();
