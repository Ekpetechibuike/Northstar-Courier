import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomInt, randomUUID, scrypt as scryptCallback, scryptSync, timingSafeEqual } from "node:crypto";

const root = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(root, "public");
const dataFile = resolve(root, "data", "shipments.json");
const supportInboxFile = resolve(root, "data", "support-inbox.json");
const port = Number(process.env.PORT || 3000);
const courierPortalPassword = process.env.COURIER_PORTAL_PASSWORD;
const courierPasswordSalt = randomBytes(16);
const courierSessionCookie = "northstar-courier-session";
const courierSessionLifetimeMs = 8 * 60 * 60 * 1000;
const maxBodyBytes = 16_384;
let mutationQueue = Promise.resolve();
let supportInboxQueue = Promise.resolve();
const rateLimits = new Map();
const rateLimitWindowMs = 60_000;
const courierSessions = new Map();
const geocodingRequestIntervalMs = 1_100;
let geocodingQueue = Promise.resolve();
let lastGeocodingRequestAt = 0;
const pendingRouteLookups = new Map();

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8"
};

// The sample shipment shown to visitors who have not booked anything. It is built in, so it
// is always available even when the data folder is empty or reset (for example after a redeploy).
const demoShipment = {
  "trackingNumber": "ST-8492-0317",
  "recipient": "Jordan Lee",
  "origin": "Brooklyn, NY",
  "destination": "Manhattan, NY",
  "status": "Delivered",
  "eta": "Today, 2:30 PM \u2013 4:30 PM",
  "service": "Express delivery",
  "updatedAt": "2026-10-11T04:56:59.447Z",
  "route": [
    {
      "name": "Brooklyn",
      "lat": 40.6782,
      "lng": -73.9442
    },
    {
      "name": "Downtown Brooklyn",
      "lat": 40.6936,
      "lng": -73.9897
    },
    {
      "name": "Manhattan Bridge",
      "lat": 40.7075,
      "lng": -73.9903
    },
    {
      "name": "Lower Manhattan",
      "lat": 40.7131,
      "lng": -74.0062
    }
  ],
  "progress": 1,
  "events": [
    {
      "status": "Order placed",
      "location": "Brooklyn, NY",
      "timestamp": "2026-10-08T14:12:00.000Z",
      "completed": true
    },
    {
      "status": "Picked up",
      "location": "Brooklyn, NY",
      "timestamp": "2026-10-08T16:48:00.000Z",
      "completed": true
    },
    {
      "status": "In transit",
      "location": "New York Distribution Center",
      "timestamp": "2026-10-09T04:16:00.000Z",
      "completed": true
    },
    {
      "status": "Out for delivery",
      "location": "Manhattan, NY",
      "timestamp": "2026-10-10T09:24:00.000Z",
      "completed": true
    },
    {
      "status": "Delivered",
      "location": "Manhattan, NY",
      "timestamp": "2026-10-10T16:55:40.475Z",
      "completed": true
    }
  ],
  "currentLocation": {
    "latitude": 6.471238,
    "longitude": 7.526633,
    "label": "Courier GPS location",
    "updatedAt": "2026-10-11T04:56:59.447Z"
  }
};

function withDemoShipment(store) {
  if (!store || !Array.isArray(store.shipments)) store = { shipments: [] };
  if (!store.shipments.some((item) => item.trackingNumber === demoShipment.trackingNumber)) {
    store.shipments.push(structuredClone(demoShipment));
  }
  return store;
}

async function loadStore() {
  try {
    return withDemoShipment(JSON.parse(await readFile(dataFile, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return withDemoShipment({ shipments: [] });
  }
}

function saveStore(store) {
    const temporaryFile = `${dataFile}.${randomUUID()}.tmp`;
  return writeFile(temporaryFile, `${JSON.stringify(store, null, 2)}\n`, "utf8")
    .then(() => rename(temporaryFile, dataFile));
}

function mutateStore(mutate) {
  const operation = mutationQueue.then(async () => {
    const store = await loadStore();
    const { result, persist = true } = await mutate(store);
    if (persist) await saveStore(store);
    return result;
  });
  mutationQueue = operation.catch(() => {});
  return operation;
}

async function loadSupportInbox() {
  try {
    const inbox = JSON.parse(await readFile(supportInboxFile, "utf8"));
    if (!inbox || !Array.isArray(inbox.messages)) throw new Error("Support inbox data must contain a messages array.");
    return inbox;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { messages: [] };
  }
}

function mutateSupportInbox(mutate) {
  const operation = supportInboxQueue.then(async () => {
    const inbox = await loadSupportInbox();
    const { result, persist = true } = await mutate(inbox);
    if (persist) {
      const temporaryFile = `${supportInboxFile}.${randomUUID()}.tmp`;
      await writeFile(temporaryFile, `${JSON.stringify(inbox, null, 2)}\n`, "utf8");
      await rename(temporaryFile, supportInboxFile);
    }
    return result;
  });
  supportInboxQueue = operation.catch(() => {});
  return operation;
}

function json(response, status, payload) {
  if (response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    let tooLarge = false;
    request.on("data", (chunk) => {
      if (tooLarge) return;
      if (Buffer.byteLength(body) + chunk.length > maxBodyBytes) {
        tooLarge = true;
        body = "";
      } else {
        body += chunk;
      }
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        return;
      }
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function passwordMeetsStrengthRequirements(password) {
  if (typeof password !== "string" || password.length < 16 || password.length > 1024) return false;
  const categories = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password)
  ];
  return categories.filter(Boolean).length >= 3;
}

function getCourierSessionToken(request) {
  const cookies = request.headers.cookie;
  if (typeof cookies !== "string") return null;
  const cookie = cookies.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${courierSessionCookie}=`));
  if (!cookie) return null;
  const token = cookie.slice(courierSessionCookie.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function hasCourierSession(request) {
  const token = getCourierSessionToken(request);
  if (!token) return false;
  const expiresAt = courierSessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    courierSessions.delete(token);
    return false;
  }
  return true;
}

function hasTrustedOrigin(request) {
  const origin = request.headers.origin;
  if (typeof origin !== "string") return true;
  try {
    return new URL(origin).host.toLowerCase() === String(request.headers.host || "").toLowerCase();
  } catch {
    return false;
  }
}

function isAdmin(request) {
  return hasCourierSession(request) && hasTrustedOrigin(request);
}

const courierPasswordHash = passwordMeetsStrengthRequirements(courierPortalPassword)
  ? scryptSync(courierPortalPassword, courierPasswordSalt, 64)
  : null;

function getSessionCookie(request, token) {
  const secure = request.socket.encrypted || process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${courierSessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${courierSessionLifetimeMs / 1000}${secure}`;
}

function clearSessionCookie(request) {
  const secure = request.socket.encrypted || process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${courierSessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

function compareCourierPassword(password) {
  return new Promise((resolvePassword, rejectPassword) => {
    scryptCallback(password, courierPasswordSalt, 64, (error, derivedKey) => {
      if (error) {
        rejectPassword(error);
        return;
      }
      resolvePassword(Boolean(courierPasswordHash) && timingSafeEqual(derivedKey, courierPasswordHash));
    });
  });
}

function validateShipment(input) {
  const required = ["recipient", "origin", "destination"];
  if (!input || typeof input !== "object" || Array.isArray(input)) return "A JSON object is required.";
  for (const field of required) {
    if (typeof input[field] !== "string" || input[field].trim().length < 2 || input[field].trim().length > 120) {
      return `${field} must be between 2 and 120 characters.`;
    }
  }
  return null;
}

function createTrackingNumber(shipments) {
  let trackingNumber;
  do {
    trackingNumber = `ST-${randomInt(1000, 10_000)}-${randomInt(1000, 10_000)}`;
  } while (shipments.some((shipment) => shipment.trackingNumber === trackingNumber));
  return trackingNumber;
}

function normalizeTrackingNumber(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function isValidTrackingNumber(value) {
  return /^[A-Z0-9](?:[A-Z0-9 -]{0,62}[A-Z0-9])?$/.test(value);
}

function validateSupportMessage(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "A JSON object is required.";
  const fields = [
    ["name", input.name, 2, 120],
    ["email", input.email, 5, 254],
    ["subject", input.subject, 3, 120],
    ["message", input.message, 10, 5000]
  ];
  for (const [name, value, minLength, maxLength] of fields) {
    if (typeof value !== "string" || value.trim().length < minLength || value.trim().length > maxLength) {
      return `${name} must be between ${minLength} and ${maxLength} characters.`;
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    return "Enter a valid email address so the support team can reply.";
  }
  if (!["Shipment status", "Delivery issue", "Billing", "Other"].includes(input.topic)) {
    return "Choose a valid support topic.";
  }
  if (typeof input.trackingNumber !== "string" ||
      (input.trackingNumber.trim() && !isValidTrackingNumber(normalizeTrackingNumber(input.trackingNumber)))) {
    return "Enter a valid tracking number, or leave that field empty.";
  }
  return null;
}

function hasRoute(shipment) {
  return Array.isArray(shipment.route) && shipment.route.length > 1 &&
    shipment.route.every((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

const geocodingUserAgent = process.env.GEOCODER_USER_AGENT || "NorthstarCourier/1.0 (https://northstar-courier.onrender.com)";
const geocodingCache = new Map();

function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 &&
    Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

// Each provider returns { lat, lng } or null (address not found). It throws if the service itself fails.
const geocodingProviders = [
  {
    name: "Nominatim",
    async lookup(address) {
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      url.searchParams.set("q", address);
      const response = await fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": geocodingUserAgent, "Referer": "https://northstar-courier.onrender.com/" },
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const results = await response.json();
      if (!Array.isArray(results)) throw new Error("Invalid response");
      if (results.length === 0) return null;
      const lat = Number(results[0]?.lat);
      const lng = Number(results[0]?.lon);
      if (!validCoordinates(lat, lng)) throw new Error("Invalid coordinates");
      return { lat, lng };
    }
  },
  {
    name: "Photon",
    async lookup(address) {
      const url = new URL("https://photon.komoot.io/api/");
      url.searchParams.set("limit", "1");
      url.searchParams.set("q", address);
      const response = await fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": geocodingUserAgent },
        signal: AbortSignal.timeout(8_000)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!body || !Array.isArray(body.features)) throw new Error("Invalid response");
      if (body.features.length === 0) return null;
      const [lng, lat] = body.features[0]?.geometry?.coordinates || [];
      if (!validCoordinates(Number(lat), Number(lng))) throw new Error("Invalid coordinates");
      return { lat: Number(lat), lng: Number(lng) };
    }
  }
];

function geocodeAddress(address, label) {
  const cacheKey = address.trim().toLowerCase().replace(/\s+/g, " ");
  const cached = geocodingCache.get(cacheKey);
  if (cached) return Promise.resolve({ name: address, lat: cached.lat, lng: cached.lng });

  const operation = geocodingQueue.then(async () => {
    const waitMs = geocodingRequestIntervalMs - (Date.now() - lastGeocodingRequestAt);
    if (waitMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
    lastGeocodingRequestAt = Date.now();

    let anyProviderAnswered = false;
    for (const provider of geocodingProviders) {
      try {
        const found = await provider.lookup(address);
        anyProviderAnswered = true;
        if (found) {
          if (geocodingCache.size > 500) geocodingCache.delete(geocodingCache.keys().next().value);
          geocodingCache.set(cacheKey, found);
          return { name: address, lat: found.lat, lng: found.lng };
        }
      } catch (error) {
        console.error(`Geocoding with ${provider.name} failed for the ${label} location:`, error.message);
      }
    }
    if (anyProviderAnswered) {
      throw Object.assign(new Error(`We couldn't find the ${label} location on the map. Try adding a city, region, or country.`), { status: 422 });
    }
    throw Object.assign(new Error("OpenStreetMap location lookup is unavailable. Please try again shortly."), { status: 503 });
  });
  geocodingQueue = operation.catch(() => {});
  return operation;
}

async function geocodeRoute(origin, destination) {
  return [
    await geocodeAddress(origin, "pickup"),
    await geocodeAddress(destination, "delivery")
  ];
}

async function ensureShipmentRoute(shipment) {
  if (hasRoute(shipment)) return shipment;
  const pendingLookup = pendingRouteLookups.get(shipment.trackingNumber);
  if (pendingLookup) return pendingLookup;

  const lookup = (async () => {
    const route = await geocodeRoute(shipment.origin, shipment.destination);
    return mutateStore((store) => {
      const storedShipment = store.shipments.find((item) => item.trackingNumber === shipment.trackingNumber);
      if (!storedShipment) {
        return { persist: false, result: null };
      }
      if (!hasRoute(storedShipment)) storedShipment.route = route;
      return { result: storedShipment };
    });
  })();
  pendingRouteLookups.set(shipment.trackingNumber, lookup);
  try {
    return await lookup;
  } finally {
    pendingRouteLookups.delete(shipment.trackingNumber);
  }
}

function enforceRateLimit(request, response, bucket, limit) {
  const now = Date.now();
  const address = request.socket.remoteAddress || "unknown";
  const key = `${address}:${bucket}`;
  const current = rateLimits.get(key);
  if (!current || now >= current.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + rateLimitWindowMs });
  } else if (current.count >= limit) {
    response.setHeader("Retry-After", String(Math.ceil((current.resetAt - now) / 1000)));
    json(response, 429, { error: "Too many requests. Please try again shortly." });
    return false;
  } else {
    current.count += 1;
  }
  if (rateLimits.size > 10_000) {
    for (const [entryKey, entry] of rateLimits) {
      if (now >= entry.resetAt) rateLimits.delete(entryKey);
    }
  }
  return true;
}

async function handleRequest(request, response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://*.tile.openstreetmap.org; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (process.env.NODE_ENV === "production") {
    response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return json(response, 400, { error: "Invalid URL path." });
  }

  if (path.startsWith("/api/")) {
    response.setHeader("Cache-Control", "no-store");
    const bucket = request.method === "POST" && path === "/api/courier/login" ? "login" :
      request.method === "POST" && path === "/api/support" ? "support" :
      request.method === "POST" && path === "/api/shipments" ? "create" : "api";
    const limit = bucket === "login" || bucket === "support" ? 5 : bucket === "create" ? 10 : 120;
    if (!enforceRateLimit(request, response, bucket, limit)) return;
  }

  if (path === "/api/support" && request.method === "POST") {
    const input = await readBody(request);
    const validationError = validateSupportMessage(input);
    if (validationError) return json(response, 400, { error: validationError });
    if (typeof input.company === "string" && input.company.trim()) {
      return json(response, 400, { error: "Your message could not be submitted. Please try again." });
    }
    const supportMessage = await mutateSupportInbox((inbox) => {
      const message = {
        id: randomUUID(),
        name: input.name.trim(),
        email: input.email.trim(),
        topic: input.topic,
        subject: input.subject.trim(),
        trackingNumber: normalizeTrackingNumber(input.trackingNumber),
        message: input.message.trim(),
        status: "new",
        createdAt: new Date().toISOString()
      };
      inbox.messages.push(message);
      return { result: message };
    });
    return json(response, 201, { received: true, id: supportMessage.id });
  }

  if (path === "/api/courier/support" || path.startsWith("/api/courier/support/")) {
    if (!isAdmin(request)) return json(response, 401, { error: "An active courier administrator session is required." });

    if (path === "/api/courier/support" && request.method === "GET") {
      const inbox = await loadSupportInbox();
      const messages = [...inbox.messages].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      return json(response, 200, { messages });
    }

    const supportMessageMatch = path.match(/^\/api\/courier\/support\/([0-9a-f-]{36})$/i);
    if (!supportMessageMatch) return json(response, 404, { error: "Support message not found." });
    const messageId = supportMessageMatch[1];

    if (request.method === "PATCH") {
      const input = await readBody(request);
      if (!input || !["new", "resolved"].includes(input.status)) {
        return json(response, 400, { error: "Choose a valid support status." });
      }
      const result = await mutateSupportInbox((inbox) => {
        const message = inbox.messages.find((item) => item.id === messageId);
        if (!message) return { persist: false, result: { statusCode: 404, payload: { error: "Support message not found." } } };
        message.status = input.status;
        message.updatedAt = new Date().toISOString();
        return { result: { statusCode: 200, payload: message } };
      });
      return json(response, result.statusCode, result.payload);
    }

    if (request.method === "DELETE") {
      const result = await mutateSupportInbox((inbox) => {
        const index = inbox.messages.findIndex((item) => item.id === messageId);
        if (index < 0) return { persist: false, result: { statusCode: 404, payload: { error: "Support message not found." } } };
        inbox.messages.splice(index, 1);
        return { result: { statusCode: 200, payload: { deleted: true } } };
      });
      return json(response, result.statusCode, result.payload);
    }

    response.setHeader("Allow", "GET, PATCH, DELETE");
    return json(response, 405, { error: "Method not allowed." });
  }

  if (request.method === "GET" && path === "/api/courier/session") {
    const authenticated = hasCourierSession(request);
    return json(response, 200, { authenticated });
  }

  if (request.method === "POST" && path === "/api/courier/login") {
    if (!passwordMeetsStrengthRequirements(courierPortalPassword)) {
      return json(response, 503, { error: "Courier portal login is not configured. Ask the administrator to set a strong COURIER_PORTAL_PASSWORD of at least 16 characters using at least three character types." });
    }
    const input = await readBody(request);
    if (!input || typeof input.password !== "string" || input.password.length > 1024) {
      return json(response, 400, { error: "Enter the courier portal password." });
    }
    if (!await compareCourierPassword(input.password)) {
      return json(response, 401, { error: "The courier portal password is incorrect." });
    }
    const token = randomBytes(32).toString("hex");
    courierSessions.set(token, Date.now() + courierSessionLifetimeMs);
    if (courierSessions.size > 10_000) {
      for (const [sessionToken, expiresAt] of courierSessions) {
        if (expiresAt <= Date.now()) courierSessions.delete(sessionToken);
      }
    }
    response.setHeader("Set-Cookie", getSessionCookie(request, token));
    return json(response, 200, { authenticated: true });
  }

  if (request.method === "POST" && path === "/api/courier/logout") {
    const token = getCourierSessionToken(request);
    if (token) courierSessions.delete(token);
    response.setHeader("Set-Cookie", clearSessionCookie(request));
    return json(response, 200, { authenticated: false });
  }

  if (request.method === "GET" &&
      ["/courier.html", "/courier.js", "/courier-login.html", "/courier-login.js"].includes(path)) {
    response.setHeader("Cache-Control", "no-store");
    if ((path === "/courier.html" || path === "/courier.js") && !hasCourierSession(request)) {
      const trackingNumber = url.searchParams.get("tracking");
      const loginUrl = new URL("/courier-login.html", url);
      if (trackingNumber && isValidTrackingNumber(normalizeTrackingNumber(trackingNumber))) {
        loginUrl.searchParams.set("tracking", normalizeTrackingNumber(trackingNumber));
      }
      response.writeHead(302, { Location: `${loginUrl.pathname}${loginUrl.search}`, "Cache-Control": "no-store" });
      response.end();
      return;
    }
  }

  if (request.method === "GET" && path === "/api/health") {
    return json(response, 200, { status: "ok", timestamp: new Date().toISOString() });
  }

  if (request.method === "GET" && path.startsWith("/api/shipments/")) {
    const trackingNumber = normalizeTrackingNumber(path.slice("/api/shipments/".length));
    if (!isValidTrackingNumber(trackingNumber)) {
      return json(response, 400, { error: "Enter a valid delivery number using letters, numbers, spaces, or hyphens." });
    }
    const store = await loadStore();
    let shipment = store.shipments.find((item) => normalizeTrackingNumber(item.trackingNumber) === trackingNumber);
    if (!shipment) return json(response, 404, { error: "We couldn't find that tracking number." });
    if (!hasRoute(shipment)) shipment = await ensureShipmentRoute(shipment);
    if (!shipment) return json(response, 404, { error: "We couldn't find that tracking number." });
    return json(response, 200, shipment);
  }

  if (request.method === "POST" && path === "/api/shipments") {
    const input = await readBody(request);
    const validationError = validateShipment(input);
    if (validationError) return json(response, 400, { error: validationError });
    const origin = input.origin.trim();
    const destination = input.destination.trim();
    const route = await geocodeRoute(origin, destination);
    const now = new Date().toISOString();
    const shipment = await mutateStore((store) => {
      const createdShipment = {
        trackingNumber: createTrackingNumber(store.shipments),
        recipient: input.recipient.trim(),
        origin,
        destination,
        status: "Order placed",
        eta: "Estimated delivery will be confirmed soon",
        service: "Standard delivery",
        updatedAt: now,
        progress: 0,
        route,
        currentLocation: null,
        events: [{ status: "Order placed", location: input.origin.trim(), timestamp: now, completed: true }]
      };
      store.shipments.push(createdShipment);
      return { result: createdShipment };
    });
    return json(response, 201, shipment);
  }

  if (request.method === "PATCH" && path.startsWith("/api/shipments/") && path.endsWith("/location")) {
    if (!isAdmin(request)) return json(response, 401, { error: "A valid admin API key is required." });
    const trackingNumber = normalizeTrackingNumber(path.slice("/api/shipments/".length, -"/location".length));
    const input = await readBody(request);
    const validLatitude = Number.isFinite(input.latitude) && input.latitude >= -90 && input.latitude <= 90;
    const validLongitude = Number.isFinite(input.longitude) && input.longitude >= -180 && input.longitude <= 180;
    if (!validLatitude || !validLongitude || typeof input.location !== "string" ||
        input.location.trim().length < 2 || input.location.trim().length > 120) {
      return json(response, 400, { error: "Provide valid latitude, longitude, and location values." });
    }
    const result = await mutateStore((store) => {
      const shipment = store.shipments.find((item) => item.trackingNumber === trackingNumber);
      if (!shipment) {
        return { persist: false, result: { statusCode: 404, payload: { error: "We couldn't find that tracking number." } } };
      }
      shipment.currentLocation = {
        latitude: input.latitude,
        longitude: input.longitude,
        label: input.location.trim(),
        updatedAt: new Date().toISOString()
      };
      shipment.updatedAt = shipment.currentLocation.updatedAt;
      return { result: { statusCode: 200, payload: shipment } };
    });
    return json(response, result.statusCode, result.payload);
  }

  if (request.method === "PATCH" && path.startsWith("/api/shipments/")) {
    if (!isAdmin(request)) return json(response, 401, { error: "A valid admin API key is required." });
    const trackingNumber = normalizeTrackingNumber(path.slice("/api/shipments/".length));
    const input = await readBody(request);
    const allowedStatuses = ["Order placed", "Picked up", "In transit", "Out for delivery", "Delivered"];
    if (!allowedStatuses.includes(input.status) || typeof input.location !== "string" ||
        input.location.trim().length < 2 || input.location.trim().length > 120) {
      return json(response, 400, { error: "Provide a valid shipment status and location." });
    }
    const result = await mutateStore((store) => {
      const shipment = store.shipments.find((item) => item.trackingNumber === trackingNumber);
      if (!shipment) {
        return { persist: false, result: { statusCode: 404, payload: { error: "We couldn't find that tracking number." } } };
      }
      const nextIndex = allowedStatuses.indexOf(input.status);
      const currentIndex = allowedStatuses.indexOf(shipment.status);
      if (nextIndex < currentIndex || nextIndex > currentIndex + 1) {
        return { persist: false, result: { statusCode: 409, payload: { error: "Shipment statuses must advance one step at a time." } } };
      }
      const now = new Date().toISOString();
      shipment.status = input.status;
      shipment.updatedAt = now;
      shipment.progress = nextIndex / (allowedStatuses.length - 1);
      shipment.currentLocation = null;
      shipment.events = allowedStatuses.slice(0, nextIndex + 1).map((status, index) => ({
        status,
        location: status === input.status ? input.location.trim() : shipment.events[index]?.location || shipment.origin,
        timestamp: status === input.status ? now : shipment.events[index]?.timestamp || now,
        completed: true
      })).concat(allowedStatuses.slice(nextIndex + 1).map((status) => ({
        status,
        location: status === "Delivered" ? "Your doorstep" : shipment.destination,
        timestamp: null,
        completed: false
      })));
      return { result: { statusCode: 200, payload: shipment } };
    });
    return json(response, result.statusCode, result.payload);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD, POST, PATCH");
    return json(response, 405, { error: "Method not allowed." });
  }

  const relativePath = path === "/" ? "index.html" : normalize(path.replace(/^\/+/, ""));
  const assetRoot = publicRoot;
  const filePath = resolve(assetRoot, relativePath);
  if (filePath !== assetRoot && !filePath.startsWith(`${assetRoot}${sep}`)) {
    return json(response, 403, { error: "Access denied." });
  }
  try {
    let file = await readFile(filePath);
    const extension = extname(filePath);
    if ([".html", ".js", ".css"].includes(extension)) {
      response.setHeader("Cache-Control", "no-cache");
    } else if ([".png", ".svg"].includes(extension)) {
      response.setHeader("Cache-Control", "public, max-age=604800");
    }
    const headers = { "Content-Type": mimeTypes[extension] || "application/octet-stream" };
    const compressible = [".html", ".js", ".css", ".svg", ".json", ".txt", ".xml"].includes(extension);
    if (compressible && file.length > 1024 && /\bgzip\b/.test(request.headers["accept-encoding"] || "")) {
      file = gzipSync(file);
      headers["Content-Encoding"] = "gzip";
    }
    headers["Vary"] = "Accept-Encoding";
    headers["Content-Length"] = file.length;
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : file);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") return json(response, 404, { error: "Page not found." });
    throw error;
  }
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error("Request failed:", error);
    if (!response.headersSent) json(response, error.status || 500, { error: error.status ? error.message : "An internal server error occurred." });
    else response.destroy();
  });
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.on("request", (_request, response) => {
  response.on("finish", () => {
    if (response.statusCode >= 500) console.error(`Request failed with status ${response.statusCode}.`);
  });
});

server.listen(port, () => {
  if (!passwordMeetsStrengthRequirements(courierPortalPassword)) {
    console.warn("Courier portal sign-in is disabled until COURIER_PORTAL_PASSWORD is set to a strong password.");
  }
  console.log(`Northstar Courier is running at http://localhost:${port}`);
});

server.on("error", (error) => {
  console.error("Server failed to start:", error);
  process.exitCode = 1;
});
