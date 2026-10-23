# Tropical Smoothie Cafe Tempe — website

The site lets customers do three things on your own site, without leaving it:

- **Order food**: add items to a bag, check out for in-café or curbside pickup, and watch the order's status update live.
- **Reserve a table**: pick a date, party size and an open time. They get a confirmation code right away.
- **Contact you**: send a message at any time. They can also call or text.

Your staff handle all of this at `/admin`.

## Run it

```bash
python3 server.py
```

- Open http://localhost:5178 to see the site.
- Open http://localhost:5178/admin for the staff dashboard.
- The dashboard key is in `data/admin_key.txt`. It's created the first time the server starts. You can choose your own by setting `ADMIN_KEY`.

The server needs only Python 3.9 or newer. There's nothing extra to install.

## Before going live

1. **Prices.** Edit `data/menu.json`. The prices there are **samples**. Replace every one with your real prices. The tax rate is 8.1%, but check it with your accountant. Changes take effect without restarting the server.
2. **Email alerts** (optional). To get an email for every new order, reservation or message, set these:
   `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `NOTIFY_EMAIL`.
3. **Hosting.** Use any host that runs Python, such as Render, Railway, Fly.io or a small VPS. Give it a persistent disk for `data/` and put HTTPS in front of it.
4. **Card payments (Stripe).** See the "Card payments" section below. Until you set a Stripe key, orders are pay-at-pickup.
5. **Brand approval.** As a franchise, get corporate's approval for a separate ordering and reservation site and for the logo use.

## Card payments

Customers pay by card when they place an order, on Stripe's secure checkout page. Card details never touch your server. The order only appears on the staff dashboard after payment goes through. Cancelling a paid order on the dashboard refunds the card automatically.

**Setup**

1. Create a Stripe account at https://dashboard.stripe.com/register and finish the business details.
2. Start with **test mode**. Go to *Developers → API keys* and copy the **Secret key** (`sk_test_...`).
3. Set up a webhook so payments are confirmed even if a customer closes the page right after paying:
   - Go to *Developers → Webhooks → Add endpoint*.
   - URL: `https://YOUR-SITE/api/stripe/webhook`
   - Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`
   - Copy the **Signing secret** (`whsec_...`).
4. Start the server with these settings:
   ```bash
   STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... PUBLIC_URL=https://YOUR-SITE python3 server.py
   ```
   On startup the server prints `Card payments: ON via Stripe (TEST mode)`.
5. Place a test order with card `4242 4242 4242 4242`, any future expiry date and any CVC.
6. When it works, switch to the **live** keys (`sk_live_...`) and the live webhook secret.

Optional: turn on Apple Pay and Google Pay in Stripe under *Settings → Payment methods*. They then appear on the checkout page automatically.

Keep the secret keys out of code and out of git. Set them as environment variables in your host's settings.

## Files

| File | What it is |
|------|------------|
| `server.py` | The web server and API. Data is saved to SQLite in `data/tsc.db`. |
| `data/menu.json` | Menu items, prices, tax rate and prep time |
| `public/index.html`, `styles.css`, `script.js` | The website customers see |
| `public/admin.html`, `admin.js` | The staff dashboard |
| `public/assets/logo.png` | The logo, with a transparent background |

Store hours are set in `HOURS` in `server.py`, and also in the hours table in `public/index.html`. Reservation limits are set by the `RES_*` constants in `server.py`.
