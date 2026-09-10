require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const BID_WINDOW_MINUTES = parseFloat(process.env.BID_WINDOW_MINUTES || '30');
const BUSINESS_HOURS_START = parseInt(process.env.BUSINESS_HOURS_START || '9', 10);  // 24hr, e.g. 9 = 9am
const BUSINESS_HOURS_END = parseInt(process.env.BUSINESS_HOURS_END || '18', 10);     // 24hr, e.g. 18 = 6pm
const SOFT_CLOSE_THRESHOLD_MINUTES = parseFloat(process.env.SOFT_CLOSE_THRESHOLD_MINUTES || '5');
const SOFT_CLOSE_EXTENSION_MINUTES = parseFloat(process.env.SOFT_CLOSE_EXTENSION_MINUTES || '5');
const TWILIO_ENABLED = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);

// ---------- Twilio client (falls back to console logging if not configured) ----------
let twilioClient = null;
if (TWILIO_ENABLED) {
  const twilio = require('twilio');
  twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
} else {
  console.warn('[sms] Twilio env vars not set — running in DEV MODE. Texts will be logged to the console instead of sent.');
}

async function sendSMS(to, body) {
  if (twilioClient) {
    try {
      await twilioClient.messages.create({ to, from: process.env.TWILIO_FROM_NUMBER, body });
    } catch (err) {
      console.error(`[sms] Failed to send to ${to}:`, err.message);
    }
  } else {
    console.log(`\n[DEV SMS] -> ${to}\n${body}\n`);
  }
}

// ---------- Database ----------
const dbPath = path.join(__dirname, 'data', 'lawnbid.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS pros (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    services TEXT NOT NULL,
    notes TEXT,
    yard_size TEXT,
    address TEXT NOT NULL,
    phone TEXT NOT NULL,
    photo_path TEXT,
    status TEXT NOT NULL DEFAULT 'open', -- open | matched | expired | cancelled
    winning_bid_id INTEGER,
    closes_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL,
    pro_phone TEXT NOT NULL,
    pro_name TEXT,
    price REAL NOT NULL,
    raw_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(job_id) REFERENCES jobs(id)
  );
`);

// ---------- File uploads ----------
const uploadDir = path.join(__dirname, 'uploads');
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
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // needed for Twilio's inbound webhook
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

// Normalize a phone number to a rough E.164-ish key for matching (US-centric default)
function normalizePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return raw && raw.startsWith('+') ? raw : '+' + digits;
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
  const timeStr = closesAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (closesAt.toDateString() === now.toDateString()) {
    return `${timeStr} today`;
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (closesAt.toDateString() === tomorrow.toDateString()) {
    return `${timeStr} tomorrow`;
  }
  const dateStr = closesAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${timeStr} on ${dateStr}`;
}

// ---------- Bidding window timing ----------
// During business hours, jobs get a flat BID_WINDOW_MINUTES to collect bids.
// Outside business hours (evenings, overnight, early morning), pros in a
// small network may not see the text until they're back at work, so the
// window instead runs until 1 hour after the next business-hours opening —
// giving them a real chance to see it and bid, rather than closing while
// everyone's asleep.
function nextBusinessOpenTime(now) {
  const currentHour = now.getHours() + now.getMinutes() / 60;
  const next = new Date(now);
  next.setHours(BUSINESS_HOURS_START, 0, 0, 0);
  if (currentHour >= BUSINESS_HOURS_START) {
    // We only get here when outside business hours, so being at/past the
    // opening hour means we're past closing — roll over to tomorrow.
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function computeInitialWindowMs(now) {
  const currentHour = now.getHours() + now.getMinutes() / 60;
  const inBusinessHours = currentHour >= BUSINESS_HOURS_START && currentHour < BUSINESS_HOURS_END;
  if (inBusinessHours) {
    return BID_WINDOW_MINUTES * 60 * 1000;
  }
  const msUntilOpen = nextBusinessOpenTime(now).getTime() - now.getTime();
  return msUntilOpen + (60 * 60 * 1000); // + 1 hour buffer past opening
}

// In-memory registry of the pending "close bidding" timer per job, so a
// late bid can push the close time back (soft close) by rescheduling it.
const jobTimers = new Map();

function scheduleClose(jobId, delayMs) {
  const existing = jobTimers.get(jobId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    jobTimers.delete(jobId);
    selectWinner(jobId).catch(err => console.error('selectWinner error:', err));
  }, Math.max(delayMs, 0));
  jobTimers.set(jobId, timer);
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

// On startup, re-arm timers for any jobs that were still open when the
// server last stopped (in-memory timers don't survive a restart).
function recoverOpenJobTimers() {
  const openJobs = db.prepare(`SELECT * FROM jobs WHERE status = 'open'`).all();
  const now = new Date();
  for (const job of openJobs) {
    const remainingMs = new Date(job.closes_at).getTime() - now.getTime();
    if (remainingMs <= 0) {
      selectWinner(job.id).catch(err => console.error('selectWinner error:', err));
    } else {
      scheduleClose(job.id, remainingMs);
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
    const windowMs = computeInitialWindowMs(now);
    const closesAt = new Date(now.getTime() + windowMs);

    const insert = db.prepare(`
      INSERT INTO jobs (services, notes, yard_size, address, phone, photo_path, closes_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const info = insert.run(JSON.stringify(services), notes, yardSize, address, phone, photoPath, closesAt.toISOString());
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(info.lastInsertRowid);

    // 3: text every active pro in the network
    const pros = db.prepare('SELECT * FROM pros WHERE active = 1').all();
    const text = jobSummaryText(job);
    await Promise.all(pros.map(p => sendSMS(p.phone, text)));

    // Let the homeowner know their request actually went out — otherwise
    // they hear nothing until a winner is picked, which can be many hours
    // away on an off-hours window.
    const expectedBy = formatExpectedReplyTime(closesAt, now);
    await sendSMS(job.phone,
      `Thank you for using Kirkwood Lawn and Landscape Finder. We've texted our lawncare pros. You should expect a reply by ${expectedBy}.`);

    // Auto-select the best bid once the bidding window closes
    scheduleClose(job.id, windowMs);

    res.json({ jobId: job.id, prosNotified: pros.length, closesAt: closesAt.toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ---------- 4: pros bid by replying to the text (Twilio inbound webhook) ----------
app.post('/api/sms-inbound', async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || '').trim();

  // Matches "BID 12 85", "bid #12 $85.50", "Bid: 12 - 85" etc.
  const match = body.match(/bid\D*(\d+)\D+\$?(\d+(?:\.\d{1,2})?)/i);

  let reply;
  if (!match) {
    reply = `Sorry, we couldn't read that bid. Reply like: BID <job number> <price>, e.g. BID 12 85`;
  } else {
    const jobId = parseInt(match[1], 10);
    const price = parseFloat(match[2]);
    const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);

    if (!job) {
      reply = `We don't have a job #${jobId} on file.`;
    } else if (job.status !== 'open') {
      reply = `Job #${jobId} is already closed — thanks for the interest.`;
    } else {
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

      if (price <= lowest) {
        reply = `Got it — your bid of $${price.toFixed(2)} on job #${jobId} is in, and it's currently the lowest bid. We'll text you if you're selected.`;
      } else {
        reply = `Got it — your bid of $${price.toFixed(2)} on job #${jobId} is in. Current lowest bid is $${lowest.toFixed(2)}. You can send a new bid anytime before we pick a winner, e.g. BID ${jobId} 65`;
      }
      if (extended) {
        reply += ` Bidding on this job was just extended by ${SOFT_CLOSE_EXTENSION_MINUTES} minutes.`;
      }
    }
  }

  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`);
});

function escapeXml(str) {
  return str.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// ---------- 4 (cont'd): backend selects the best bid and alerts the homeowner ----------
async function selectWinner(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || job.status !== 'open') return null;

  const bids = db.prepare('SELECT * FROM bids WHERE job_id = ? ORDER BY price ASC').all(jobId);

  if (!bids.length) {
    db.prepare(`UPDATE jobs SET status = 'expired' WHERE id = ?`).run(jobId);
    await sendSMS(job.phone, `No bids came in yet for job #${jobId}. We'll keep trying — reply here if you'd like to cancel.`);
    return null;
  }

  const winner = bids[0]; // lowest price wins; swap this line to change the selection rule
  db.prepare(`UPDATE jobs SET status = 'matched', winning_bid_id = ? WHERE id = ?`).run(winner.id, jobId);

  const proLabel = winner.pro_name || winner.pro_phone;
  await sendSMS(job.phone,
    `Your job #${jobId} got a bid! ${proLabel} offered $${winner.price.toFixed(2)}. They'll reach out at ${job.address} soon.`);
  await sendSMS(winner.pro_phone,
    `You won job #${jobId}! Homeowner phone: ${job.phone}. Address: ${job.address}. Please reach out to schedule.`);

  const losers = bids.slice(1);
  await Promise.all(losers.map(b =>
    sendSMS(b.pro_phone, `Job #${jobId} was awarded to another bidder this time. Thanks for bidding!`)));

  return winner;
}

// ---------- Admin: manage the pro network and review/override bids ----------
app.get('/api/admin/pros', (req, res) => {
  res.json(db.prepare('SELECT * FROM pros ORDER BY created_at DESC').all());
});

app.post('/api/admin/pros', (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
  try {
    const info = db.prepare('INSERT INTO pros (name, phone) VALUES (?, ?)').run(name, normalizePhone(phone));
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

app.get('/api/admin/jobs', (req, res) => {
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all();
  const withBids = jobs.map(j => ({
    ...j,
    services: JSON.parse(j.services),
    bids: db.prepare('SELECT * FROM bids WHERE job_id = ? ORDER BY price ASC').all(j.id)
  }));
  res.json(withBids);
});

// Manually pick a winner before the auto-timer fires
app.post('/api/admin/jobs/:id/select', async (req, res) => {
  const { bidId } = req.body;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const bid = db.prepare('SELECT * FROM bids WHERE id = ? AND job_id = ?').get(bidId, job.id);
  if (!bid) return res.status(404).json({ error: 'bid not found' });

  db.prepare(`UPDATE jobs SET status = 'matched', winning_bid_id = ? WHERE id = ?`).run(bid.id, job.id);
  const proLabel = bid.pro_name || bid.pro_phone;
  await sendSMS(job.phone, `Your job #${job.id} was matched! ${proLabel} offered $${bid.price.toFixed(2)}. They'll reach out soon.`);
  await sendSMS(bid.pro_phone, `You won job #${job.id}! Homeowner phone: ${job.phone}. Address: ${job.address}.`);

  const others = db.prepare('SELECT * FROM bids WHERE job_id = ? AND id != ?').all(job.id, bid.id);
  await Promise.all(others.map(b => sendSMS(b.pro_phone, `Job #${job.id} was awarded to another bidder. Thanks for bidding!`)));

  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Lawn Bid app running at http://localhost:${PORT}`);
  console.log(`Admin dashboard at http://localhost:${PORT}/admin.html`);
  if (!TWILIO_ENABLED) console.log('Running without Twilio — SMS will print to this console.');
  recoverOpenJobTimers();
});
