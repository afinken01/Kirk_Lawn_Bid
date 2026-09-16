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
   picks the **lowest bid** and texts the homeowner asking them to confirm
   it — "Reply Y to accept this bid, N to cancel the request." Nothing else
   happens yet: the winning pro isn't notified and losing bidders aren't
   told they lost until the homeowner responds. You can also pick a bid
   manually anytime before the window closes from the admin dashboard,
   which triggers the same confirmation step.
6. If the homeowner replies **Y**, the winning pro is texted the job details
   and network fee, and every other bidder is told the job went to someone
   else. If they reply **N**, the job is cancelled and every bidder is
   notified — no fee is ever assessed. If the homeowner doesn't reply within
   `CONFIRMATION_WINDOW_MINUTES` (2 hours by default), the job is
   automatically cancelled the same way, so it never hangs indefinitely. An
   admin can also short-circuit this from the dashboard with "Force
   confirm" or "Force cancel" — useful if the homeowner confirmed by phone
   instead of by text.
7. The homeowner also gets an immediate confirmation text the moment their
   request goes out — "We've texted our lawncare pros, expect a reply by
   [time]" — using the close time from step 5, so they're not left
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

### Alternative: SMS Gateway for Android (no Twilio account)

Instead of Twilio, you can use a spare Android phone with
[SMS Gateway for Android](https://github.com/capcom6/android-sms-gateway) as
the SMS sender. This backend is only used when the Twilio variables above
are left blank.

1. Install the app (APK from GitHub Releases, since it isn't on the Play
   Store — you'll need to allow installs from unknown sources and may need
   to temporarily disable Play Protect scanning).
2. In the app's Settings, choose **Public Cloud Server** mode. Credentials
   (a username and password) are generated automatically — no account
   signup required.
3. Log into [dashboard.sms-gate.app](https://dashboard.sms-gate.app) with
   those credentials and register a webhook for the `sms:received` event,
   pointing at:
   ```
   https://your-domain.com/api/sms-gateway-inbound
   ```
4. Fill in `.env`:
   ```
   SMS_GATEWAY_USERNAME=your-generated-username
   SMS_GATEWAY_PASSWORD=your-generated-password
   SMS_GATEWAY_SIGNING_KEY=your-signing-key
   ```
   The signing key is found in the app under Settings > Webhooks > Signing
   Key. It's optional but strongly recommended — without it, anyone who
   discovers your webhook URL could submit fake bids.

**Known limitation**: this backend doesn't support MMS. The QR-code payment
image and job photos attached to the pro broadcast will not be sent — the
app falls back to plain text (a payment link instead of a QR code image,
and no photo attachment) automatically, no configuration needed.

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
- **Homeowner confirmation**: once a bid is selected (automatically or by an
  admin), the homeowner has `CONFIRMATION_WINDOW_MINUTES` (default 120) to
  reply Y or N before the job is auto-cancelled. This applies to every
  selection path — the automatic close, and the admin dashboard's manual
  "Select" button — so nothing is finalized without the homeowner's
  explicit go-ahead. Admins can bypass this from the dashboard with "Force
  confirm" / "Force cancel" if the homeowner confirmed some other way (e.g.
  a phone call).
- **Bid format**: pros reply with `BID <job#> <price>`, e.g. `BID 12 85`.
  The parser (in `/api/sms-inbound`) is forgiving of `#`, `$`, and punctuation
  around those two numbers.
- **Opt-out language**: the first text a new phone number receives — the
  job broadcast to a pro, and the "thank you" confirmation to a homeowner —
  includes "Reply STOP to opt out," matching what's disclosed in
  `privacy.html`. Twilio numbers handle STOP/START/HELP automatically at the
  carrier level once A2P registration is complete; no code changes are
  needed to process those replies yourself.
- **Restarts**: if the server restarts while jobs are mid-flight, it
  re-checks each one's stored deadline on startup — both jobs still
  collecting bids and jobs waiting on a homeowner's Y/N reply. A deadline
  that already passed gets resolved immediately; one still in progress
  picks up with its original deadline rather than resetting.

**A note on timezone**: business hours are evaluated using the server's
local system time. If you deploy somewhere with a different timezone than
your homeowners and pros, set the `TZ` environment variable on your host to
match (e.g. `TZ=America/Chicago`) so "9am" means what you expect.

## Project structure

```
lawn-bid/
├── public/
│   ├── index.html       # homeowner job request form
│   ├── admin.html        # manage pros, view jobs & bids, override winner
│   ├── privacy.html      # privacy policy
│   └── terms.html        # terms and conditions
├── server.js              # Express backend: requests, SMS, bidding logic
├── package.json
├── .env.example
├── .gitignore
└── storage/               # SQLite database + uploaded photos (see below)
    ├── data/lawnbid.db
    └── uploads/
```

## Persistent storage (important for production)

By default, `storage/` lives on local disk. **On most hosts, including
Render's free/starter tier, local disk is wiped on every restart and
redeploy** — meaning every job, bid, pro, and signup request is lost each
time you deploy a change, unless you attach a persistent disk.

Both the database and uploaded photos live under one `storage/` folder
specifically so a single persistent disk can cover both — most hosts
(including Render) only support one disk per service, with one mount path.

**On Render**: go to your service > Disks > Add Disk, and set the mount
path to a subdirectory of your source code, e.g.
`/opt/render/project/src/storage` (Render does not allow mounting a disk at
the project root itself). Choose a size (1 GB is plenty to start). Render
redeploys automatically once the disk is attached, and takes an automatic
snapshot every 24 hours in case you ever need to restore.

If you'd rather store `storage/` somewhere else entirely, set the
`STORAGE_DIR` environment variable to an absolute path — this is also how
you'd point at a disk mounted somewhere other than the default location.

## Notes on the data model

- **`jobs`** — one row per homeowner request (services, address, phone,
  photo, status: `open` → `awaiting_confirmation` → `matched`, `cancelled`,
  or `expired`). `pending_bid_id` holds the tentatively selected bid while
  waiting on the homeowner's Y/N reply; `winning_bid_id` is only set once
  they confirm. `fee_amount` and `fee_paid` track the network fee — see
  "Network fee" below.
- **`pros`** — your network of lawn care professionals (name, phone, an
  optional email — used to send job photos, see below — and
  active/paused).
- **`bids`** — one row per SMS bid received, linked to a job.
- **`support_messages`** — one row per customer service message submitted
  from the "Customer service" button on the homepage (name, address, phone,
  message, status: `new` → `resolved`). View and resolve these from the
  admin dashboard.
- **`pro_signups`** — one row per request from the "Join our network of
  pros" button (business name, phone, an optional email, status: `new` →
  `added`). Emails you directly when submitted, and shows up in the admin
  dashboard with an "Add to network" button that quick-fills the existing
  pro-network form (including the email) so you don't have to retype
  anything.

## Email notifications

The "Join our network of pros" button on the homepage collects a business
name, phone number, and optional email, saves it to the database, and
emails you so you don't have to keep checking the dashboard. Configure it
with any SMTP provider in `.env`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=youraddress@gmail.com
SMTP_PASS=your-app-password
EMAIL_FROM=youraddress@gmail.com
EMAIL_TO=youraddress@gmail.com
```

For Gmail, `SMTP_PASS` needs to be an
[app password](https://myaccount.google.com/apppasswords), not your regular
Gmail password. Leave these blank to run in dev mode — signup requests are
still saved and visible in the admin dashboard, they just aren't emailed;
the email that would have been sent is printed to the server console
instead.

### Job photos via email (works with any SMS backend)

If a pro has an email address on file, they'll receive the job's photo as a
real email attachment instead of via MMS — this uses the same SMTP setup
above, so no additional configuration is needed. This matters because
Twilio is the only SMS backend here that supports MMS at all; SMS Gateway
for Android does not. Pros without an email on file still get a plain text
with no photo (or an MMS, if Twilio is configured and no email is on
file) — nothing breaks either way, the photo delivery method is just
decided per pro, automatically. Add a pro's email from the admin dashboard
or the "Join our network of pros" signup form.

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

Photos are stored under `storage/uploads` and served statically — see
"Persistent storage" above for why this needs a persistent disk in
production, and how to set one up.
