# Lawn Bid

A homeowner submits a job request on a web page → the request texts every pro
in your local lawn care network → pros bid by replying to the text → the
backend picks the best bid and texts the homeowner (and the winning/losing
pros).

## How it works

1. **`public/index.html`** — the homeowner's form. Checkboxes for the job
   (mowing, edging, cleanup, etc.), notes, address, phone, and an optional
   photo upload.
2. Submitting the form sends a `POST /api/requests` to the backend, which
   saves the job to a local database.
3. The backend texts every active pro in your network (Twilio SMS) with a
   summary of the job and instructions to reply `BID <job#> <price>`.
4. When a pro replies, Twilio forwards that text to `POST /api/sms-inbound`,
   which parses the price and records the bid.
5. After a bidding window (30 minutes by default, configurable) the backend
   automatically picks the **lowest bid**, texts the homeowner the result,
   texts the winning pro the homeowner's contact info, and lets the other
   bidders know they didn't win. You can also pick a bid manually anytime
   before the window closes from the admin dashboard.
6. The homeowner also gets an immediate confirmation text the moment their
   request goes out — "We've texted our lawncare pros, expect a reply by
   [time]" — using the same close time from step 5, so they're not left
   wondering whether anything happened, especially on a long off-hours
   window.

## Run it locally

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000` for the homeowner form, and
`http://localhost:3000/admin.html` to manage your pro network and watch
jobs/bids come in.

**The admin dashboard requires a password.** Set `ADMIN_PASSWORD` (and
optionally `ADMIN_USERNAME`, default `admin`) in `.env` — your browser will
prompt for these credentials the first time you visit `/admin.html` or any
`/api/admin/*` route. If `ADMIN_PASSWORD` isn't set, admin access is refused
entirely rather than left open, so you'll need to set it even for local
testing.

**You don't need a Twilio account to try it out.** If the Twilio variables in
`.env` are left blank, the app runs in dev mode: instead of sending real
texts, it prints them to the server console, so you can see exactly what
would have been sent to whom.

## Going live with real text messages

1. Create a [Twilio](https://www.twilio.com) account and buy a phone number
   that supports SMS.
2. Fill in `.env`:
   ```
   TWILIO_ACCOUNT_SID=ACxxxxxxxx
   TWILIO_AUTH_TOKEN=xxxxxxxx
   TWILIO_FROM_NUMBER=+15551234567
   ```
3. Deploy the app somewhere with a public URL (Render, Railway, Fly.io, a
   VPS, etc.) — Twilio needs to reach your server to deliver incoming texts.
4. In the Twilio console, open your phone number's settings and set
   **"A message comes in"** to a webhook pointing at:
   ```
   https://your-domain.com/api/sms-inbound
   ```
5. Add your lawn care pros from the admin dashboard (name + phone number).
   That's your "local lawn care network" — add as many crews as you want.

That's it — submitting the homeowner form will now send real texts, and pro
replies will come back in as real bids.

## Adjusting how bidding works

- **Bidding window**: set `BID_WINDOW_MINUTES` in `.env` (default 30) — this
  is used when the job is submitted during business hours.
- **Off-hours window**: if a job comes in outside `BUSINESS_HOURS_START` /
  `BUSINESS_HOURS_END` (default 9am–6pm, server's local time), the window
  instead runs until **1 hour after the next opening time**. This matters
  most for a small pro network — texting everyone at 11pm with a 30-minute
  window means nobody sees it until morning, by which point it's long
  closed. Example: a job submitted at 11pm with a 9am opening closes at
  10am the next day (10 hours until 9am + 1 hour).
- **Soft close**: if a bid comes in within `SOFT_CLOSE_THRESHOLD_MINUTES` of
  the window closing (default 5), the close time pushes back by
  `SOFT_CLOSE_EXTENSION_MINUTES` (default 5) — same idea as an eBay auction,
  so a late bid on a small network isn't cut off before others get a chance
  to respond. This can repeat — every late bid pushes it out again — so a
  flurry of last-minute bids will keep extending until things quiet down.
- **Selection rule**: by default the lowest bid wins. To change this (e.g.
  favor a pro's rating, or the fastest reply), edit the `selectWinner()`
  function in `server.js` — the bids for a job are already loaded there,
  sorted by price.
- **Bid format**: pros reply with `BID <job#> <price>`, e.g. `BID 12 85`.
  The parser (in `/api/sms-inbound`) is forgiving of `#`, `$`, and punctuation
  around those two numbers.
- **Restarts**: if the server restarts while jobs are still open, it
  re-checks each one's stored close time on startup — a job whose window
  already passed gets resolved immediately, and one still in progress picks
  up with its original close time rather than resetting.

**A note on timezone**: business hours are evaluated using the server's
local system time. If you deploy somewhere with a different timezone than
your homeowners and pros, set the `TZ` environment variable on your host to
match (e.g. `TZ=America/Chicago`) so "9am" means what you expect.

## Project structure

```
lawn-bid/
├── public/
│   ├── index.html      # homeowner job request form
│   └── admin.html       # manage pros, view jobs & bids, override winner
├── server.js             # Express backend: requests, SMS, bidding logic
├── package.json
├── .env.example
└── data/lawnbid.db       # SQLite database (created automatically)
```

## Notes on the data model

- **`jobs`** — one row per homeowner request (services, address, phone,
  photo, status: `open` → `matched` or `expired`, plus `fee_amount` and
  `fee_paid` once a job is matched — see "Network fee" below).
- **`pros`** — your network of lawn care professionals (name, phone,
  active/paused).
- **`bids`** — one row per SMS bid received, linked to a job.
- **`support_messages`** — one row per customer service message submitted
  from the "Customer service" button on the homepage (name, address, phone,
  message, status: `new` → `resolved`). View and resolve these from the
  admin dashboard.

## Network fee

Winning pros owe a flat fee, tiered by their winning bid amount:

| Winning bid | Fee |
|---|---|
| Under $50 | $10 |
| $50–$100 | $20 |
| Over $100 | $30 |

The fee is mentioned in the "You won job #X!" text the pro receives — *"A
$20 network fee is due in 7 days."* — and tracked per job in the admin
dashboard (`fee_amount` / `fee_paid`). The app doesn't collect this fee
itself — you collect it directly (Venmo, Zelle, cash, PayPal, etc.) and mark
it paid in the admin dashboard once received. The enforcement lever is the
existing pause toggle on the pro network: a pro who doesn't pay can simply
be paused, which stops them from receiving future job broadcasts.

To change the fee tiers or amounts, edit `computeFeeAmount()` in
`server.js`.

### Optional: photo attached to the pro broadcast

If a homeowner uploads a photo and `PUBLIC_BASE_URL` is set, the job
broadcast to every pro in the network is sent as an MMS with that photo
attached, so pros can see the job before bidding — not just the eventual
winner. Without `PUBLIC_BASE_URL` set, the photo is still saved and visible
in the admin dashboard, it just isn't attached to the text (Twilio needs an
absolute, publicly reachable URL to fetch the image from — it can't reach
localhost or a relative path).

### Optional: QR code for payment

If you set `PAYMENT_LINK_TEMPLATE` and `PUBLIC_BASE_URL` in `.env`, the
winner's text becomes an MMS with a scannable QR code attached, linking
straight to a pre-filled payment page for that job's exact fee amount:

```
PAYMENT_LINK_TEMPLATE=https://paypal.me/YourName/{amount}
PUBLIC_BASE_URL=https://kirkwoodlawnfinder.com
```

Both PayPal.me and Cash App (`https://cash.app/$YourCashtag/{amount}`)
support a pre-filled dollar amount directly in the URL; Venmo's web links
don't reliably support this, so it isn't recommended here. The QR image
itself is generated on the fly at `/qr/fee/:jobId.png` — this route is
intentionally public (no admin login required), since Twilio fetches the
image itself and can't authenticate; it only ever exposes a payment link and
a dollar amount, nothing about the homeowner or the job. Leave both
variables blank to skip the QR code — the fee is still mentioned as plain
text in that case.

Photos are stored on disk under `/uploads` and served statically; for a
production deployment you'd likely swap this for S3 or similar object
storage, since most hosts don't persist local disk across deploys.
