# Northstar Courier

A responsive courier tracking site backed by a Node.js service. Customers can create shipments on the site, receive a tracking number, and follow status and courier GPS updates on an OpenStreetMap map. Leaflet's runtime assets are bundled under `public/vendor/leaflet` so they are included in both Node.js and static-site deployments. OpenStreetMap tiles are loaded from OpenStreetMap. Pickup and delivery locations are geocoded with OpenStreetMap Nominatim so the map can show an estimated straight-line route; this estimate is not live courier GPS or road routing. Shipment details refresh every 15 seconds; customers can share a direct tracking link with `?tracking=ST-0000-0000`.

## Run locally

Requires Node.js 18 or newer.

```sh
npm start
```

Open [http://localhost:3000](http://localhost:3000). The sample shipment is `ST-8492-0317`. Shipment records are persisted in `data/shipments.json`. Support requests submitted on the site are saved in `data/support-inbox.json`.

### Courier portal access and updates

The courier portal and its update endpoints are locked until the administrator sets `COURIER_PORTAL_PASSWORD`. It must be at least 16 characters and contain characters from at least three of these groups: lowercase letters, uppercase letters, numbers, and symbols. Generate a strong random password in PowerShell:

```powershell
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$env:COURIER_PORTAL_PASSWORD = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$rng.Dispose()
npm start
```

To see and share the password with authorized staff, run `Write-Host $env:COURIER_PORTAL_PASSWORD` in the same PowerShell session. Open [http://localhost:3000/courier-login.html](http://localhost:3000/courier-login.html) and sign in. The password is stored only in the server environment, not in source files or browser storage. Successful sign-in creates an eight-hour, HTTP-only session; restarting the server ends active sessions. Set the password again in each new PowerShell session before starting the server. The courier portal includes a private support inbox where staff can read, reply to, resolve, and delete customer messages. Use HTTPS for remote access; browser GPS requires HTTPS or localhost. Keep the password private.

## API

- `GET /api/health` — service health and server timestamp.
- `GET /api/shipments/:trackingNumber` — shipment and scan-event timeline.
- `POST /api/shipments` — create a shipment with `recipient`, `origin`, and `destination` string fields. Both locations must be found by OpenStreetMap Nominatim before the shipment is saved. Limited to 10 requests per minute per client address.
- `POST /api/support` — submit a customer support request with `name`, `email`, `topic`, `subject`, `message`, and an optional `trackingNumber`. Limited to 5 submissions per minute per client address.
- `POST /api/courier/login` — authenticate using the configured portal password and start a staff session. Limited to 5 attempts per minute per client address.
- `GET /api/courier/session` and `POST /api/courier/logout` — check or end the staff session.
- `GET /api/courier/support` — list support messages. Requires an active courier portal session.
- `PATCH /api/courier/support/:messageId` and `DELETE /api/courier/support/:messageId` — resolve/reopen or delete a message. Require an active courier portal session.
- `PATCH /api/shipments/:trackingNumber` — advance one delivery status, with `status` and `location` fields. Requires an active courier portal session.
- `PATCH /api/shipments/:trackingNumber/location` — update courier GPS coordinates using `latitude`, `longitude`, and `location` fields. The tracking page polls for updates every 15 seconds. Requires an active courier portal session.

New tracking numbers use the format `ST-0000-0000`. Tracking lookup accepts delivery numbers of up to 64 letters, numbers, spaces, or hyphens and matches them against shipments stored by this website; numbers from external carriers need a corresponding shipment record here. Shipment status changes must advance in order: Order placed, Picked up, In transit, Out for delivery, Delivered. Leaflet assets are served from `public/vendor/leaflet`; map tiles use OpenStreetMap. When courier GPS is unavailable, the map estimates the marker's position along the route from the current delivery stage (pickup, in transit, out for delivery, or destination); this is an estimate, not a live courier location. When live GPS is available, the map includes it in the initial view; if it is far from the planned route, the map centers on the courier so the location remains visible. Advancing a shipment status clears the previous GPS fix so the map follows the new delivery stage until fresh coordinates are submitted. Delivered shipments are always shown at the destination. Older shipments without route coordinates are geocoded the first time they are tracked. Geocoding requests are serialized and spaced at least 1.1 seconds apart to respect the Nominatim usage policy. Creating or tracking shipments sends their pickup and delivery location text to Nominatim; see its [usage policy](https://operations.osmfoundation.org/policies/nominatim/). The JSON store is written atomically and serializes writes within the server process.

API requests are not cached and are rate-limited to 120 requests per minute per client address (shipment creation, support submissions, and portal login have their stricter limits above). Courier page files, the support inbox, and shipment update endpoints require a password-configured session. Support messages contain customer contact information and are stored privately in `data/support-inbox.json`; only signed-in courier staff can read or manage them. Session cookies are HttpOnly and SameSite=Strict, last up to eight hours, are held in server memory, and courier write requests must have a matching request origin. Configure a strong `COURIER_PORTAL_PASSWORD` and keep it private.

Example:

```sh
curl -X POST http://localhost:3000/api/shipments ^
  -H "Content-Type: application/json" ^
  -d "{\"recipient\":\"Alex Morgan\",\"origin\":\"Queens, NY\",\"destination\":\"Manhattan, NY\"}"
```

For deployment, set `PORT` and a strong, secret `COURIER_PORTAL_PASSWORD`; serve the site over HTTPS and store the data directory on persistent storage. The included JSON persistence serializes updates in one Node.js process and is intended for a single-instance deployment. Use a transactional database before running multiple server instances.
