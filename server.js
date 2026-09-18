require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const BID_WINDOW_MINUTES = parseFloat(process.env.BID_WINDOW_MINUTES || '60');
const BUSINESS_HOURS_START = parseInt(process.env.BUSINESS_HOURS_START || '9', 10);  // 24hr, e.g. 9 = 9am
const BUSINESS_HOURS_END = parseInt(process.env.BUSINESS_HOURS_END || '18', 10);     // 24hr, e.g. 18 = 6pm
const PRO_NOTIFICATION_HOLD_HOUR = parseInt(process.env.PRO_NOTIFICATION_HOLD_HOUR || '8', 10); // 24hr, e.g. 8 = 8am
const SOFT_CLOSE_THRESHOLD_MINUTES = parseFloat(process.env.SOFT_CLOSE_THRESHOLD_MINUTES || '5');
const SOFT_CLOSE_EXTENSION_MINUTES = parseFloat(process.env.SOFT_CLOSE_EXTENSION_MINUTES || '5');
const CONFIRMATION_WINDOW_MINUTES = parseFloat(process.env.CONFIRMATION_WINDOW_MINUTES || '120');
const TWILIO_ENABLED = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);
const SMS_GATEWAY_ENABLED = !TWILIO_ENABLED && !!(process.env.SMS_GATEWAY_USERNAME && process.env.SMS_GATEWAY_PASSWORD);
const EMAIL_ENABLED = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.EMAIL_TO);

// ---------- Twilio client (falls back to console logging if not configured) ----------
let twilioClient = null;
if (TWILIO_ENABLED) {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} else if (SMS_GATEWAY_ENABLED) {
  console.warn('[sms] Using SMS Gateway for Android (sms-gate.app) — no MMS/photo support with this backend.');
} else {
  console.warn('[sms] No SMS backend configured — running in DEV MODE. Texts will be logged to the console instead of sent.');
}

// mediaUrl (optional) sends an MMS with an image attached — e.g. a QR code
// for a payment link. Only supported on Twilio; SMS Gateway for Android has
// no outbound MMS support, so mediaUrl is silently ignored on that backend
// (the calling code already falls back to a plain-text payment link when no
// QR image is available, so nothing breaks — the QR just never appears).
// Retries a transient failure (network error, 5xx, or 429 rate-limit) a
// couple of times with a short backoff before giving up — a brief outage
// on the SMS provider's end (like a Cloudflare 520) shouldn't silently
// drop a job notification or bid confirmation. Doesn't retry 4xx errors
// (bad auth, invalid number, etc.) since those won't succeed on retry.
async function withRetry(fn, delaysMs = [3000, 8000]) {
  const attempts = delaysMs.length + 1;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status || err.statusCode || (err.response && err.response.status);
      const isRetryable = !status || status >= 500 || status === 429;
      if (!isRetryable || i === attempts - 1) throw err;
      console.warn(`[sms] Retryable error (${status || 'network'}), retrying in ${delaysMs[i]}ms... (attempt ${i + 2}/${attempts})`);
      await new Promise(resolve => setTimeout(resolve, delaysMs[i]));
    }
  }
}

const SMS_GATEWAY_BASE_URL = process.env.SMS_GATEWAY_BASE_URL || 'https://api.sms-gate.app';

async function sendSMS(to, body, mediaUrl) {
  if (twilioClient) {
    try {
      await withRetry(async () => {
        const params = { to, from: process.env.TWILIO_FROM_NUMBER, body };
        if (mediaUrl) params.mediaUrl = [mediaUrl];
        await twilioClient.messages.create(params);
      });
    } catch (err) {
      console.error(`[sms] Failed to send to ${to} after retries:`, err.message);
    }
  } else if (SMS_GATEWAY_ENABLED) {
    try {
      await withRetry(async () => {
        const res = await fetch(`${SMS_GATEWAY_BASE_URL}/3rdparty/v1/messages?skipPhoneValidation=true`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Basic ' + Buffer.from(
              `${process.env.SMS_GATEWAY_USERNAME}:${process.env.SMS_GATEWAY_PASSWORD}`
            ).toString('base64'),
          },
          body: JSON.stringify({
            textMessage: { text: body },
            phoneNumbers: [to],
          }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          const err = new Error(`SMS Gateway responded ${res.status}: ${errText.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }
      });
    } catch (err) {
      console.error(`[sms] SMS Gateway failed to send to ${to} after retries:`, err.message);
    }
  } else {
    console.log(`\n[DEV SMS] -> ${to}\n${body}${mediaUrl ? `\n[MMS image attached] ${mediaUrl}` : ''}\n`);
  }
}

// ---------- Email (falls back to console logging if not configured) ----------
// Works with any SMTP provider — Gmail with an app password, or a
// transactional email service. No provider lock-in.
let emailTransporter = null;
if (EMAIL_ENABLED) {
  emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
} else {
  console.warn('[email] SMTP env vars not set — running in DEV MODE. Emails will be logged to the console instead of sent.');
}

async function sendEmail(subject, text) {
  if (emailTransporter) {
    try {
      await emailTransporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.SMTP_USER,
        to: process.env.EMAIL_TO,
        subject,
        text,
      });
    } catch (err) {
      console.error('[email] Failed to send:', err.message);
    }
  } else {
    console.log(`\n[DEV EMAIL] -> ${process.env.EMAIL_TO || '(no EMAIL_TO set)'}\nSubject: ${subject}\n${text}\n`);
  }
}

// Emails a job photo to a specific pro (not to you — this uses the pro's
// own email address). Unlike MMS, this works regardless of which SMS
// backend is active, since it doesn't depend on Twilio or any texting
// provider at all — attaches the file directly from local disk.
async function sendJobPhotoEmail(toEmail, job, localPhotoPath) {
  const subject = `Photo for job #${job.id}`;
  const text = `Here's a photo of the yard for job #${job.id} (${JSON.parse(job.services).join(', ')} at ${job.address}). Reply to the text message you received with your bid.`;

  if (emailTransporter) {
    try {
      await emailTransporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.SMTP_USER,
        to: toEmail,
        subject,
        text,
        attachments: [{ filename: path.basename(localPhotoPath), path: localPhotoPath }],
      });
    } catch (err) {
      console.error(`[email] Failed to send job photo to ${toEmail}:`, err.message);
    }
  } else {
    console.log(`\n[DEV EMAIL] -> ${toEmail}\nSubject: ${subject}\n${text}\n[photo attachment: ${localPhotoPath}]\n`);
  }
}

// ---------- Database ----------
// Lives under STORAGE_DIR (default: ./storage) alongside /uploads, so a
// single Render persistent disk mounted at that one path covers both —
// Render only allows one disk per service, with one mount path.
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
const dbPath = path.join(STORAGE_DIR, 'data', 'lawnbid.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS pros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    email TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    services TEXT NOT NULL,
    notes TEXT,
    yard_size TEXT,
    address TEXT NOT NULL,
    phone TEXT NOT NULL,
    photo_path TEXT,
    status TEXT NOT NULL DEFAULT 'open', -- open | awaiting_confirmation | matched | expired | cancelled
    winning_bid_id INTEGER,
    pending_bid_id INTEGER,
    confirmation_expires_at TEXT,
    fee_amount REAL,
    fee_paid INTEGER NOT NULL DEFAULT 0,
    closes_at TEXT NOT NULL,
    broadcast_at TEXT,
    broadcast_sent INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    pro_phone TEXT NOT NULL,
    pro_name TEXT,
    price REAL NOT NULL,
    raw_message TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY(job_id) REFERENCES jobs(id)
  );

  CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new', -- new | resolved
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS pro_signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'new', -- new | added
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`);

// ---------- Schema migrations ----------
// CREATE TABLE IF NOT EXISTS only helps on a brand-new database — it does
// nothing to an existing one, so any column added after the table already
// existed in production needs an explicit ALTER TABLE here. This never
// mattered before the persistent disk was attached, because every deploy
// wiped the database and recreated it fresh with whatever the schema
// looked like at that moment. Now that the database survives deploys, this
// is the only thing that keeps an older production database in sync with
// the current code. Safe to run on every startup — it's a no-op for any
// column that already exists (checked via PRAGMA table_info, not by
// catching the error), and safe to run on a freshly created database too.
function ensureColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existing.some(col => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[migration] Added column ${table}.${column}`);
  }
}

ensureColumn('pros', 'email', 'TEXT');
ensureColumn('jobs', 'yard_size', 'TEXT');
ensureColumn('jobs', 'pending_bid_id', 'INTEGER');
ensureColumn('jobs', 'confirmation_expires_at', 'TEXT');
ensureColumn('jobs', 'fee_amount', 'REAL');
ensureColumn('jobs', 'fee_paid', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('jobs', 'broadcast_at', 'TEXT');
ensureColumn('jobs', 'broadcast_sent', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('pro_signups', 'email', 'TEXT');
ensureColumn('pro_signups', 'notes', 'TEXT');

// ---------- File uploads ----------
const uploadDir = path.join(STORAGE_DIR, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `job-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

// ---------- App ----------
const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));
app.use(express.urlencoded({ extended: false })); // needed for Twilio's inbound webhook
app.use('/uploads', express.static(uploadDir));

// Constant-time comparison so a wrong password doesn't leak timing info.
function safeEqual(a, b) {
  const bufA = Buffer.from(a || '');
  const bufB = Buffer.from(b || '');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Gate the admin dashboard and every /api/admin/* route behind HTTP Basic
// Auth. Requires ADMIN_PASSWORD to be set — if it isn't, admin access is
// refused entirely rather than left open by accident.
function requireAdminAuth(req, res, next) {
  const expectedPassword = process.env.ADMIN_PASSWORD;
  if (!expectedPassword) {
    return res.status(500).send('Admin access is not configured. Set ADMIN_PASSWORD in your environment variables.');
  }
  const expectedUsername = process.env.ADMIN_USERNAME || 'admin';
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');

  if (scheme === 'Basic' && encoded) {
    const [username, password] = Buffer.from(encoded, 'base64').toString().split(':');
    if (safeEqual(username, expectedUsername) && safeEqual(password, expectedPassword)) {
      return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Lawn Bid Admin"');
  return res.status(401).send('Authentication required.');
}

// Must be registered before express.static below, so a request for
// /admin.html hits the auth check first instead of being served directly.
app.use('/admin.html', requireAdminAuth);
app.use('/api/admin', requireAdminAuth);

app.use(express.static(path.join(__dirname, 'public')));

// Normalize a phone number to a rough E.164-ish key for matching (US-centric default)
function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return raw && raw.startsWith('+') ? raw : '+' + digits;
}

// Network fee owed by the winning pro, tiered by their winning bid amount.
// This is collected outside the app (Venmo/Zelle/cash) — the app just
// tracks whether it's been paid, since that's the enforcement lever
// (unpaid pros get paused from future job broadcasts via the admin toggle).
function computeFeeAmount(price) {
  if (price < 50) return 10;
  if (price <= 100) return 20;
  return 30;
}

// Builds a payment link with the fee amount pre-filled, using whichever
// service is configured. PAYMENT_LINK_TEMPLATE should contain "{amount}",
// e.g. "https://paypal.me/YourName/{amount}" or "https://cash.app/$YourTag/{amount}".
// Returns null if not configured, in which case no QR code is sent.
function paymentLinkForFee(feeAmount) {
  const template = process.env.PAYMENT_LINK_TEMPLATE;
  if (!template) return null;
  return template.replace('{amount}', feeAmount);
}

// Builds the absolute URL Twilio will fetch the QR code image from. Needs
// PUBLIC_BASE_URL (your live domain) since Twilio can't reach localhost or
// a relative path — it fetches the image itself, independently, over HTTPS.
function qrImageUrlForJob(jobId) {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/qr/fee/${jobId}.png`;
}

// Same idea, for an uploaded job photo (stored at e.g. /uploads/job-123.jpg)
// — needs to become an absolute URL for Twilio to attach it as an MMS.
function publicUrlFor(relativePath) {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base || !relativePath) return null;
  return `${base.replace(/\/$/, '')}${relativePath}`;
}

function jobSummaryText(job) {
  const services = JSON.parse(job.services).join(', ');
  const yardSizeLine = job.yard_size ? ` Yard size: ${job.yard_size}.` : '';
  const notesLine = job.notes ? ` Notes: ${job.notes}.` : '';
  return `New Kirkwood-area yard job #${job.id}: ${services}.${yardSizeLine}${notesLine} Reply "BID ${job.id} <price>" to bid, e.g. BID ${job.id} 85`;
}

// Turns the computed closes_at into a homeowner-friendly phrase, e.g.
// "5:30 PM today", "9:00 AM tomorrow", or "9:00 AM on Sep 10" further out.
// Uses the same closesAt the bidding-window formula produces, so this
// always reflects the actual window (business-hours or off-hours + soft
// close extensions), never a separate guess.
function formatExpectedReplyTime(closesAt, now) {
  const timeStr = closesAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: APP_TIMEZONE });
  if (zonedDateKey(closesAt) === zonedDateKey(now)) {
    return `${timeStr} today`;
  }
  const { year, month, day } = zonedParts(now);
  const tomorrow = addDaysToDateParts(year, month, day, 1);
  if (zonedDateKey(closesAt) === `${tomorrow.year}-${tomorrow.month}-${tomorrow.day}`) {
    return `${timeStr} tomorrow`;
  }
  const dateStr = closesAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: APP_TIMEZONE });
  return `${timeStr} on ${dateStr}`;
}

// ---------- Central time helpers ----------
// BUSINESS_HOURS_START/END and PRO_NOTIFICATION_HOLD_HOUR are meant to be
// read in Kirkwood, MO local time (America/Chicago), not whatever timezone
// the Node process happens to be running in. Most hosts default their
// containers to UTC, so plain now.getHours()/now.setHours() silently used
// the wrong clock. Everything below reads/writes wall-clock time explicitly
// in America/Chicago, regardless of the server's own system timezone.
const APP_TIMEZONE = 'America/Chicago';

// Y/M/D/H/Mi as they read on a clock on the wall in APP_TIMEZONE, for a
// given absolute instant.
function zonedParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parseInt(parts.find(p => p.type === type).value, 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Some locales render midnight as "24"; normalize to 0.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

// Current fractional hour (e.g. 13.5 for 1:30pm) as it reads on the wall in
// APP_TIMEZONE — replaces now.getHours() + now.getMinutes() / 60.
function zonedHourFraction(date) {
  const { hour, minute } = zonedParts(date);
  return hour + minute / 60;
}

// UTC offset (in minutes, e.g. -300 for CDT, -360 for CST) that APP_TIMEZONE
// was at for the given instant.
function zonedOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIMEZONE,
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const tzName = parts.find(p => p.type === 'timeZoneName').value; // "GMT-5"
  const match = tzName.match(/GMT([+-]\d+)(?::(\d+))?/);
  const hours = match ? parseInt(match[1], 10) : 0;
  const minutes = match && match[2] ? parseInt(match[2], 10) : 0;
  return hours * 60 + (hours < 0 ? -minutes : minutes);
}

// Converts a wall-clock Y-M-D H:Mi *as read in APP_TIMEZONE* into the
// corresponding absolute instant (a real Date/UTC timestamp). This is the
// inverse of zonedParts, and is what lets us say "9am Central" and get back
// a correct Date no matter what timezone the server process is in, and
// without getting tripped up at DST transitions.
function zonedWallTimeToUtc(year, month, day, hour, minute = 0) {
  let guessMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two passes is enough to converge even across a DST boundary.
  for (let i = 0; i < 2; i++) {
    const offsetMin = zonedOffsetMinutes(new Date(guessMs));
    guessMs = Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMin * 60000;
  }
  return new Date(guessMs);
}

// Adds `days` to a Y-M-D date, doing the arithmetic at UTC noon so DST
// transitions in APP_TIMEZONE can't shift the calendar date by mistake.
function addDaysToDateParts(year, month, day, days) {
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + days);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

// Y-M-D of `date` as read in APP_TIMEZONE, used for "is this the same day"
// comparisons instead of toDateString() (which uses the server's own zone).
function zonedDateKey(date) {
  const { year, month, day } = zonedParts(date);
  return `${year}-${month}-${day}`;
}

// ---------- Bidding window timing ----------
// During business hours, jobs get a flat BID_WINDOW_MINUTES to collect bids.
// Outside business hours (evenings, overnight, early morning), pros in a
// small network may not see the text until they're back at work, so the
// window instead runs until 1 hour after the next business-hours opening —
// giving them a real chance to see it and bid, rather than closing while
// everyone's asleep.
function nextBusinessOpenTime(now) {
  const currentHour = zonedHourFraction(now);
  const { year, month, day } = zonedParts(now);
  let target = { year, month, day };
  if (currentHour >= BUSINESS_HOURS_START) {
    // We only get here when outside business hours, so being at/past the
    // opening hour means we're past closing — roll over to tomorrow.
    target = addDaysToDateParts(year, month, day, 1);
  }
  return zonedWallTimeToUtc(target.year, target.month, target.day, BUSINESS_HOURS_START, 0);
}

function computeInitialWindowMs(now) {
  const currentHour = zonedHourFraction(now);
  const inBusinessHours = currentHour >= BUSINESS_HOURS_START && currentHour < BUSINESS_HOURS_END;
  if (inBusinessHours) {
    return BID_WINDOW_MINUTES * 60 * 1000;
  }
  const msUntilOpen = nextBusinessOpenTime(now).getTime() - now.getTime();
  return msUntilOpen + (60 * 60 * 1000); // + 1 hour buffer past opening
}

// Generic "next time the clock hits this hour (in APP_TIMEZONE)" helper —
// unlike nextBusinessOpenTime above, this doesn't assume it's only called
// when already outside some range, so it's reusable for other hour-based
// cutoffs.
function nextOccurrenceOfHour(now, hour) {
  const { year, month, day } = zonedParts(now);
  let candidate = zonedWallTimeToUtc(year, month, day, hour, 0);
  if (candidate.getTime() <= now.getTime()) {
    const tomorrow = addDaysToDateParts(year, month, day, 1);
    candidate = zonedWallTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, 0);
  }
  return candidate;
}

// If a job comes in outside PRO_NOTIFICATION_HOLD_HOUR–BUSINESS_HOURS_END
// (default 8am–6pm), pros aren't notified until that hold hour the next
// time it occurs — nobody wants a job alert at 1am. Returns null if the
// job should be broadcast immediately (already within the allowed window).
function computeBroadcastHoldUntil(now) {
  const currentHour = zonedHourFraction(now);
  const inAllowedWindow = currentHour >= PRO_NOTIFICATION_HOLD_HOUR && currentHour < BUSINESS_HOURS_END;
  if (inAllowedWindow) return null;
  return nextOccurrenceOfHour(now, PRO_NOTIFICATION_HOLD_HOUR);
}

// In-memory registry of the pending timer per job — either the "close
// bidding" timer or, once a bid is tentatively selected, the "homeowner
// didn't respond" timer. Only one is ever active per job at a time, so
// reusing the same map for both is safe.
const jobTimers = new Map();

function clearJobTimer(jobId) {
  const existing = jobTimers.get(jobId);
  if (existing) {
    clearTimeout(existing);
    jobTimers.delete(jobId);
  }
}

function scheduleClose(jobId, delayMs) {
  clearJobTimer(jobId);
  const timer = setTimeout(() => {
    jobTimers.delete(jobId);
    selectWinner(jobId).catch(err => console.error('selectWinner error:', err));
  }, Math.max(delayMs, 0));
  jobTimers.set(jobId, timer);
}

// If pro notifications are being held until morning, this fires the actual
// broadcast once that hour arrives.
function scheduleBroadcast(jobId, delayMs) {
  clearJobTimer(jobId);
  const timer = setTimeout(() => {
    jobTimers.delete(jobId);
    handleScheduledBroadcast(jobId).catch(err => console.error('handleScheduledBroadcast error:', err));
  }, Math.max(delayMs, 0));
  jobTimers.set(jobId, timer);
}

// If the homeowner never replies Y or N within CONFIRMATION_WINDOW_MINUTES,
// cancel the job automatically rather than leaving it stuck waiting forever.
function scheduleConfirmationTimeout(jobId, delayMs) {
  clearJobTimer(jobId);
  const timer = setTimeout(() => {
    jobTimers.delete(jobId);
    handleConfirmationTimeout(jobId).catch(err => console.error('handleConfirmationTimeout error:', err));
  }, Math.max(delayMs, 0));
  jobTimers.set(jobId, timer);
}

async function handleConfirmationTimeout(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || job.status !== 'awaiting_confirmation') return; // already resolved
  await cancelPendingJob(jobId, 'timeout');
}

// If a bid lands within SOFT_CLOSE_THRESHOLD_MINUTES of the close time,
// push the close out by SOFT_CLOSE_EXTENSION_MINUTES — same idea as an
// eBay auction's soft close, so a late flurry of bids on a small network
// isn't cut off mid-negotiation. Returns true if it extended the window.
function maybeExtendWindow(job, now) {
  const closesAt = new Date(job.closes_at);
  const remainingMs = closesAt.getTime() - now.getTime();
  if (remainingMs > SOFT_CLOSE_THRESHOLD_MINUTES * 60 * 1000) return false;

  const newClosesAt = new Date(now.getTime() + SOFT_CLOSE_EXTENSION_MINUTES * 60 * 1000);
  db.prepare('UPDATE jobs SET closes_at = ? WHERE id = ?').run(newClosesAt.toISOString(), job.id);
  scheduleClose(job.id, SOFT_CLOSE_EXTENSION_MINUTES * 60 * 1000);
  return true;
}

// On startup, re-arm timers for any jobs that were mid-flight when the
// server last stopped (in-memory timers don't survive a restart) — both
// jobs still collecting bids, and jobs waiting on a homeowner's Y/N reply.
function recoverOpenJobTimers() {
  const now = new Date();

  // Jobs whose pro broadcast is still being held until morning.
  const pendingBroadcastJobs = db.prepare(`SELECT * FROM jobs WHERE status = 'open' AND broadcast_sent = 0`).all();
  for (const job of pendingBroadcastJobs) {
    const remainingMs = new Date(job.broadcast_at).getTime() - now.getTime();
    if (remainingMs <= 0) {
      handleScheduledBroadcast(job.id).catch(err => console.error('handleScheduledBroadcast error:', err));
    } else {
      scheduleBroadcast(job.id, remainingMs);
    }
  }

  // Jobs already broadcast to pros, still collecting bids.
  const openJobs = db.prepare(`SELECT * FROM jobs WHERE status = 'open' AND broadcast_sent = 1`).all();
  for (const job of openJobs) {
    const remainingMs = new Date(job.closes_at).getTime() - now.getTime();
    if (remainingMs <= 0) {
      selectWinner(job.id).catch(err => console.error('selectWinner error:', err));
    } else {
      scheduleClose(job.id, remainingMs);
    }
  }

  const pendingJobs = db.prepare(`SELECT * FROM jobs WHERE status = 'awaiting_confirmation'`).all();
  for (const job of pendingJobs) {
    const remainingMs = new Date(job.confirmation_expires_at).getTime() - now.getTime();
    if (remainingMs <= 0) {
      handleConfirmationTimeout(job.id).catch(err => console.error('handleConfirmationTimeout error:', err));
    } else {
      scheduleConfirmationTimeout(job.id, remainingMs);
    }
  }
}

// ---------- 1 & 2: homeowner submits a job -> broadcast to the pro network ----------
app.post('/api/requests', upload.single('photo'), async (req, res) => {
  try {
    let services;
    try { services = JSON.parse(req.body.services); } catch { services = []; }
    const address = (req.body.address || '').trim();
    const phone = normalizePhone(req.body.phone || '');
    const notes = (req.body.notes || '').trim();
    const yardSize = (req.body.yardSize || '').trim() || null;

    if (!services.length || !address || !phone) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }

    const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
    const now = new Date();

    // If it's outside pro-notification hours, hold the broadcast until the
    // next occurrence of PRO_NOTIFICATION_HOLD_HOUR instead of texting pros
    // in the middle of the night. The bidding window is computed from
    // whenever pros will actually see the job, not from submission time —
    // otherwise part of their bidding time would silently burn away
    // overnight before anyone's even seen it.
    const holdUntil = computeBroadcastHoldUntil(now);
    const broadcastAt = holdUntil || now;
    const windowMs = computeInitialWindowMs(broadcastAt);
    const closesAt = new Date(broadcastAt.getTime() + windowMs);

    const insert = db.prepare(`
      INSERT INTO jobs (services, notes, yard_size, address, phone, photo_path, closes_at, broadcast_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = insert.run(
      JSON.stringify(services), notes, yardSize, address, phone, photoPath,
      closesAt.toISOString(), broadcastAt.toISOString()
    );
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(info.lastInsertRowid);

    let prosNotified = 0;
    if (holdUntil) {
      // Don't broadcast yet — schedule it, and let the bid-window timer
      // start only once that broadcast actually happens (see
      // handleScheduledBroadcast).
      scheduleBroadcast(job.id, holdUntil.getTime() - now.getTime());
    } else {
      prosNotified = await broadcastJobToPros(job);
      db.prepare('UPDATE jobs SET broadcast_sent = 1 WHERE id = ?').run(job.id);
      scheduleClose(job.id, windowMs);
    }

    // Let the homeowner know their request actually went out — otherwise
    // they hear nothing until a winner is picked, which can be many hours
    // away on an off-hours window.
    const expectedBy = formatExpectedReplyTime(closesAt, now);
    const homeownerText = holdUntil
      ? `Thank you for using Kirkwood Lawn and Landscape Service Finder. It's currently outside pro notification hours, so we'll reach out to nearby lawncare pros starting at ${holdUntil.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: APP_TIMEZONE })}. You should expect a reply by ${expectedBy}. Reply STOP to opt out.`
      : `Thank you for using Kirkwood Lawn and Landscape Service Finder. We've texted our lawncare pros. You should expect a reply by ${expectedBy}. Reply STOP to opt out.`;
    await sendSMS(job.phone, homeownerText);

    res.json({ jobId: job.id, prosNotified, closesAt: closesAt.toISOString(), broadcastAt: broadcastAt.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Texts (and, for pros with an email on file, emails) every active pro
// about a job. Pulled into its own function so it can run either
// immediately on submission or later from a scheduled "held" broadcast —
// both paths need the exact same per-pro photo-delivery logic.
async function broadcastJobToPros(job) {
  const pros = db.prepare('SELECT * FROM pros WHERE active = 1').all();
  const photoMediaUrl = publicUrlFor(job.photo_path);
  const localPhotoPath = job.photo_path ? path.join(uploadDir, path.basename(job.photo_path)) : null;
  const baseText = jobSummaryText(job);

  await Promise.all(pros.map(async (p) => {
    let text = baseText;
    let mediaUrlForThisPro = null;

    if (localPhotoPath) {
      if (p.email) {
        text += ' Check your email for photos of this job.';
        await sendJobPhotoEmail(p.email, job, localPhotoPath);
      } else if (photoMediaUrl) {
        text += ' A photo of the job is attached.';
        mediaUrlForThisPro = photoMediaUrl;
      }
    }

    text += ' Reply STOP to opt out.';
    await sendSMS(p.phone, text, mediaUrlForThisPro);
  }));

  return pros.length;
}

// Fires when a held broadcast's scheduled time arrives — sends the job to
// pros, marks it sent, and only now starts the bid-window close timer.
async function handleScheduledBroadcast(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || job.broadcast_sent) return; // already sent, or job no longer exists
  await broadcastJobToPros(job);
  db.prepare('UPDATE jobs SET broadcast_sent = 1 WHERE id = ?').run(jobId);
  const remainingMs = new Date(job.closes_at).getTime() - Date.now();
  scheduleClose(jobId, remainingMs);
}

// ---------- 4: pros bid by replying to the text ----------
// Shared by both inbound webhook shapes (Twilio's synchronous-reply style
// and SMS Gateway for Android's fire-a-separate-outbound-text style) so the
// bid-parsing and confirmation logic lives in exactly one place.
async function processInboundMessage(from, body) {
  body = (body || '').trim();

  // Matches "BID 12 85", "bid #12 $85.50", "Bid: 12 - 85" etc.
  const match = body.match(/bid\D*(\d+)\D+\$?(\d+(?:\.\d{1,2})?)/i);

  if (match) {
    const jobId = parseInt(match[1], 10);
    const price = parseFloat(match[2]);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);

    if (!job) {
      return `We don't have a job #${jobId} on file.`;
    }
    if (job.status !== 'open') {
      return `Job #${jobId} is already closed — thanks for the interest.`;
    }

    const pro = db.prepare('SELECT * FROM pros WHERE phone = ?').get(from);
    db.prepare(`
      INSERT INTO bids (job_id, pro_phone, pro_name, price, raw_message)
      VALUES (?, ?, ?, ?, ?)
    `).run(jobId, from, pro ? pro.name : null, price, body);

    const now = new Date();
    const extended = maybeExtendWindow(job, now);

    // Bids stay sealed — pros never see who else bid or the full list,
    // just whether they're currently in front, to keep some competitive
    // pressure without opening the door to price collusion.
    const lowest = db.prepare('SELECT MIN(price) AS min_price FROM bids WHERE job_id = ?').get(jobId).min_price;

    let reply;
    if (price <= lowest) {
      reply = `Got it — your bid of $${price.toFixed(2)} on job #${jobId} is in, and it's currently the lowest bid. We'll text you if you're selected.`;
    } else {
      reply = `Got it — your bid of $${price.toFixed(2)} on job #${jobId} is in. Current lowest bid is $${lowest.toFixed(2)}. You can send a new bid anytime before we pick a winner, e.g. BID ${jobId} 65`;
    }
    if (extended) {
      reply += ` Bidding on this job was just extended by ${SOFT_CLOSE_EXTENSION_MINUTES} minutes.`;
    }
    return reply;
  }

  // Not a bid — check whether this number has a job waiting on a Y/N
  // confirmation reply (a homeowner deciding whether to accept a bid).
  const normalizedFrom = normalizePhone(from);
  const pendingJob = db.prepare(`
    SELECT * FROM jobs WHERE phone = ? AND status = 'awaiting_confirmation'
    ORDER BY created_at DESC LIMIT 1
  `).get(normalizedFrom);
  const normalizedBody = body.toLowerCase();

  if (pendingJob && (normalizedBody === 'y' || normalizedBody === 'yes')) {
    const winner = await confirmBid(pendingJob.id);
    const proLabel = winner ? (winner.pro_name || winner.pro_phone) : 'the pro';
    return `Great — we've confirmed the bid from ${proLabel} for job #${pendingJob.id}. They'll be in touch soon.`;
  }
  if (pendingJob && (normalizedBody === 'n' || normalizedBody === 'no')) {
    await cancelPendingJob(pendingJob.id, 'declined');
    return `Got it — we've cancelled job #${pendingJob.id}. Let us know if you'd like to submit a new request.`;
  }
  if (pendingJob) {
    const bid = db.prepare('SELECT * FROM bids WHERE id = ?').get(pendingJob.pending_bid_id);
    const proLabel = bid ? (bid.pro_name || bid.pro_phone) : 'the pro';
    const priceLabel = bid ? `$${bid.price.toFixed(2)}` : 'the';
    return `We're still waiting on your response for job #${pendingJob.id} — reply Y to accept the ${priceLabel} bid from ${proLabel}, or N to cancel.`;
  }
  return `Sorry, we couldn't read that. Reply like: BID <job number> <price>, e.g. BID 12 85`;
}

// Twilio inbound webhook — replies synchronously via TwiML in the response.
app.post('/api/sms-inbound', async (req, res) => {
  const reply = await processInboundMessage(req.body.From, req.body.Body);
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`);
});

// SMS Gateway for Android webhook — this backend has no synchronous-reply
// mechanism, so the reply is sent as a separate outbound text instead.
// HMAC-verified using the signing key from Settings > Webhooks > Signing Key
// in the app, so a request can't be spoofed by someone who finds this URL.
app.post('/api/sms-gateway-inbound', async (req, res) => {
  const signingKey = process.env.SMS_GATEWAY_SIGNING_KEY;
  if (signingKey) {
    const signature = req.headers['x-signature'];
    const timestamp = req.headers['x-timestamp'];
    if (!signature || !timestamp) {
      return res.status(401).send('Missing signature.');
    }
    const expected = crypto
      .createHmac('sha256', signingKey)
      .update(req.rawBody + timestamp)
      .digest('hex');
    const sigBuf = Buffer.from(String(signature).trim().toLowerCase(), 'hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return res.status(401).send('Invalid signature.');
    }
  }

  // Always acknowledge quickly — the gateway retries with exponential
  // backoff for ~2 days if it doesn't get a 2xx, which would otherwise
  // resend the same message repeatedly.
  res.status(200).send('ok');

  if (req.body.event !== 'sms:received') return; // ignore sent/delivered/failed/etc.

  const from = req.body.payload && req.body.payload.sender;
  const body = req.body.payload && req.body.payload.message;
  if (!from || !body) return;

  try {
    const reply = await processInboundMessage(from, body);
    await sendSMS(from, reply);
  } catch (err) {
    console.error('[sms-gateway-inbound] Failed to process message:', err.message);
  }
});

function escapeXml(str) {
  return str.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// ---------- 4 (cont'd): backend picks a bid and asks the homeowner to confirm ----------
async function selectWinner(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || job.status !== 'open') return null;

  const bids = db.prepare('SELECT * FROM bids WHERE job_id = ? ORDER BY price ASC').all(jobId);

  if (!bids.length) {
    // Homeowner isn't notified here — a job with zero bids isn't
    // actionable on their end, and getting a text saying "nothing
    // happened" is worse than getting nothing. It shows up flagged in the
    // admin dashboard instead, so you can follow up manually if needed.
    db.prepare(`UPDATE jobs SET status = 'expired' WHERE id = ?`).run(jobId);
    return null;
  }

  const winner = bids[0]; // lowest price wins; swap this line to change the selection rule
  await initiateConfirmation(jobId, winner);
  return winner;
}

// Tentatively selects a bid and asks the homeowner to accept or decline it
// by text (Y/N) before anything else happens — the winning pro isn't
// notified, and other bidders aren't told they lost, until the homeowner
// confirms. Used both by the automatic bid-window close and by an admin
// manually picking a bid from the dashboard.
async function initiateConfirmation(jobId, bid) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  const feeAmount = computeFeeAmount(bid.price);
  const confirmationExpiresAt = new Date(Date.now() + CONFIRMATION_WINDOW_MINUTES * 60 * 1000);

  db.prepare(`
    UPDATE jobs SET status = 'awaiting_confirmation', pending_bid_id = ?, fee_amount = ?, confirmation_expires_at = ?
    WHERE id = ?
  `).run(bid.id, feeAmount, confirmationExpiresAt.toISOString(), jobId);

  const proLabel = bid.pro_name || bid.pro_phone;
  await sendSMS(job.phone,
    `Your job #${jobId} got a bid: $${bid.price.toFixed(2)} from ${proLabel}. Reply Y to accept this bid, N to cancel the request.`);

  scheduleConfirmationTimeout(jobId, CONFIRMATION_WINDOW_MINUTES * 60 * 1000);
}

// Homeowner replied Y — finalize the match: notify the winning pro (with
// the fee and QR code, if configured) and let the other bidders know.
async function confirmBid(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || job.status !== 'awaiting_confirmation') return null;
  clearJobTimer(jobId);

  const winner = db.prepare('SELECT * FROM bids WHERE id = ?').get(job.pending_bid_id);
  db.prepare(`UPDATE jobs SET status = 'matched', winning_bid_id = ? WHERE id = ?`).run(winner.id, jobId);

  const paymentUrl = paymentLinkForFee(job.fee_amount);
  const qrImageUrl = paymentUrl ? qrImageUrlForJob(jobId) : null;
  const payLine = qrImageUrl ? ' Scan the QR code to pay.' : (paymentUrl ? ` Pay here: ${paymentUrl}` : '');
  await sendSMS(winner.pro_phone,
    `You won job #${jobId}! A $${job.fee_amount} network fee is due in 7 days or after completion of the job.${payLine} Homeowner phone: ${job.phone}. Address: ${job.address}. Please reach out to schedule.`,
    qrImageUrl);

  const others = db.prepare('SELECT * FROM bids WHERE job_id = ? AND id != ?').all(jobId, winner.id);
  await Promise.all(others.map(b =>
    sendSMS(b.pro_phone, `Job #${jobId} was awarded to another bidder this time. Thanks for bidding!`)));

  return winner;
}

// Homeowner replied N, or never replied in time — cancel the job. No fee is
// owed since nothing was ever confirmed, and every bidder is notified.
async function cancelPendingJob(jobId, reason) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || job.status !== 'awaiting_confirmation') return null;
  clearJobTimer(jobId);

  db.prepare(`UPDATE jobs SET status = 'cancelled', fee_amount = NULL WHERE id = ?`).run(jobId);

  const allBidders = db.prepare('SELECT * FROM bids WHERE job_id = ?').all(jobId);
  const message = reason === 'timeout'
    ? `Job #${jobId} was cancelled because the homeowner didn't respond in time. Thanks for bidding!`
    : reason === 'admin'
    ? `Job #${jobId} was cancelled. Thanks for bidding!`
    : `Job #${jobId} was cancelled by the homeowner. Thanks for bidding!`;
  await Promise.all(allBidders.map(b => sendSMS(b.pro_phone, message)));

  return job;
}

// ---------- Admin: manage the pro network and review/override bids ----------
app.get('/api/admin/pros', (req, res) => {
  res.json(db.prepare('SELECT * FROM pros ORDER BY created_at DESC').all());
});

app.post('/api/admin/pros', (req, res) => {
  const { name, phone, email } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
  try {
    const info = db.prepare('INSERT INTO pros (name, phone, email) VALUES (?, ?, ?)')
      .run(name, normalizePhone(phone), (email || '').trim() || null);
    res.json(db.prepare('SELECT * FROM pros WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    res.status(400).json({ error: 'Could not add pro (duplicate phone?)' });
  }
});

app.post('/api/admin/pros/:id/toggle', (req, res) => {
  const pro = db.prepare('SELECT * FROM pros WHERE id = ?').get(req.params.id);
  if (!pro) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE pros SET active = ? WHERE id = ?').run(pro.active ? 0 : 1, pro.id);
  res.json(db.prepare('SELECT * FROM pros WHERE id = ?').get(pro.id));
});

app.delete('/api/admin/pros/:id', (req, res) => {
  const pro = db.prepare('SELECT * FROM pros WHERE id = ?').get(req.params.id);
  if (!pro) return res.status(404).json({ error: 'not found' });
  // Bids store their own pro_phone/pro_name at the time they were placed
  // rather than a foreign key to this row, so removing a pro doesn't touch
  // job or bid history — past jobs still show who bid what.
  db.prepare('DELETE FROM pros WHERE id = ?').run(pro.id);
  res.json({ ok: true });
});

app.get('/api/admin/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  const withBids = jobs.map(j => ({
    ...j,
    services: JSON.parse(j.services),
    bids: db.prepare('SELECT * FROM bids WHERE job_id = ? ORDER BY price ASC').all(j.id)
  }));
  res.json(withBids);
});

// Manually delete a job (and its bids) — e.g. a test submission, a mistake,
// or just cleaning up old archived jobs. Cancels any pending timer for it
// first so a stale timeout doesn't fire against a job that no longer exists.
app.delete('/api/admin/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  clearJobTimer(job.id);
  db.prepare('DELETE FROM bids WHERE job_id = ?').run(job.id);
  db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
  res.json({ ok: true });
});

// Manually pick a bid before the auto-timer fires — like the automatic
// path, this asks the homeowner to confirm rather than matching instantly.
app.post('/api/admin/jobs/:id/select', async (req, res) => {
  const { bidId } = req.body;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (job.status !== 'open') return res.status(400).json({ error: 'job is not open for selection' });
  const bid = db.prepare('SELECT * FROM bids WHERE id = ? AND job_id = ?').get(bidId, job.id);
  if (!bid) return res.status(404).json({ error: 'bid not found' });

  clearJobTimer(job.id); // cancel the pending bid-window close timer — we're resolving this now
  await initiateConfirmation(job.id, bid);
  res.json({ ok: true });
});

// Admin override: finalize a pending bid immediately without waiting on
// the homeowner's text reply — e.g. if they confirmed over the phone.
app.post('/api/admin/jobs/:id/force-confirm', async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job || job.status !== 'awaiting_confirmation') {
    return res.status(400).json({ error: 'job is not awaiting confirmation' });
  }
  await confirmBid(job.id);
  res.json({ ok: true });
});

// Admin override: cancel a pending bid immediately without waiting for a
// homeowner reply or the confirmation timeout.
app.post('/api/admin/jobs/:id/force-cancel', async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job || job.status !== 'awaiting_confirmation') {
    return res.status(400).json({ error: 'job is not awaiting confirmation' });
  }
  await cancelPendingJob(job.id, 'admin');
  res.json({ ok: true });
});

// Mark a winning pro's network fee as paid (or back to unpaid) — collected
// outside the app, this just records it so unpaid fees are visible.
app.post('/api/admin/jobs/:id/fee-paid', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  db.prepare('UPDATE jobs SET fee_paid = ? WHERE id = ?').run(job.fee_paid ? 0 : 1, job.id);
  res.json(db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id));
});

// Public, unauthenticated — Twilio fetches this image directly when sending
// the winner's MMS, so it can't sit behind admin auth. It only exposes a
// payment link + dollar amount, not any homeowner or pro personal info.
app.get('/qr/fee/:jobId.png', async (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job || job.fee_amount == null) return res.status(404).send('Not found');

  const paymentUrl = paymentLinkForFee(job.fee_amount);
  if (!paymentUrl) return res.status(404).send('Payment link not configured');

  res.type('png');
  QRCode.toFileStream(res, paymentUrl, { width: 300, margin: 2 });
});

// ---------- Customer service messages ----------
// Public: anyone can submit a question or concern from the homepage.
app.post('/api/support', (req, res) => {
  const name = (req.body.name || '').trim();
  const address = (req.body.address || '').trim();
  const phone = (req.body.phone || '').trim();
  const message = (req.body.message || '').trim();

  if (!name || !message) {
    return res.status(400).json({ error: 'Name and message are required.' });
  }

  const info = db.prepare(`
    INSERT INTO support_messages (name, address, phone, message)
    VALUES (?, ?, ?, ?)
  `).run(name, address || null, phone ? normalizePhone(phone) : null, message);

  res.json({ ok: true, id: info.lastInsertRowid });
});

// Admin: view and resolve customer service messages.
app.get('/api/admin/support', (req, res) => {
  res.json(db.prepare('SELECT * FROM support_messages ORDER BY created_at DESC').all());
});

app.post('/api/admin/support/:id/resolve', (req, res) => {
  const msg = db.prepare('SELECT * FROM support_messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE support_messages SET status = ? WHERE id = ?`)
    .run(msg.status === 'resolved' ? 'new' : 'resolved', msg.id);
  res.json(db.prepare('SELECT * FROM support_messages WHERE id = ?').get(msg.id));
});

// ---------- Pro network signups ----------
// Public: a lawn care pro asks to join the network. Stored in the database
// (so it's never lost even if email delivery fails) and also emailed to
// you directly for a fast heads-up.
app.post('/api/pro-signup', async (req, res) => {
  const businessName = (req.body.businessName || '').trim();
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim();
  const notes = (req.body.notes || '').trim();

  if (!businessName || !phone) {
    return res.status(400).json({ error: 'Business name and phone number are required.' });
  }

  const normalizedPhone = normalizePhone(phone);
  const info = db.prepare(`
    INSERT INTO pro_signups (business_name, phone, email, notes)
    VALUES (?, ?, ?, ?)
  `).run(businessName, normalizedPhone, email || null, notes || null);

  const emailLine = email ? `\nEmail: ${email}` : '';
  const notesLine = notes ? `\n\nQuestions/comments: ${notes}` : '';
  await sendEmail(
    `New pro network signup: ${businessName}`,
    `${businessName} wants to join the Kirkwood lawn care network.\n\nPhone: ${normalizedPhone}${emailLine}${notesLine}\n\nAdd them from the admin dashboard: ${process.env.PUBLIC_BASE_URL || ''}/admin.html`
  );

  res.json({ ok: true, id: info.lastInsertRowid });
});

// Admin: view and resolve pro signup requests.
app.get('/api/admin/pro-signups', (req, res) => {
  res.json(db.prepare('SELECT * FROM pro_signups ORDER BY created_at DESC').all());
});

app.post('/api/admin/pro-signups/:id/resolve', (req, res) => {
  const signup = db.prepare('SELECT * FROM pro_signups WHERE id = ?').get(req.params.id);
  if (!signup) return res.status(404).json({ error: 'not found' });
  db.prepare(`UPDATE pro_signups SET status = ? WHERE id = ?`)
    .run(signup.status === 'added' ? 'new' : 'added', signup.id);
  res.json(db.prepare('SELECT * FROM pro_signups WHERE id = ?').get(signup.id));
});

app.listen(PORT, () => {
  console.log(`Lawn Bid app running at http://localhost:${PORT}`);
  console.log(`Admin dashboard at http://localhost:${PORT}/admin.html`);
  if (!TWILIO_ENABLED && !SMS_GATEWAY_ENABLED) console.log('No SMS backend configured — texts will print to this console.');
  recoverOpenJobTimers();
});
