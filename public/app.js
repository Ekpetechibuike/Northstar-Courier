const form = document.querySelector("#tracking-form");
const trackingInput = document.querySelector("#tracking-number");
const errorMessage = document.querySelector("#form-error");
const trackButton = document.querySelector("#track-button");
const shareTrackingButton = document.querySelector("#share-tracking");
const shareLinkMessage = document.querySelector("#share-link-message");
const timeline = document.querySelector("#timeline-list");
const mapEmptyState = document.querySelector("#map-empty-state");
const map = window.L ? L.map("live-map", { zoomControl: false, scrollWheelZoom: false }).setView([0, 0], 2) : null;
const mapLayers = map ? L.layerGroup().addTo(map) : null;
const mapViewport = document.querySelector("#map-viewport");
let tileLayer;
let tileSourceIndex = -1;
let tileLoadErrors = 0;
let displayedTrackingNumber;
let trackingRequestId = 0;
let mapResizeFrame = 0;

const demoTrackingNumber = "ST-8492-0317";
const deliveryStatuses = ["Order placed", "Picked up", "In transit", "Out for delivery", "Delivered"];
const mapTileSources = [
  {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  },
  {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    subdomains: "abcd",
    attribution: '&copy; OpenStreetMap contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
  }
];
const mapTilesUnavailableMessage = "Map tiles could not be loaded. Check your internet connection and try again.";

function addMapTileLayer() {
  tileSourceIndex += 1;
  tileLoadErrors = 0;
  const source = mapTileSources[tileSourceIndex];
  const sourceLayer = L.tileLayer(source.url, {
    maxZoom: 19,
    attribution: source.attribution,
    ...(source.subdomains ? { subdomains: source.subdomains } : {})
  }).addTo(map);
  tileLayer = sourceLayer;
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
  });
  tileLayer.on("tileload", () => {
    if (tileLayer !== sourceLayer) return;
    tileLoadErrors = 0;
    if (mapEmptyState.textContent === mapTilesUnavailableMessage) mapEmptyState.hidden = true;
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

function renderMap(shipment, fitRoute) {
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
    return;
  }
  mapLayers.clearLayers();
  if (route.length < 2) {
    mapEmptyState.textContent = "The route is unavailable. Check the pickup and delivery locations.";
    mapEmptyState.hidden = false;
    return;
  }
  if (!tileLayer) addMapTileLayer();
  mapEmptyState.hidden = true;
  const points = route.map((point) => L.latLng(point.lat, point.lng));
  const statusIndex = deliveryStatuses.indexOf(shipment.status);
  const routeProgress = statusIndex < 0 ? 0 : statusIndex / (deliveryStatuses.length - 1);
  const traveledRoute = routePrefix(route, routeProgress);
  L.polyline(points, { color: "#fff", weight: 9, opacity: 0.9, lineCap: "round", lineJoin: "round" }).addTo(mapLayers);
  L.polyline(points, { color: "#8799a6", weight: 4, opacity: 0.58, dashArray: "2 9", lineCap: "round", lineJoin: "round" }).addTo(mapLayers);
  if (traveledRoute.length > 1) {
    L.polyline(traveledRoute, { color: "#16a085", weight: 5, opacity: 0.96, lineCap: "round", lineJoin: "round" }).addTo(mapLayers);
  }
  const originIcon = L.divIcon({ className: "map-point-icon", html: '<span class="route-origin-marker"></span>', iconSize: [24, 32], iconAnchor: [12, 29] });
  const destinationIcon = L.divIcon({
    className: `map-point-icon${shipment.status === "Delivered" ? " is-delivered" : ""}`,
    html: '<span class="route-destination-marker"></span>',
    iconSize: [24, 32],
    iconAnchor: [12, 29]
  });
  L.marker(points[0], { icon: originIcon }).bindTooltip(route[0].name || shipment.origin).addTo(mapLayers);
  L.marker(points[points.length - 1], { icon: destinationIcon })
    .bindTooltip(shipment.status === "Delivered" ? "Delivered" : route.at(-1).name || shipment.destination)
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
  if (fitRoute) {
    if (gpsPosition && distanceToRoute(gpsPosition, points) > 50_000) {
      map.setView(gpsPosition, 12);
    } else {
      const visiblePoints = gpsPosition && shipment.status !== "Delivered" ? [...points, gpsPosition] : points;
      map.fitBounds(L.latLngBounds(visiblePoints), { padding: [35, 35], maxZoom: 14 });
    }
  }
  requestAnimationFrame(() => map.invalidateSize({ pan: false }));
}

if (map && mapViewport) {
  const resizeMap = () => {
    cancelAnimationFrame(mapResizeFrame);
    mapResizeFrame = requestAnimationFrame(() => map.invalidateSize({ pan: false }));
  };
  if ("ResizeObserver" in window) new ResizeObserver(resizeMap).observe(mapViewport);
  window.addEventListener("orientationchange", resizeMap);
  window.visualViewport?.addEventListener("resize", resizeMap);
}

function renderShipment(shipment) {
  const isNewShipment = displayedTrackingNumber !== shipment.trackingNumber;
  displayedTrackingNumber = shipment.trackingNumber;
  document.querySelector("#shipment-recipient").textContent = shipment.recipient;
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

async function trackShipment(trackingNumber, { silent = false } = {}) {
  const requestId = ++trackingRequestId;
  const normalized = normalizeTrackingNumber(trackingNumber);
  if (!isValidTrackingNumber(normalized)) {
    errorMessage.textContent = "Enter a valid delivery number using letters, numbers, spaces, or hyphens.";
    errorMessage.hidden = false;
    shareTrackingButton.disabled = !displayedTrackingNumber || normalized !== displayedTrackingNumber;
    if (!silent) {
      trackButton.disabled = false;
      trackButton.innerHTML = 'Track package <span aria-hidden="true">→</span>';
    }
    return;
  }
  if (!silent) {
    errorMessage.hidden = true;
    shareTrackingButton.disabled = true;
    shareLinkMessage.textContent = "";
    trackButton.disabled = true;
    trackButton.innerHTML = "Finding your package…";
  }
  try {
    const response = await fetch(`/api/shipments/${encodeURIComponent(normalized)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Tracking information could not be loaded.");
    if (requestId !== trackingRequestId) return;
    renderShipment(payload);
    trackingInput.value = normalized;
    const shareUrl = new URL(window.location.href);
    shareUrl.searchParams.set("tracking", normalized);
    window.history.replaceState(window.history.state, "", shareUrl);
    shareTrackingButton.disabled = false;
    shareLinkMessage.textContent = "";
    errorMessage.hidden = true;
  } catch (error) {
    if (!silent && requestId === trackingRequestId) {
      errorMessage.textContent = error.message;
      errorMessage.hidden = false;
      shareTrackingButton.disabled = !displayedTrackingNumber || normalized !== displayedTrackingNumber;
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
  } catch (error) {
    shareLinkMessage.textContent = "Could not copy the link. Check your browser permissions.";
    console.error("Could not copy tracking link:", error);
  }
});

const bookingForm = document.querySelector("#booking-form");
const bookingMessage = document.querySelector("#booking-message");
const createShipmentButton = document.querySelector("#create-shipment-button");

bookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  bookingMessage.textContent = "";
  bookingMessage.classList.remove("booking-message-error");
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
    trackingInput.value = payload.trackingNumber;
    await trackShipment(payload.trackingNumber);
    document.querySelector("#tracking").scrollIntoView({ behavior: "smooth" });
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

setInterval(refreshShipment, 15_000);

const requestedTrackingNumber = new URLSearchParams(window.location.search).get("tracking");
const initialTrackingNumber = requestedTrackingNumber || demoTrackingNumber;
trackingInput.value = initialTrackingNumber;
trackShipment(initialTrackingNumber);
