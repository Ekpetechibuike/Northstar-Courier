# Northstar Courier upgrade notes

## 1. Keep your data safe (pick ONE)

The server now saves shipments and support messages in one of three places, in this order:

1. **Postgres**, if the `DATABASE_URL` environment variable is set (best choice).
2. **Files in `DATA_DIR`**, if `DATA_DIR` is set. On Render, add a Persistent Disk (paid plans), mount it at `/var/data`, and set `DATA_DIR=/var/data`.
3. **Files in `./data`** (the old behaviour; Render's free plan wipes these on every redeploy).

### Postgres on Render
1. Render dashboard > New > PostgreSQL. Create it in the same region as your web service.
2. Open the database and copy its **Internal Database URL**.
3. Open your web service > Environment > add `DATABASE_URL` with that URL. Save.
4. Make sure Render runs `npm install` when building (Build Command: `npm install`).

The first start creates the table automatically. Note: Render's free Postgres expires after a limited period, so use a paid database for real customer data.

## 2. Booking form and pricing
Edit the numbers in the `pricing` block near the top of the shipment code in `server.js` (look for "EDIT THESE NUMBERS"). The estimate shown to customers comes from there.

## 3. WhatsApp and call buttons, footer details
Fill in your details at the top of `public/site.js`. Buttons and footer lines stay hidden until you do.

## 4. Pictures
- The hero background is `public/hero.svg`. To use a photo instead, add `public/hero.jpg` and change `hero.svg` to `hero.jpg` in the `.hero::before` rule at the end of `public/styles.css`.
- The picture shown when your link is shared is `public/og-image.png` (1200 x 630). Replace it with your own if you like.

## 6. Stop the site sleeping and use your own domain
- `https://YOUR-SITE/healthz` always answers "ok". Point a free monitor (UptimeRobot, 5-minute interval) at it to keep the free instance awake, or set `KEEP_AWAKE=true` in Render's Environment.
- Custom domain: Render > your service > Settings > Custom Domains > Add. Create the DNS record Render shows you at your domain registrar. Afterwards, search `public/index.html`, `public/robots.txt` and `public/sitemap.xml` for `northstar-courier.onrender.com` and replace it with your new domain.

## 7. Dark mode
It follows the visitor's phone or computer setting automatically.
