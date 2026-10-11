const deliveryStatuses = ["Order placed", "Picked up", "In transit", "Out for delivery", "Delivered"];
const lookupForm = document.querySelector("#courier-lookup-form");
const trackingNumberInput = document.querySelector("#courier-tracking-number");
const lookupButton = document.querySelector("#courier-lookup-button");
const lookupMessage = document.querySelector("#courier-lookup-message");
const logoutButton = document.querySelector("#courier-logout");
const inboxCount = document.querySelector("#courier-inbox-count");
const inboxRefreshButton = document.querySelector("#courier-inbox-refresh");
const inboxFilter = document.querySelector("#courier-inbox-filter");
const inboxMessage = document.querySelector("#courier-inbox-message");
const inboxList = document.querySelector("#courier-inbox-list");
const shipmentPanel = document.querySelector("#courier-shipment-panel");
const statusForm = document.querySelector("#courier-status-form");
const statusSelect = document.querySelector("#courier-next-status");
const statusLocationInput = document.querySelector("#courier-status-location");
const statusButton = document.querySelector("#courier-status-button");
const statusMessage = document.querySelector("#courier-status-message");
const locationForm = document.querySelector("#courier-location-form");
const latitudeInput = document.querySelector("#courier-latitude");
const longitudeInput = document.querySelector("#courier-longitude");
const gpsLabelInput = document.querySelector("#courier-gps-label");
const useGpsButton = document.querySelector("#courier-use-gps");
const locationButton = document.querySelector("#courier-location-button");
const locationMessage = document.querySelector("#courier-location-message");

let activeShipment = null;
let supportMessages = [];

function setMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle("courier-message-error", isError);
}

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });
  } catch (error) {
    throw new Error("Could not connect to the courier service. Check your connection and try again.");
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("The courier service returned an invalid response. Please try again.");
  }
  if (!response.ok) {
    if (response.status === 401) {
      window.location.replace("/courier-login.html");
      throw new Error("Your portal session has expired. Sign in again to continue.");
    }
    throw new Error(payload.error || "The shipment update could not be completed.");
  }
  return payload;
}

function renderSupportInbox() {
  const newCount = supportMessages.filter((message) => message.status === "new").length;
  inboxCount.textContent = `${newCount} new`;
  inboxList.replaceChildren();

  const filteredMessages = supportMessages.filter((message) =>
    inboxFilter.value === "all" || message.status === inboxFilter.value);
  if (filteredMessages.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "courier-inbox-empty";
    emptyState.textContent = inboxFilter.value === "all"
      ? "No customer support messages yet."
      : `No ${inboxFilter.value} support messages.`;
    inboxList.append(emptyState);
    return;
  }

  for (const message of filteredMessages) {
    const card = document.createElement("article");
    card.className = `courier-inbox-message${message.status === "new" ? " is-new" : ""}`;

    const heading = document.createElement("div");
    heading.className = "courier-inbox-message-heading";
    const titleGroup = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = message.subject;
    const meta = document.createElement("p");
    meta.className = "courier-inbox-meta";
    const replyLink = document.createElement("a");
    replyLink.href = `mailto:${encodeURIComponent(message.email)}?subject=${encodeURIComponent(`Re: ${message.subject}`)}`;
    replyLink.textContent = `${message.name} · ${message.email}`;
    meta.append(replyLink);
    const receivedDate = document.createElement("span");
    receivedDate.textContent = new Date(message.createdAt).toLocaleString();
    meta.append(receivedDate);
    titleGroup.append(title, meta);

    const status = document.createElement("span");
    status.className = `courier-inbox-status is-${message.status}`;
    status.textContent = message.status === "new" ? "New" : "Resolved";
    heading.append(titleGroup, status);

    const details = document.createElement("p");
    details.className = "courier-inbox-details";
    details.textContent = `${message.topic}${message.trackingNumber ? ` · Tracking ${message.trackingNumber}` : ""}`;

    const body = document.createElement("p");
    body.className = "courier-inbox-body";
    body.textContent = message.message;

    const actions = document.createElement("div");
    actions.className = "courier-inbox-actions";
    const statusButton = document.createElement("button");
    statusButton.type = "button";
    statusButton.dataset.action = "status";
    statusButton.dataset.messageId = message.id;
    statusButton.dataset.status = message.status === "new" ? "resolved" : "new";
    statusButton.textContent = message.status === "new" ? "Mark resolved" : "Reopen";
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "courier-inbox-delete";
    deleteButton.dataset.action = "delete";
    deleteButton.dataset.messageId = message.id;
    deleteButton.textContent = "Delete";
    actions.append(statusButton, deleteButton);
    card.append(heading, details, body, actions);
    inboxList.append(card);
  }
}

async function refreshSupportInbox() {
  inboxRefreshButton.disabled = true;
  setMessage(inboxMessage, "");
  try {
    const payload = await apiRequest("/api/courier/support");
    supportMessages = payload.messages;
    renderSupportInbox();
  } catch (error) {
    setMessage(inboxMessage, error.message, true);
  } finally {
    inboxRefreshButton.disabled = false;
  }
}

function renderShipment(shipment) {
  activeShipment = shipment;
  document.querySelector("#courier-current-status").textContent = shipment.status;
  document.querySelector("#courier-detail-tracking").textContent = shipment.trackingNumber;
  document.querySelector("#courier-detail-recipient").textContent = shipment.recipient;
  document.querySelector("#courier-detail-origin").textContent = shipment.origin;
  document.querySelector("#courier-detail-destination").textContent = shipment.destination;

  const currentIndex = deliveryStatuses.indexOf(shipment.status);
  const nextStatus = deliveryStatuses[currentIndex + 1];
  statusSelect.replaceChildren();
  const option = document.createElement("option");
  option.value = nextStatus || "";
  option.textContent = nextStatus || "Delivery complete";
  statusSelect.append(option);
  statusSelect.disabled = !nextStatus;
  statusLocationInput.disabled = !nextStatus;
  statusButton.disabled = !nextStatus;
  statusButton.textContent = nextStatus ? `Mark as ${nextStatus}` : "Delivery complete";
  const lastScanLocation = shipment.events?.slice().reverse().find((event) => event.completed)?.location || shipment.origin;
  statusLocationInput.value = nextStatus === "Picked up" ? shipment.origin :
    nextStatus === "Delivered" ? shipment.destination : shipment.currentLocation?.label || lastScanLocation;

  const currentLocation = shipment.currentLocation;
  if (currentLocation) {
    latitudeInput.value = String(currentLocation.latitude);
    longitudeInput.value = String(currentLocation.longitude);
    gpsLabelInput.value = currentLocation.label;
  } else {
    latitudeInput.value = "";
    longitudeInput.value = "";
    gpsLabelInput.value = "";
  }

  shipmentPanel.hidden = false;
  setMessage(statusMessage, nextStatus
    ? `Next step: ${nextStatus}. Update it when the courier completes that scan.`
    : "This shipment has been delivered.");
  setMessage(locationMessage, currentLocation
    ? `Last GPS update: ${new Date(currentLocation.updatedAt).toLocaleString()}.`
    : "No courier GPS has been sent for this shipment yet.");
}

lookupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const trackingNumber = trackingNumberInput.value.trim().toUpperCase();
  setMessage(lookupMessage, "");
  setMessage(statusMessage, "");
  setMessage(locationMessage, "");
  lookupButton.disabled = true;
  lookupButton.textContent = "Loading shipment…";
  try {
    const shipment = await apiRequest(`/api/shipments/${encodeURIComponent(trackingNumber)}`);
    renderShipment(shipment);
    setMessage(lookupMessage, `Loaded ${shipment.trackingNumber}. Updates are protected by your portal session.`);
  } catch (error) {
    activeShipment = null;
    shipmentPanel.hidden = true;
    setMessage(lookupMessage, error.message, true);
  } finally {
    lookupButton.disabled = false;
    lookupButton.innerHTML = 'Load shipment <span aria-hidden="true">→</span>';
  }
});

inboxRefreshButton.addEventListener("click", refreshSupportInbox);
inboxFilter.addEventListener("change", renderSupportInbox);
inboxList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, messageId, status } = button.dataset;
  if (!messageId) return;
  if (action === "delete" && !window.confirm("Permanently delete this support message?")) return;
  button.disabled = true;
  setMessage(inboxMessage, "");
  try {
    const response = await apiRequest(`/api/courier/support/${encodeURIComponent(messageId)}`, {
      method: action === "delete" ? "DELETE" : "PATCH",
      ...(action === "status" ? { body: JSON.stringify({ status }) } : {})
    });
    if (action === "delete" && !response.deleted) throw new Error("The support message could not be deleted.");
    await refreshSupportInbox();
    setMessage(inboxMessage, action === "delete" ? "Support message deleted." : `Support message marked ${status}.`);
  } catch (error) {
    setMessage(inboxMessage, error.message, true);
    button.disabled = false;
  }
});

logoutButton.addEventListener("click", async () => {
  logoutButton.disabled = true;
  try {
    const response = await fetch("/api/courier/logout", { method: "POST" });
    if (!response.ok) throw new Error("The server could not end your session. Please try again.");
    window.location.replace("/courier-login.html");
  } catch (error) {
    setMessage(lookupMessage, error.message || "Could not sign out. Check your connection and try again.", true);
    logoutButton.disabled = false;
  }
});

statusForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeShipment) return;
  statusButton.disabled = true;
  setMessage(statusMessage, "");
  try {
    const shipment = await apiRequest(`/api/shipments/${encodeURIComponent(activeShipment.trackingNumber)}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: statusSelect.value,
        location: statusLocationInput.value.trim()
      })
    });
    renderShipment(shipment);
    setMessage(statusMessage, `Shipment advanced to ${shipment.status}. The tracking page will refresh within 15 seconds.`);
  } catch (error) {
    setMessage(statusMessage, error.message, true);
    statusButton.disabled = !deliveryStatuses[deliveryStatuses.indexOf(activeShipment.status) + 1];
  }
});

locationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeShipment) return;
  locationButton.disabled = true;
  setMessage(locationMessage, "");
  try {
    const shipment = await apiRequest(`/api/shipments/${encodeURIComponent(activeShipment.trackingNumber)}/location`, {
      method: "PATCH",
      body: JSON.stringify({
        latitude: Number(latitudeInput.value),
        longitude: Number(longitudeInput.value),
        location: gpsLabelInput.value.trim()
      })
    });
    renderShipment(shipment);
    setMessage(locationMessage, `Courier GPS updated at ${new Date(shipment.currentLocation.updatedAt).toLocaleTimeString()}.`);
  } catch (error) {
    setMessage(locationMessage, error.message, true);
  } finally {
    locationButton.disabled = false;
  }
});

useGpsButton.addEventListener("click", () => {
  setMessage(locationMessage, "");
  if (!navigator.geolocation) {
    setMessage(locationMessage, "This device or browser does not support GPS. Enter the coordinates manually.", true);
    return;
  }
  useGpsButton.disabled = true;
  useGpsButton.textContent = "Getting device location…";
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      latitudeInput.value = coords.latitude.toFixed(6);
      longitudeInput.value = coords.longitude.toFixed(6);
      if (!gpsLabelInput.value.trim()) gpsLabelInput.value = "Courier GPS location";
      setMessage(locationMessage, "Device location captured. Send the location update to publish it to tracking.");
      useGpsButton.disabled = false;
      useGpsButton.textContent = "Use this device's GPS";
    },
    (error) => {
      const message = error.code === error.PERMISSION_DENIED
        ? "Location permission was denied. Allow location access or enter the coordinates manually."
        : error.code === error.TIMEOUT
          ? "The device took too long to get a location. Try again or enter coordinates manually."
          : "Could not get the device location. Enter the coordinates manually or try again.";
      setMessage(locationMessage, message, true);
      useGpsButton.disabled = false;
      useGpsButton.textContent = "Use this device's GPS";
    },
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 }
  );
});

const requestedTrackingNumber = new URLSearchParams(window.location.search).get("tracking");
if (requestedTrackingNumber) {
  trackingNumberInput.value = requestedTrackingNumber;
  lookupForm.requestSubmit();
}

refreshSupportInbox();
setInterval(refreshSupportInbox, 60_000);
