const form = document.querySelector("#tracking-form");
const trackingInput = document.querySelector("#tracking-number");
const errorMessage = document.querySelector("#form-error");
const trackButton = document.querySelector("#track-button");
const shareTrackingButton = document.querySelector("#share-tracking");
const shareWhatsappButton = document.querySelector("#share-whatsapp");
const printReceiptButton = document.querySelector("#print-receipt");
const shareLinkMessage = document.querySelector("#share-link-message");
const timeline = document.querySelector("#timeline-list");
const mapEmptyState = document.querySelector("#map-empty-state");
// Map is lazy-initialized the first time it's needed
let map = null;
let mapLayers = null;
let mapInitialized = false;
const mapViewport = document.querySelector("#map-viewport");
let tileLayer;
let tileSourceIndex = -1;
let tileWatchdog = 0;
let tilesLoadedForSource = false;
let tileLoadErrors = 0;
let displayedTrackingNumber;
let trackingRequestId = 0;
let mapResizeFrame = 0;
let lastRenderedShipment = null;

function initMapIfNeeded() {
  if (mapInitialized || !window.L) return;
  mapInitialized = true;
  const isMobile = window.matchMedia("(pointer: coarse)").matches;
  map = L.map("live-map", {
    zoomControl: false,
    scrollWheelZoom: false,
    tap: false,         // prevents 300ms tap delay on mobile
    fadeAnimation: true,
    markerZoomAnimation: true,
    preferCanvas: true  // faster rendering on mobile
  }).setView([0, 0], 2);
  mapLayers = L.layerGroup().addTo(map);
  if (!isMobile) {
    L.control.zoom({ position: "topright" }).addTo(map);
  }
  // Keep the map sized correctly when the layout changes (the map is created lazily,
  // so this has to be set up here and not at page load).
  const resizeMap = () => {
    cancelAnimationFrame(mapResizeFrame);
    mapResizeFrame = requestAnimationFrame(() => map && map.invalidateSize({ pan: false }));
  };
  if (mapViewport && "ResizeObserver" in window) new ResizeObserver(resizeMap).observe(mapViewport);
  window.addEventListener("orientationchange", resizeMap);
  window.addEventListener("load", resizeMap);
  window.visualViewport?.addEventListener("resize", resizeMap);
  setTimeout(resizeMap, 300);
}

const demoTrackingNumber = "ST-8492-0317";
const savedShipmentKey = "northstar:myShipment";
const recentShipmentsKey = "northstar:recentShipments";

function showToast(message, type = "info") {
  const container = document.querySelector("#toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 400);
  }, 4500);
}

function readSavedShipment() {
  try { return window.localStorage.getItem(savedShipmentKey) || ""; } catch { return ""; }
}
function writeSavedShipment(trackingNumber) {
  try { window.localStorage.setItem(savedShipmentKey, trackingNumber); } catch { /* storage unavailable */ }
}
function clearSavedShipment() {
  try { window.localStorage.removeItem(savedShipmentKey); } catch { /* storage unavailable */ }
}

function readRecentShipments() {
  try {
    const raw = window.localStorage.getItem(recentShipmentsKey);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function addRecentShipment(trackingNumber) {
  try {
    const list = readRecentShipments().filter((num) => num !== trackingNumber);
    list.unshift(trackingNumber);
    window.localStorage.setItem(recentShipmentsKey, JSON.stringify(list.slice(0, 5)));
    renderRecentShipments();
  } catch { /* storage unavailable */ }
}
function renderRecentShipments() {
  const wrap = document.querySelector("#recent-tracking-wrap");
  const listEl = document.querySelector("#recent-tracking-list");
  if (!wrap || !listEl) return;
  const list = readRecentShipments();
  if (list.length === 0) {
    wrap.hidden = true;
    return;
  }
  listEl.replaceChildren();
  for (const num of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recent-tracking-chip";
    btn.textContent = num;
    btn.addEventListener("click", () => {
      trackingInput.value = num;
      trackShipment(num);
    });
    listEl.appendChild(btn);
  }
  wrap.hidden = false;
}
const deliveryStatuses = ["Order placed", "Picked up", "In transit", "Out for delivery", "Delivered"];
const mapTileSources = [
  {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    subdomains: "abcd",
    maxZoom: 20
  },
  {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }
];
const mapTilesUnavailableMessage = "Map tiles could not be loaded. Check your internet connection and try again.";

function addMapTileLayer() {
  initMapIfNeeded();
  if (!map) return;
  tileSourceIndex += 1;
  tileLoadErrors = 0;
  const source = mapTileSources[tileSourceIndex];
  const sourceLayer = L.tileLayer(source.url, {
    maxZoom: 19,
    attribution: source.attribution,
    ...(source.subdomains ? { subdomains: source.subdomains } : {})
  }).addTo(map);
  tileLayer = sourceLayer;
  clearTimeout(tileWatchdog);
  tileWatchdog = setTimeout(() => {
    // Tiles that neither load nor fail (slow or filtered network): move to the next source.
    if (tileLayer !== sourceLayer || tilesLoadedForSource) return;
    if (tileSourceIndex < mapTileSources.length - 1) {
      map.removeLayer(sourceLayer);
      addMapTileLayer();
    } else {
      mapEmptyState.textContent = mapTilesUnavailableMessage;
      mapEmptyState.hidden = false;
      try { renderStaticFallback(lastRenderedShipment); } catch (e) { /* ignore */ }
    }
  }, 7000);
  tilesLoadedForSource = false;
  tileLayer.on("tileerror", () => {
    if (tileLayer !== sourceLayer) return;
    tileLoadErrors += 1;
    if (tileLoadErrors < 3) return;
    if (tileSourceIndex < mapTileSources.length - 1) {
      map.removeLayer(tileLayer);
      addMapTileLayer();
      return;
    }
    mapEmptyState.textContent = mapTilesUnavailableMessage;
    mapEmptyState.hidden = false;
    // Attempt a client-side static fallback when tile servers are unreachable
    try { renderStaticFallback(lastRenderedShipment); } catch (e) { /* ignore */ }
  });
  tileLayer.on("tileload", () => {
    if (tileLayer !== sourceLayer) return;
    tilesLoadedForSource = true;
    clearTimeout(tileWatchdog);
    tileLoadErrors = 0;
    if (mapEmptyState.textContent === mapTilesUnavailableMessage) mapEmptyState.hidden = true;
    try {
      const fallback = document.querySelector('#live-map .static-map-fallback');
      if (fallback) fallback.remove();
    } catch (e) { }
  });
}

function normalizeTrackingNumber(value) {
  return value.trim().toUpperCase();
}

function isValidTrackingNumber(value) {
  return /^[A-Z0-9](?:[A-Z0-9 -]{0,62}[A-Z0-9])?$/.test(value);
}

function formatTime(timestamp) {
  if (!timestamp) return "Awaiting update";
  const date = new Date(timestamp);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " · " +
    date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function recipientInitials(name) {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map((part) => Array.from(part)[0].toLocaleUpperCase())
    .join("") || "?";
}

function updateTimeline(events, status) {
  timeline.replaceChildren();
  for (const [index, event] of events.entries()) {
    const item = document.createElement("div");
    const completed = event.completed;
    item.className = `timeline-item${completed ? " completed" : ""}${event.status === status ? " current" : ""}`;
    const node = document.createElement("span");
    node.className = "timeline-node";
    node.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "timeline-copy";
    const detail = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = event.status;
    const location = document.createElement("span");
    location.textContent = event.location;
    const time = document.createElement("time");
    time.textContent = formatTime(event.timestamp);
    detail.append(title, location);
    copy.append(detail, time);
    item.append(node, copy);
    item.dataset.step = String(index);
    timeline.append(item);
  }
}

function positionOnRoute(route, progress) {
  if (route.length < 2) return null;
  const points = route.map((stop) => L.latLng(stop.lat, stop.lng));
  const distances = points.slice(1).map((point, index) => points[index].distanceTo(point));
  const totalDistance = distances.reduce((sum, distance) => sum + distance, 0);
  let remainingDistance = totalDistance * Math.max(0, Math.min(1, progress));
  for (let index = 0; index < distances.length; index += 1) {
    if (remainingDistance <= distances[index]) {
      const fraction = distances[index] ? remainingDistance / distances[index] : 0;
      return L.latLng(
        points[index].lat + (points[index + 1].lat - points[index].lat) * fraction,
        points[index].lng + (points[index + 1].lng - points[index].lng) * fraction
      );
    }
    remainingDistance -= distances[index];
  }
  return points.at(-1);
}

function routePrefix(route, progress) {
  const points = route.map((stop) => L.latLng(stop.lat, stop.lng));
  if (points.length < 2) return points;
  const distances = points.slice(1).map((point, index) => points[index].distanceTo(point));
  let remainingDistance = distances.reduce((sum, distance) => sum + distance, 0) *
    Math.max(0, Math.min(1, progress));
  const prefix = [points[0]];

  for (let index = 0; index < distances.length; index += 1) {
    if (remainingDistance <= distances[index]) {
      const fraction = distances[index] ? remainingDistance / distances[index] : 0;
      const endpoint = L.latLng(
        points[index].lat + (points[index + 1].lat - points[index].lat) * fraction,
        points[index].lng + (points[index + 1].lng - points[index].lng) * fraction
      );
      if (!endpoint.equals(prefix[prefix.length - 1])) prefix.push(endpoint);
      return prefix;
    }
    prefix.push(points[index + 1]);
    remainingDistance -= distances[index];
  }
  return prefix;
}

function distanceToRoute(point, route) {
  const metersPerDegree = 111_320;
  const longitudeScale = metersPerDegree * Math.cos(point.lat * Math.PI / 180);
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index];
    const end = route[index + 1];
    const startX = (start.lng - point.lng) * longitudeScale;
    const startY = (start.lat - point.lat) * metersPerDegree;
    const endX = (end.lng - point.lng) * longitudeScale;
    const endY = (end.lat - point.lat) * metersPerDegree;
    const segmentX = endX - startX;
    const segmentY = endY - startY;
    const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
    const fraction = segmentLengthSquared
      ? Math.max(0, Math.min(1, -(startX * segmentX + startY * segmentY) / segmentLengthSquared))
      : 0;
    nearestDistance = Math.min(nearestDistance, Math.hypot(
      startX + fraction * segmentX,
      startY + fraction * segmentY
    ));
  }
  return nearestDistance;
}

function renderStaticFallback(shipment) {
  try {
    const container = document.querySelector('#live-map');
    if (!container) return;
    const route = Array.isArray(shipment?.route) ? shipment.route.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)) : [];
    const gps = shipment?.currentLocation && Number.isFinite(shipment.currentLocation.latitude) && Number.isFinite(shipment.currentLocation.longitude)
      ? { lat: shipment.currentLocation.latitude, lng: shipment.currentLocation.longitude }
      : null;
    const points = route.length ? route.map(p => ({ lat: p.lat, lng: p.lng })) : (gps ? [gps] : []);
    if (points.length === 0) return;
    let minLat = Math.min(...points.map(p => p.lat));
    let maxLat = Math.max(...points.map(p => p.lat));
    let minLng = Math.min(...points.map(p => p.lng));
    let maxLng = Math.max(...points.map(p => p.lng));
    // Add padding
    const latPad = (maxLat - minLat) * 0.1 || 0.01;
    const lngPad = (maxLng - minLng) * 0.1 || 0.01;
    minLat -= latPad; maxLat += latPad; minLng -= lngPad; maxLng += lngPad;
    const width = 1000; const height = 600;
    function project(pt) {
      const x = ((pt.lng - minLng) / (maxLng - minLng || 1)) * width;
      const y = ((maxLat - pt.lat) / (maxLat - minLat || 1)) * height;
      return { x, y };
    }
    const routePoints = route.map(p => project({ lat: p.lat, lng: p.lng }));
    const polyPoints = routePoints.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
    const courierPoint = gps ? project(gps) : null;
    const origin = routePoints[0];
    const dest = routePoints[routePoints.length - 1];
    const svgParts = [];
    svgParts.push(`<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>`);
    svgParts.push(`<rect width='100%' height='100%' fill='#e6eef2'/>`);
    if (polyPoints) svgParts.push(`<polyline points='${polyPoints}' fill='none' stroke='#8799a6' stroke-width='12' stroke-linecap='round' stroke-linejoin='round' opacity='0.9'/>`);
    if (polyPoints) svgParts.push(`<polyline points='${polyPoints}' fill='none' stroke='#16a085' stroke-width='6' stroke-linecap='round' stroke-linejoin='round' opacity='0.95'/>`);
    if (origin) svgParts.push(`<circle cx='${origin.x}' cy='${origin.y}' r='8' fill='#ffffff' stroke='#16a085' stroke-width='3'/>`);
    if (dest) svgParts.push(`<circle cx='${dest.x}' cy='${dest.y}' r='8' fill='#ffffff' stroke='#8799a6' stroke-width='3'/>`);
    if (courierPoint) svgParts.push(`<circle cx='${courierPoint.x}' cy='${courierPoint.y}' r='10' fill='#16a085' opacity='0.95'/>`);
    svgParts.push(`</svg>`);
    const svg = svgParts.join('');
    const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

    // Remove any existing fallback overlay
    const existing = container.querySelector('.static-map-fallback');
    if (existing) existing.remove();

    const img = document.createElement('img');
    img.className = 'static-map-fallback';
    img.src = dataUrl;
    img.alt = 'Fallback static map showing estimated route and courier position';
    img.style.position = 'absolute';
    img.style.left = '0';
    img.style.top = '0';
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    img.style.pointerEvents = 'none';
    img.style.zIndex = '400';

    container.appendChild(img);
    if (mapEmptyState) { mapEmptyState.hidden = true; }
  } catch (e) {
    // swallow
  }
}

function renderMap(shipment, fitRoute) {
  initMapIfNeeded(); // map is lazy-created, so make sure it exists before we check it
  const route = Array.isArray(shipment.route)
    ? shipment.route.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    : [];
  const hasMapRoute = Boolean(map) && route.length > 1;
  document.querySelector(".map-card").classList.toggle("is-location-unavailable", !hasMapRoute);
  document.querySelectorAll(".map-zoom button").forEach((button) => {
    button.disabled = !hasMapRoute;
  });
  if (!map) {
    mapEmptyState.textContent = "The live map is temporarily unavailable. Shipment tracking is still active.";
    mapEmptyState.hidden = false;
    renderStaticFallback(shipment);
    return;
  }
  mapLayers.clearLayers();
  if (route.length < 2) {
    mapEmptyState.textContent = "The route is unavailable. Check the pickup and delivery locations.";
    mapEmptyState.hidden = false;
    return;
  }
  mapEmptyState.hidden = true;
  if (!tileLayer) addMapTileLayer();
  const points = route.map((point) => L.latLng(point.lat, point.lng));
  const statusIndex = deliveryStatuses.indexOf(shipment.status);
  const routeProgress = statusIndex < 0 ? 0 : statusIndex / (deliveryStatuses.length - 1);
  const traveledRoute = routePrefix(route, routeProgress);
  L.polyline(points, { color: "#fff", weight: 13, opacity: 0.96, lineCap: "round", lineJoin: "round" }).addTo(mapLayers);
  L.polyline(points, { color: "#73889a", weight: 4, opacity: 0.8, dashArray: "3 9", lineCap: "round", lineJoin: "round" }).addTo(mapLayers);
  if (traveledRoute.length > 1) {
    L.polyline(traveledRoute, { color: "#fff", weight: 12, opacity: 0.98, lineCap: "round", lineJoin: "round" }).addTo(mapLayers);
    L.polyline(traveledRoute, { color: "#e96c3c", weight: 6, opacity: 1, lineCap: "round", lineJoin: "round" }).addTo(mapLayers);
  }
  const originIcon = L.divIcon({ className: "map-point-icon", html: '<span class="route-origin-marker"></span>', iconSize: [26, 32], iconAnchor: [12, 29] });
  const destinationIcon = L.divIcon({
    className: `map-point-icon${shipment.status === "Delivered" ? " is-delivered" : ""}`,
    html: '<span class="route-destination-marker"></span>',
    iconSize: [26, 32],
    iconAnchor: [12, 29]
  });
  L.marker(points[0], { icon: originIcon }).bindTooltip(route[0].name || shipment.origin, { className: "route-tooltip route-tooltip-origin", direction: "top", offset: [0, -10] }).addTo(mapLayers);
  L.marker(points[points.length - 1], { icon: destinationIcon })
    .bindTooltip(shipment.status === "Delivered" ? "Delivered" : route.at(-1).name || shipment.destination, { className: "route-tooltip route-tooltip-destination", direction: "top", offset: [0, -10] })
    .addTo(mapLayers);
  const fallbackPosition = positionOnRoute(route, routeProgress);
  const gpsPosition = shipment.currentLocation &&
    Number.isFinite(shipment.currentLocation.latitude) &&
    Number.isFinite(shipment.currentLocation.longitude)
    ? L.latLng(shipment.currentLocation.latitude, shipment.currentLocation.longitude)
    : null;
  const courierPosition = shipment.status === "Delivered"
    ? points.at(-1)
    : gpsPosition || fallbackPosition;
  const markerState = shipment.status === "Delivered" ? "is-delivered" : gpsPosition ? "is-live" : "is-estimated";
  const courierIcon = L.divIcon({
    className: `courier-map-icon ${markerState}`,
    html: '<span class="courier-marker-pulse"></span><span class="courier-map-marker"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Z"/><circle cx="12" cy="9" r="2.3"/></svg></span>',
    iconSize: [42, 48],
    iconAnchor: [21, 26]
  });
  if (shipment.status !== "Delivered") {
    L.marker(courierPosition, { icon: courierIcon })
      .bindTooltip(gpsPosition ? "Courier GPS" : "Estimated courier position", {
        permanent: true,
        direction: "top",
        className: "courier-tooltip",
        offset: [0, -25]
      })
      .addTo(mapLayers);
  }
  if (fitRoute) fitShipmentRoute(shipment, points);
  requestAnimationFrame(() => map.invalidateSize({ pan: false }));
}

function fitShipmentRoute(shipment, routePoints) {
  if (!map || !routePoints?.length) return;
  const gpsPosition = shipment.currentLocation &&
    Number.isFinite(shipment.currentLocation.latitude) &&
    Number.isFinite(shipment.currentLocation.longitude)
    ? L.latLng(shipment.currentLocation.latitude, shipment.currentLocation.longitude)
    : null;
  if (gpsPosition && shipment.status !== "Delivered" && distanceToRoute(gpsPosition, routePoints) > 50_000) {
    map.setView(gpsPosition, 12);
    return;
  }
  const visiblePoints = gpsPosition && shipment.status !== "Delivered"
    ? [...routePoints, gpsPosition]
    : routePoints;
  map.fitBounds(L.latLngBounds(visiblePoints), { padding: [42, 42], maxZoom: 14 });
}


function renderShipment(shipment) {
  lastRenderedShipment = shipment;
  const isNewShipment = displayedTrackingNumber !== shipment.trackingNumber;
  displayedTrackingNumber = shipment.trackingNumber;
  document.querySelector("#shipment-recipient").textContent = shipment.recipient;
  document.querySelector("#recipient-avatar").textContent = recipientInitials(shipment.recipient);
  document.querySelector("#shipment-number").textContent = shipment.trackingNumber;
  document.querySelector("#shipment-origin").textContent = shipment.origin;
  document.querySelector("#shipment-destination").textContent = shipment.destination;
  document.querySelector("#shipment-status").textContent = shipment.status;
  document.querySelector("#shipment-status-pill").dataset.state = shipment.status.toLowerCase().replaceAll(" ", "-");
  document.querySelector("#shipment-eta").textContent = shipment.eta;
  document.querySelector("#shipment-service").textContent = shipment.service || "Standard delivery";
  document.querySelector("#shipment-updated").textContent = shipment.updatedAt ? formatTime(shipment.updatedAt) : "Waiting for update";
  const events = Array.isArray(shipment.events) ? shipment.events : [];
  const completedSteps = Math.max(deliveryStatuses.indexOf(shipment.status) + 1, 0);
  const progress = Math.round((completedSteps / deliveryStatuses.length) * 100);
  const progressBar = document.querySelector(".delivery-progress-track");
  progressBar.setAttribute("aria-valuenow", String(progress));
  document.querySelector("#shipment-progress-bar").style.width = `${progress}%`;
  document.querySelector("#shipment-progress-label").textContent = `${completedSteps} of ${deliveryStatuses.length} steps`;
  document.querySelector(".section-heading h2").textContent =
    shipment.status === "Delivered" ? "Safely delivered" : "On its way to you";
  const hasRoute = Array.isArray(shipment.route) && shipment.route.length > 1;
  document.querySelector("#tracking-mode").textContent = shipment.status === "Delivered" ? "DELIVERED" : shipment.currentLocation ? "COURIER GPS" : "SCAN UPDATES";
  document.querySelector(".map-header h3").textContent = shipment.status;
  document.querySelector(".map-header p").textContent = shipment.status === "Delivered"
    ? "Delivery completed at destination"
    : shipment.currentLocation?.label || (hasRoute ? "Estimated route · awaiting courier GPS" : "Location updates appear after pickup");
  document.querySelector("#map-tracking-mode").textContent =
    shipment.status === "Delivered" ? "DELIVERED" : shipment.currentLocation ? "COURIER GPS" : "ROUTE ESTIMATE";
  document.querySelector("#courier-location").textContent = shipment.status === "Delivered"
    ? "Delivered at destination"
    : shipment.currentLocation?.updatedAt
      ? `Updated ${formatTime(shipment.currentLocation.updatedAt)}`
      : hasRoute ? "Estimated position · awaiting GPS" : "Awaiting first location scan";
  document.querySelector("#courier-distance-label").textContent =
    shipment.status === "Delivered" ? "Delivered" : shipment.currentLocation?.label ? "Live GPS" : hasRoute ? "Route estimate" : "Awaiting location";
  renderMap(shipment, isNewShipment);
  updateTimeline(events, shipment.status);
}

function setShareButtonsState(enabled) {
  const isEnabled = Boolean(enabled && displayedTrackingNumber);
  if (shareTrackingButton) shareTrackingButton.disabled = !isEnabled;
  if (shareWhatsappButton) shareWhatsappButton.disabled = !isEnabled;
  if (printReceiptButton) printReceiptButton.disabled = !isEnabled;
}

async function trackShipment(trackingNumber, { silent = false } = {}) {
  const requestId = ++trackingRequestId;
  const normalized = normalizeTrackingNumber(trackingNumber);
  if (!isValidTrackingNumber(normalized)) {
    errorMessage.textContent = "Enter a valid delivery number using letters, numbers, spaces, or hyphens.";
    errorMessage.hidden = false;
    setShareButtonsState(normalized === displayedTrackingNumber);
    if (!silent) {
      trackButton.disabled = false;
      trackButton.innerHTML = 'Track package <span aria-hidden="true">→</span>';
    }
    return;
  }
  if (!silent) {
    errorMessage.hidden = true;
    setShareButtonsState(false);
    shareLinkMessage.textContent = "";
    trackButton.disabled = true;
    trackButton.innerHTML = "Finding your package…";
  }
  try {
    const response = await fetch(`/api/shipments/${encodeURIComponent(normalized)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Tracking information could not be loaded.");
    if (requestId !== trackingRequestId) return;
    if (lastRenderedShipment && lastRenderedShipment.trackingNumber === payload.trackingNumber && lastRenderedShipment.status !== payload.status) {
      showToast(`Status update: Shipment ${payload.trackingNumber} is now "${payload.status}"!`, "success");
    }
    renderShipment(payload);
    trackingInput.value = normalized;
    addRecentShipment(normalized);
    const shareUrl = new URL(window.location.href);
    shareUrl.searchParams.set("tracking", normalized);
    window.history.replaceState(window.history.state, "", shareUrl);
    setShareButtonsState(true);
    shareLinkMessage.textContent = "";
    errorMessage.hidden = true;
  } catch (error) {
    if (!silent && requestId === trackingRequestId) {
      errorMessage.textContent = error.message;
      errorMessage.hidden = false;
      setShareButtonsState(normalized === displayedTrackingNumber);
    }
  } finally {
    if (!silent && requestId === trackingRequestId) {
      trackButton.disabled = false;
      trackButton.innerHTML = 'Track package <span aria-hidden="true">→</span>';
    }
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  trackShipment(trackingInput.value);
});

shareTrackingButton.addEventListener("click", async () => {
  const trackingNumber = normalizeTrackingNumber(trackingInput.value);
  if (!isValidTrackingNumber(trackingNumber) || trackingNumber !== displayedTrackingNumber) {
    shareLinkMessage.textContent = "Track a shipment before sharing its link.";
    return;
  }
  const shareUrl = new URL(window.location.href);
  shareUrl.searchParams.set("tracking", trackingNumber);
  try {
    await navigator.clipboard.writeText(shareUrl.toString());
    shareLinkMessage.textContent = "Tracking link copied.";
    showToast("Tracking link copied to clipboard!", "success");
  } catch (error) {
    shareLinkMessage.textContent = "Could not copy the link. Check your browser permissions.";
    console.error("Could not copy tracking link:", error);
  }
});

if (shareWhatsappButton) {
  shareWhatsappButton.addEventListener("click", () => {
    const trackingNumber = normalizeTrackingNumber(trackingInput.value);
    if (!isValidTrackingNumber(trackingNumber) || trackingNumber !== displayedTrackingNumber) return;
    const shareUrl = new URL(window.location.href);
    shareUrl.searchParams.set("tracking", trackingNumber);
    const message = `Hello! You can track your Northstar Courier shipment (${trackingNumber}) here: ${shareUrl.toString()}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  });
}

if (printReceiptButton) {
  printReceiptButton.addEventListener("click", () => {
    window.print();
  });
}

const bookingForm = document.querySelector("#booking-form");
const bookingMessage = document.querySelector("#booking-message");
const createShipmentButton = document.querySelector("#create-shipment-button");
const bookingSuccessCard = document.querySelector("#booking-success-card");
const createdTrackingEl = document.querySelector("#created-tracking-number");
const createdSummaryEl = document.querySelector("#created-shipment-summary");
const createdTrackBtn = document.querySelector("#created-track-btn");
const createdWhatsappBtn = document.querySelector("#created-whatsapp-btn");
const createdCopyBtn = document.querySelector("#created-copy-btn");

bookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  bookingMessage.textContent = "";
  bookingMessage.classList.remove("booking-message-error");
  if (bookingSuccessCard) bookingSuccessCard.hidden = true;
  createShipmentButton.disabled = true;
  createShipmentButton.textContent = "Creating your shipment…";
  const formData = new FormData(bookingForm);
  try {
    const response = await fetch("/api/shipments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(formData))
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Your shipment could not be created.");
    bookingMessage.textContent = `Shipment created. Your tracking number is ${payload.trackingNumber}.`;
    bookingForm.reset();
    writeSavedShipment(payload.trackingNumber);
    addRecentShipment(payload.trackingNumber);
    trackingInput.value = payload.trackingNumber;

    if (bookingSuccessCard && createdTrackingEl) {
      createdTrackingEl.textContent = payload.trackingNumber;
      if (createdSummaryEl) {
        const costStr = payload.price ? ` · ${new Intl.NumberFormat("en-NG", { style: "currency", currency: payload.price.currency, maximumFractionDigits: 0 }).format(payload.price.amount)}` : "";
        createdSummaryEl.textContent = `To ${payload.recipient} (${payload.destination}) · ${payload.service}${costStr}`;
      }
      bookingSuccessCard.hidden = false;

      if (createdTrackBtn) {
        createdTrackBtn.onclick = () => {
          trackingInput.value = payload.trackingNumber;
          trackShipment(payload.trackingNumber);
          document.querySelector("#tracking").scrollIntoView({ behavior: "smooth" });
        };
      }
      if (createdWhatsappBtn) {
        createdWhatsappBtn.onclick = () => {
          const shareUrl = new URL(window.location.href);
          shareUrl.searchParams.set("tracking", payload.trackingNumber);
          const text = `Hello ${payload.recipient}, your delivery has been booked with Northstar Courier! Tracking number: ${payload.trackingNumber}. Follow it live here: ${shareUrl.toString()}`;
          window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer");
        };
      }
      if (createdCopyBtn) {
        createdCopyBtn.onclick = async () => {
          try {
            await navigator.clipboard.writeText(payload.trackingNumber);
            createdCopyBtn.textContent = "Copied!";
            showToast("Tracking code copied to clipboard!", "success");
            setTimeout(() => { createdCopyBtn.textContent = "Copy tracking number"; }, 2000);
          } catch {
            createdCopyBtn.textContent = "Could not copy";
          }
        };
      }
    }

    showToast(`Shipment ${payload.trackingNumber} successfully created!`, "success");
    await trackShipment(payload.trackingNumber);
  } catch (error) {
    bookingMessage.textContent = error.message || "We couldn’t connect. Please try again.";
    bookingMessage.classList.add("booking-message-error");
  } finally {
    createShipmentButton.disabled = false;
    createShipmentButton.innerHTML = 'Create shipment <span aria-hidden="true">→</span>';
  }
});

const supportForm = document.querySelector("#support-form");
const supportFormMessage = document.querySelector("#support-form-message");
const supportSubmitButton = document.querySelector("#support-submit-button");

supportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  supportFormMessage.textContent = "";
  supportFormMessage.classList.remove("booking-message-error");
  supportSubmitButton.disabled = true;
  supportSubmitButton.textContent = "Sending your message…";
  const formData = new FormData(supportForm);
  try {
    const response = await fetch("/api/support", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(formData))
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Your message could not be sent. Please try again.");
    supportForm.reset();
    supportFormMessage.textContent = "Your message has been sent to the Northstar support team. We’ll follow up by email.";
  } catch (error) {
    supportFormMessage.textContent = error.message || "We couldn’t connect. Please try again.";
    supportFormMessage.classList.add("booking-message-error");
  } finally {
    supportSubmitButton.disabled = false;
    supportSubmitButton.innerHTML = 'Send message <span aria-hidden="true">→</span>';
  }
});

document.querySelector("#zoom-in").addEventListener("click", () => {
  if (map) map.zoomIn();
});
document.querySelector("#zoom-out").addEventListener("click", () => {
  if (map) map.zoomOut();
});
document.querySelector("#fit-route").addEventListener("click", () => {
  const shipment = lastRenderedShipment;
  const route = Array.isArray(shipment?.route)
    ? shipment.route.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng))
    : [];
  if (shipment && map && route.length > 1) {
    fitShipmentRoute(shipment, route.map((point) => L.latLng(point.lat, point.lng)));
  }
});

const menuToggle = document.querySelector(".menu-toggle");
menuToggle.addEventListener("click", () => {
  const open = menuToggle.getAttribute("aria-expanded") !== "true";
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  document.querySelector(".nav-links").classList.toggle("open", open);
});
document.querySelectorAll(".nav-links a").forEach((link) => {
  link.addEventListener("click", () => {
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "Open menu");
    document.querySelector(".nav-links").classList.remove("open");
  });
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuToggle.getAttribute("aria-expanded") === "true") {
    menuToggle.setAttribute("aria-expanded", "false");
    menuToggle.setAttribute("aria-label", "Open menu");
    document.querySelector(".nav-links").classList.remove("open");
    menuToggle.focus();
  }
});

async function refreshShipment() {
  const trackingNumber = displayedTrackingNumber;
  if (trackingNumber && normalizeTrackingNumber(trackingInput.value) === trackingNumber) {
    await trackShipment(trackingNumber, { silent: true });
  }
}

// Pause polling when the tab is hidden to save bandwidth and battery
function scheduleRefresh() {
  setTimeout(async () => {
    if (!document.hidden) await refreshShipment();
    scheduleRefresh();
  }, 15_000);
}
scheduleRefresh();

const requestedTrackingNumber = new URLSearchParams(window.location.search).get("tracking");
// Which shipment to show on load: a shared ?tracking= link first, then the shipment this
// visitor created in this browser, then the sample shipment for everyone else.
async function showInitialShipment() {
  renderRecentShipments();
  if (requestedTrackingNumber) {
    trackingInput.value = requestedTrackingNumber;
    return trackShipment(requestedTrackingNumber);
  }
  const savedTrackingNumber = readSavedShipment();
  if (savedTrackingNumber) {
    try {
      const check = await fetch(`/api/shipments/${encodeURIComponent(savedTrackingNumber)}`);
      if (check.ok) {
        trackingInput.value = savedTrackingNumber;
        return trackShipment(savedTrackingNumber);
      }
      if (check.status === 404) clearSavedShipment();
    } catch { /* offline or server busy: fall back to the sample */ }
  }
  trackingInput.value = demoTrackingNumber;
  return trackShipment(demoTrackingNumber);
}
showInitialShipment();

// Debug overlay: visit the tracking page with ?debug=true on your phone to show diagnostics and copy them to clipboard
if (new URLSearchParams(window.location.search).get("debug") === "true") {
  (function showDebugOverlay() {
    const info = () => ({
      leaflet: !!window.L,
      leafletVersion: window.L && window.L.version ? window.L.version : null,
      tileSource: tileLayer && tileLayer.options ? tileLayer.options.url : null,
      tileCount: document.querySelectorAll('.leaflet-tile').length,
      mapEmptyHidden: !!(mapEmptyState && mapEmptyState.hidden),
      mapRect: (() => { try { const r = document.querySelector('#live-map')?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; } catch (e) { return null; } })(),
      location: location.href,
      online: navigator.onLine
    });

    const overlay = document.createElement('div');
    overlay.id = 'debug-overlay';
    overlay.style.position = 'fixed';
    overlay.style.right = '10px';
    overlay.style.bottom = '10px';
    overlay.style.zIndex = '99999';
    overlay.style.background = 'rgba(0,0,0,0.8)';
    overlay.style.color = '#fff';
    overlay.style.padding = '10px';
    overlay.style.borderRadius = '8px';
    overlay.style.fontSize = '12px';
    overlay.style.maxWidth = '320px';
    overlay.style.maxHeight = '60vh';
    overlay.style.overflow = 'auto';

    const pre = document.createElement('pre');
    pre.style.margin = '0 0 8px 0';
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-word';

    const btn = document.createElement('button');
    btn.textContent = 'Refresh debug info';
    btn.style.marginRight = '8px';
    btn.addEventListener('click', () => { pre.textContent = JSON.stringify(info(), null, 2); });

    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        copy.textContent = 'Copied';
        setTimeout(() => copy.textContent = 'Copy', 2000);
      } catch (e) {
        copy.textContent = 'Copy failed';
        setTimeout(() => copy.textContent = 'Copy', 2000);
      }
    });

    overlay.append(pre, btn, copy);
    document.body.appendChild(overlay);
    pre.textContent = JSON.stringify(info(), null, 2);
  })();
}
