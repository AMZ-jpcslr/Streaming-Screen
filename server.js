const path = require('path');
const fs = require('fs');
const express = require('express');
const cookieSession = require('cookie-session');
const { google } = require('googleapis');
const multer = require('multer');

const app = express();

// ---- Process-level diagnostics (helps on Railway 502 / crashes) ----
process.on('uncaughtException', (err) => {
  // eslint-disable-next-line no-console
  console.error('[fatal] uncaughtException', err);
});

process.on('unhandledRejection', (err) => {
  // eslint-disable-next-line no-console
  console.error('[fatal] unhandledRejection', err);
});

// Railway / Heroku style: platform provides PORT
const port = Number(process.env.PORT || 3000);

const rootDir = __dirname;
const settingsPath = path.join(rootDir, 'settings.json');
const uploadsDir = path.join(rootDir, 'uploads');
const uploadedLogoBasePath = path.join(uploadsDir, 'logo');

function ensureUploadsDir() {
  try {
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  } catch (_) {
    // ignore
  }
}

function readSettings() {
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const json = JSON.parse(raw);
    return (json && typeof json === 'object') ? json : {};
  } catch (_) {
    return {};
  }
}

function writeSettings(obj) {
  const safe = (obj && typeof obj === 'object') ? obj : {};
  fs.writeFileSync(settingsPath, JSON.stringify(safe, null, 2), 'utf8');
}

// ===== Control (admin) protection =====
// Simple option: HTTP Basic Auth.
// Set CONTROL_USER / CONTROL_PASS in Railway Variables.
// If both are empty, control endpoints are unprotected.
const CONTROL_USER = process.env.CONTROL_USER || '';
const CONTROL_PASS = process.env.CONTROL_PASS || '';

function hasControlAuthConfigured() {
  return Boolean(CONTROL_USER || CONTROL_PASS);
}

function unauthorizedBasic(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Streaming-Screen Control"');
  res.status(401).send('Unauthorized');
}

function checkBasicAuth(req) {
  if (!hasControlAuthConfigured()) return true;
  const hdr = String(req.get('authorization') || '');
  const m = /^Basic\s+(.+)$/i.exec(hdr);
  if (!m) return false;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    return user === CONTROL_USER && pass === CONTROL_PASS;
  } catch (_) {
    return false;
  }
}

function requireControl(req, res, next) {
  if (checkBasicAuth(req)) return next();
  return unauthorizedBasic(res);
}

// ===== Self test (no HTTP) =====
// Some environments (like sandboxed VS Code terminals) may not allow
// loopback connections for smoke tests. Provide a CLI self-test for
// Basic Auth parsing/verification.
//
// Usage:
//   CONTROL_USER=u CONTROL_PASS=p node server.js --selftest
//
// Exit code:
//   0 = pass, 1 = fail
function basicAuthMatchesHeader(authorizationHeader) {
  if (!hasControlAuthConfigured()) return true;
  const hdr = String(authorizationHeader || '');
  const m = /^Basic\s+(.+)$/i.exec(hdr);
  if (!m) return false;
  try {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
    const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
    return user === CONTROL_USER && pass === CONTROL_PASS;
  } catch (_) {
    return false;
  }
}

function runSelfTestAndExit() {
  const user = CONTROL_USER;
  const pass = CONTROL_PASS;

  if (!hasControlAuthConfigured()) {
    // eslint-disable-next-line no-console
    console.log('[selftest] CONTROL_USER / CONTROL_PASS are not set -> control endpoints are unprotected (PASS).');
    process.exit(0);
  }

  const okHeader = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
  const badHeader = `Basic ${Buffer.from(`${user}:${pass}_wrong`, 'utf8').toString('base64')}`;

  const ok = basicAuthMatchesHeader(okHeader) === true;
  const ng = basicAuthMatchesHeader(badHeader) === false;
  const none = basicAuthMatchesHeader('') === false;

  const passAll = ok && ng && none;

  // eslint-disable-next-line no-console
  console.log(`[selftest] okHeader: ${ok ? 'PASS' : 'FAIL'}`);
  // eslint-disable-next-line no-console
  console.log(`[selftest] badHeader: ${ng ? 'PASS' : 'FAIL'}`);
  // eslint-disable-next-line no-console
  console.log(`[selftest] missingHeader: ${none ? 'PASS' : 'FAIL'}`);

  process.exit(passAll ? 0 : 1);
}

if (process.argv.includes('--selftest')) {
  runSelfTestAndExit();
}

// ===== YouTube API / OAuth config =====
// Required env vars:
//   YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REDIRECT_URL
// Optional:
//   YT_CHANNEL_ID (to pick a channel if the account has multiple)
//   YT_POLL_MS (default 10000)
//   SESSION_SECRET (cookie encryption secret)
const YT_CLIENT_ID = process.env.YT_CLIENT_ID || '';
const YT_CLIENT_SECRET = process.env.YT_CLIENT_SECRET || '';
const YT_REDIRECT_URL = process.env.YT_REDIRECT_URL || '';
const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID || '';
// Default polling interval (ms). YouTube may return pollingIntervalMillis which must be respected.
// We treat this as a *minimum* interval; lowering it increases responsiveness but may increase quota usage.
const YT_POLL_MS = Number(process.env.YT_POLL_MS || 15000);
// Manual switch: if false, do not poll YouTube at all (prevents quota burn)
// Can be toggled at runtime via /api/yt/enabled
let ytEnabled = String(process.env.YT_ENABLED || '0') === '1';
const YT_CHANNEL_TTL_MS = Number(process.env.YT_CHANNEL_TTL_MS || 6 * 60 * 60 * 1000); // 6h
const YT_BACKOFF_MAX_MS = Number(process.env.YT_BACKOFF_MAX_MS || 30 * 60 * 1000); // 30m

const oauthConfigured = Boolean(YT_CLIENT_ID && YT_CLIENT_SECRET && YT_REDIRECT_URL);

// Startup summary (do not log secrets)
// eslint-disable-next-line no-console
console.log('[boot] oauthConfigured=%s ytEnabled=%s port=%s host=%s redirectUrl=%s', oauthConfigured, ytEnabled, port, process.env.HOST || '0.0.0.0', Boolean(YT_REDIRECT_URL));

app.use(cookieSession({
  name: 'ss_session',
  // NOTE: On Railway, set SESSION_SECRET to a long random string.
  secret: process.env.SESSION_SECRET || 'dev_only_change_me',
  httpOnly: true,
  sameSite: 'lax',
  // Prefer secure cookies on HTTPS. Railway is typically behind a proxy.
  secure: (process.env.NODE_ENV === 'production'),
  maxAge: 7 * 24 * 60 * 60 * 1000
}));

// Trust proxy so req.secure / secure cookies behave correctly behind Railway.
app.set('trust proxy', 1);

function createOAuthClient() {
  return new google.auth.OAuth2(YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REDIRECT_URL);
}

function escapeSseData(obj) {
  return JSON.stringify(obj).replace(/\u2028|\u2029/g, '');
}

// In-memory event fanout (good enough for single-instance hosting).
// If Railway scales to multiple instances, you'd need Redis or similar.
const sseClients = new Set();
let pollTimer = null;
let lastSeenMessageId = null;
let activeLiveChatId = null;
let nextPageToken = null;
let lastStatus = { kind: 'status', level: 'info', message: 'idle', ts: new Date().toISOString() };
let lastPollAt = null;
let authedChannel = null; // { id, title }
let activeBroadcast = null; // { id, title }
let authedChannelAt = null;

let pollTimeout = null;
let nextPollAt = null;
let lastPollMsEffective = null;
let backoffUntil = null;
let backoffMs = 0;

function nowIso() { return new Date().toISOString(); }

function isQuotaExceededError(e) {
  const msg = String(e?.message || '').toLowerCase();
  const reason = String(e?.errors?.[0]?.reason || e?.response?.data?.error?.errors?.[0]?.reason || '').toLowerCase();
  return msg.includes('exceeded your quota') || reason === 'quotaexceeded' || msg.includes('quotaexceeded');
}

function isChatNoLongerLiveError(e) {
  const msg = String(e?.message || '').toLowerCase();
  const reason = String(e?.errors?.[0]?.reason || e?.response?.data?.error?.errors?.[0]?.reason || '').toLowerCase();
  return msg.includes('live chat is no longer live') || reason === 'livechatnotfound' || reason === 'livechatclosed';
}

function summarizeGoogleApiError(e) {
  try {
    const status = e?.code || e?.response?.status;
    const reason = e?.errors?.[0]?.reason || e?.response?.data?.error?.errors?.[0]?.reason;
    const message = e?.message || e?.response?.data?.error?.message;
    return {
      status: status ?? null,
      reason: reason ? String(reason) : null,
      message: message ? String(message) : String(e)
    };
  } catch (_) {
    return { status: null, reason: null, message: String(e) };
  }
}

function resetLiveState(reason) {
  lastSeenMessageId = null;
  nextPageToken = null;
  activeLiveChatId = null;
  activeBroadcast = null;
  if (reason) {
    broadcastEvent({ kind: 'status', level: 'warn', message: reason });
  }
}

function scheduleNextPoll(session, ms, reason) {
  if (pollTimeout) clearTimeout(pollTimeout);
  const delay = Math.max(1200, Number(ms) || 1200);
  lastPollMsEffective = delay;
  nextPollAt = new Date(Date.now() + delay).toISOString();
  pollTimeout = setTimeout(() => pollLoop(session), delay);
  if (reason) {
    broadcastEvent({ kind: 'status', level: 'info', message: `次回ポーリング: ${Math.round(delay)}ms後（${reason}）` });
  }
}

function stopPolling(reason) {
  if (pollTimeout) {
    clearTimeout(pollTimeout);
    pollTimeout = null;
  }
  nextPollAt = null;
  if (reason) {
    broadcastEvent({ kind: 'status', level: 'warn', message: reason });
  }
}

function broadcastEvent(evt) {
  // Keep last status for debugging UIs
  if (evt?.kind === 'status') {
    lastStatus = { ...evt, ts: new Date().toISOString() };
  }
  const payload = `event: yt\ndata: ${escapeSseData(evt)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { /* ignore */ }
  }
}

async function getLiveChatId(youtube) {
  // Find the channel's active live broadcast and return liveChatId.
  // Note: This requires the authorized account to have access.
  // IMPORTANT: `mine` and `broadcastStatus` are incompatible in YouTube Data API.
  // Use `status=active` instead.
  // Ref: error "Incompatible parameters specified in the request: mine, broadcastStatus"
  const list = await youtube.liveBroadcasts.list({
    part: ['snippet'],
    mine: true,
    status: 'active',
    maxResults: 5
  });
  const items = list.data.items || [];
  const active = items[0];
  activeBroadcast = active ? {
    id: active.id,
    title: active?.snippet?.title || ''
  } : null;
  return active?.snippet?.liveChatId || null;
}

async function getAuthedChannel(youtube) {
  const resp = await youtube.channels.list({
    part: ['snippet'],
    mine: true,
    maxResults: 5
  });
  const items = resp.data.items || [];
  const ch = items[0];
  return ch ? { id: ch.id, title: ch?.snippet?.title || '' } : null;
}

function classifySpecialEvent(item) {
  // liveChatMessage resource fields:
  // https://developers.google.com/youtube/v3/live/docs/liveChatMessage
  const details = item?.snippet?.superChatDetails;
  const member = item?.snippet?.newSponsorDetails;

  if (details) {
    return {
      type: 'superchat',
      amount: details.amountDisplayString,
      tier: details.tier
    };
  }

  if (member) {
    // Membership (new/upgrade). Gift events are NOT reliably exposed via this endpoint.
    return {
      type: 'membership',
      level: member.membershipLevelName
    };
  }

  // Best-effort: infer membership gift events from system messages.
  // This is NOT guaranteed and can break with locale/format changes.
  // We intentionally keep patterns broad but not too broad.
  const msg = String(item?.snippet?.displayMessage || '').trim();
  if (msg) {
    const patterns = [
      // English (examples vary)
      /gift(ed)?\s+\d+\s+memberships?/i,
      /gift(ed)?\s+a\s+membership/i,
      /gave\s+\d+\s+memberships?/i,
      /sent\s+\d+\s+membership\s+gifts?/i,
      // Japanese (examples vary)
      /メンバーシップ\s*ギフト/i,
      /メンバーシップを\s*\d+\s*件\s*ギフト/i,
      /\d+\s*件のメンバーシップ(を)?\s*ギフト/i,
      /メンバーシップをギフトしました/i,
      /メンバーシップ\s*\d+\s*個\s*ギフト/i,
    ];
    if (patterns.some((re) => re.test(msg))) {
      return { type: 'gift', message: msg };
    }
  }

  return null;
}

async function pollLiveChat(oauthTokens) {
  if (!oauthConfigured) return;
  if (!oauthTokens) return;

  lastPollAt = nowIso();

  const auth = createOAuthClient();
  auth.setCredentials(oauthTokens);
  const youtube = google.youtube({ version: 'v3', auth });

  // Cache which channel is actually authorized (helps debugging)
  const shouldRefreshChannel = !authedChannelAt || (Date.now() - new Date(authedChannelAt).getTime()) > YT_CHANNEL_TTL_MS;
  if (!authedChannel || shouldRefreshChannel) {
    try {
      authedChannel = await getAuthedChannel(youtube);
      authedChannelAt = nowIso();
      if (authedChannel?.title) {
        broadcastEvent({ kind: 'status', level: 'info', message: `認可チャンネル: ${authedChannel.title}` });
      }
    } catch (e) {
      const info = summarizeGoogleApiError(e);
      broadcastEvent({
        kind: 'status',
        level: 'warn',
        message: `channels.list failed: ${info.status ?? '-'} ${info.reason ?? ''} ${info.message}`.trim()
      });

      // Best-effort refresh: if access token expired but refresh_token exists, refresh once.
      // cookie-session stores tokens; we update the in-memory object so later calls can succeed.
      if (oauthTokens?.refresh_token) {
        try {
          const refreshed = await auth.refreshAccessToken();
          if (refreshed?.credentials) {
            oauthTokens.access_token = refreshed.credentials.access_token || oauthTokens.access_token;
            oauthTokens.expiry_date = refreshed.credentials.expiry_date || oauthTokens.expiry_date;
            // Note: refresh_token usually isn't returned again.
            broadcastEvent({ kind: 'status', level: 'info', message: 'アクセストークンを更新しました（retry）' });
            // Retry channel lookup once
            authedChannel = await getAuthedChannel(youtube);
            authedChannelAt = nowIso();
            if (authedChannel?.title) {
              broadcastEvent({ kind: 'status', level: 'info', message: `認可チャンネル: ${authedChannel.title}` });
            }
          }
        } catch (e2) {
          const info2 = summarizeGoogleApiError(e2);
          broadcastEvent({
            kind: 'status',
            level: 'warn',
            message: `token refresh failed: ${info2.status ?? '-'} ${info2.reason ?? ''} ${info2.message}`.trim()
          });
        }
      }
    }
  }

  // Ensure chat id
  if (!activeLiveChatId) {
    activeLiveChatId = await getLiveChatId(youtube);
    if (!activeLiveChatId) {
      broadcastEvent({ kind: 'status', level: 'warn', message: '配信中のライブが見つかりません（liveBroadcasts.list）' });
      return;
    }
    broadcastEvent({ kind: 'status', level: 'info', message: 'ライブチャットIDを取得しました' });
  }

  broadcastEvent({ kind: 'status', level: 'info', message: 'YouTubeコメントを取得中…' });

  const resp = await youtube.liveChatMessages.list({
    liveChatId: activeLiveChatId,
    part: ['snippet', 'authorDetails'],
    maxResults: 200,
    pageToken: nextPageToken || undefined
  });

  const items = resp.data.items || [];

  // For incremental polling, the API returns a token to get the next page of new messages.
  // Using this is more reliable than manual lastSeen scanning.
  nextPageToken = resp.data.nextPageToken || nextPageToken;

  // Display messages in chronological order. The list can be newest-first.
  const toProcess = items.slice().reverse();

  for (const item of toProcess) {
    const id = item.id;

    const name = item?.authorDetails?.displayName || 'Someone';
    const text = String(item?.snippet?.displayMessage || '').trim();

  const isOwner = Boolean(item?.authorDetails?.isChatOwner);
  const isMod = Boolean(item?.authorDetails?.isChatModerator);
  const isMember = Boolean(item?.authorDetails?.isChatSponsor);
  const role = isOwner ? 'owner' : (isMod ? 'mod' : (isMember ? 'member' : ''));

    // Always broadcast normal chat messages (best-effort)
    if (text) {
      broadcastEvent({
        kind: 'chat',
        id,
        name,
        text,
        role,
        isOwner,
        isMod,
        isMember,
        publishedAt: item?.snippet?.publishedAt || null
      });
    }

    const special = classifySpecialEvent(item);
    if (special) {
      if (special.type === 'superchat') {
        broadcastEvent({
          kind: 'toast',
          type: 'superchat',
          title: 'SUPER CHAT',
          body: `${name}：${special.amount}  ${text}`.trim(),
          ms: 9000
        });
      } else if (special.type === 'membership') {
        broadcastEvent({
          kind: 'toast',
          type: 'membership',
          title: 'MEMBERSHIP',
          body: `${name}：メンバーになりました${special.level ? `（${special.level}）` : ''}`,
          ms: 9000
        });
      } else if (special.type === 'gift') {
        // Best-effort inferred gift message
        broadcastEvent({
          kind: 'toast',
          type: 'gift',
          title: 'GIFT',
          body: `${name}：${special.message}`,
          ms: 9000
        });
      }
    }
  }

  if (items.length > 0) {
    // newest is first in original list
    lastSeenMessageId = items[0].id;
  }

  const pollMsFromApi = Number(resp?.data?.pollingIntervalMillis || 0);
  broadcastEvent({ kind: 'status', level: 'info', message: `取得完了（items=${items.length} / next=${nextPageToken ? 'yes' : 'no'} / apiPoll=${pollMsFromApi || '-'}ms）` });

  return {
    pollMsFromApi: pollMsFromApi || null
  };
}

async function pollLoop(session) {
  if (!ytEnabled) {
    stopPolling('YouTubeコメント取得: OFF');
    return;
  }
  // If quota exceeded backoff is active, stop until backoff expires.
  if (backoffUntil && Date.now() < new Date(backoffUntil).getTime()) {
    scheduleNextPoll(session, new Date(backoffUntil).getTime() - Date.now(), 'quota backoff');
    return;
  }

  try {
    const r = await pollLiveChat(session?.oauthTokens);
    // Success: reset backoff
    backoffUntil = null;
    backoffMs = 0;

    const apiMs = Number(r?.pollMsFromApi || 0);
    // Prefer YouTube's suggested interval; fall back to env.
    const baseMs = Math.max(1200, YT_POLL_MS);
    const nextMs = apiMs > 0 ? Math.max(baseMs, apiMs) : baseMs;
    scheduleNextPoll(session, nextMs, apiMs > 0 ? 'api interval' : 'env interval');
  } catch (e) {
    const quota = isQuotaExceededError(e);
    const chatClosed = isChatNoLongerLiveError(e);
    const msg = `poll error: ${e?.message || e}`;
    broadcastEvent({ kind: 'status', level: (quota || chatClosed) ? 'error' : 'warn', message: msg });

    if (chatClosed) {
      // The broadcast ended or the chatId became invalid.
      // Reset state so next loop will re-detect an active broadcast.
      resetLiveState('ライブチャットが終了しました（再検出します）');
      // Slow down a bit to avoid hammering.
      scheduleNextPoll(session, Math.max(15_000, Math.max(1200, YT_POLL_MS)), 'chat ended');
      return;
    }

    if (quota) {
      // Exponential backoff up to max.
      backoffMs = backoffMs ? Math.min(backoffMs * 2, YT_BACKOFF_MAX_MS) : Math.min(60_000, YT_BACKOFF_MAX_MS);
      backoffUntil = new Date(Date.now() + backoffMs).toISOString();
      broadcastEvent({ kind: 'status', level: 'warn', message: `クォータ超過のため一時停止します（${Math.round(backoffMs / 1000)}秒）` });
      scheduleNextPoll(session, backoffMs, 'quota backoff');
      return;
    }

    // Non-quota: wait a bit and retry
  scheduleNextPoll(session, Math.max(15_000, Math.max(1200, YT_POLL_MS)), 'retry');
  }
}

function ensurePolling(session) {
  if (!ytEnabled) return;
  if (pollTimeout) return;
  scheduleNextPoll(session, Math.max(1200, YT_POLL_MS), 'start');
}

// Static assets (logo, bottom bar image, etc.)
app.use('/assets', express.static(path.join(rootDir, 'assets'), {
  fallthrough: true,
  etag: true,
  maxAge: '1h'
}));

// Uploaded assets (admin-managed, e.g. logo)
ensureUploadsDir();
app.use('/uploads', express.static(uploadsDir, {
  fallthrough: true,
  etag: true,
  maxAge: '1h'
}));

// ---- Admin upload endpoints ----
// Upload a logo image and expose it at /uploads/logo (no extension).
// Control auth required.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024 // 2MB
  }
});

app.post('/api/upload/logo', requireControl, upload.single('logo'), (req, res) => {
  try {
    const f = req.file;
    if (!f || !f.buffer) {
      res.status(400).json({ ok: false, error: 'missing_file' });
      return;
    }

    const mime = String(f.mimetype || '').toLowerCase();
    const allowed = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);
    if (!allowed.has(mime)) {
      res.status(400).json({ ok: false, error: 'unsupported_type', mime });
      return;
    }

    const extByMime = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif'
    };
    const ext = extByMime[mime] || '';

    ensureUploadsDir();

    // Remove old logo variants so only one exists.
    for (const e of Object.values(extByMime)) {
      const p = uploadedLogoBasePath + e;
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* ignore */ }
    }

    const filePath = uploadedLogoBasePath + ext;
    fs.writeFileSync(filePath, f.buffer);

    // Cache-busting URL so clients update immediately.
    const url = `/uploads/logo?v=${Date.now()}`;
    res.status(200).json({ ok: true, url, mime });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[upload] logo failed', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// Stable logo URL that redirects to the actual file with extension.
// This makes the browser infer the right content-type/decoder reliably.
app.get('/uploads/logo', (_req, res) => {
  try {
    const candidates = ['.png', '.jpg', '.webp', '.gif'].map((e) => uploadedLogoBasePath + e);
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) {
      res.status(404).send('not found');
      return;
    }
    const ext = path.extname(found);
    res.redirect(302, `/uploads/logo${ext}`);
  } catch (_) {
    res.status(500).send('internal_error');
  }
});

// ---- Auth endpoints ----
app.get('/api/auth/status', (req, res) => {
  res.json({
    oauthConfigured,
    authed: Boolean(req.session?.oauthTokens),
    redirectUrl: YT_REDIRECT_URL ? true : false
  });
});

// Basic health endpoint (Railway/uptime checks)
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
});

app.get('/api/auth/start', (req, res) => {
  if (!oauthConfigured) {
    res.status(500).send('OAuth env vars are not configured. Please set YT_CLIENT_ID / YT_CLIENT_SECRET / YT_REDIRECT_URL.');
    return;
  }
  const auth = createOAuthClient();
  const scopes = [
    'https://www.googleapis.com/auth/youtube.readonly'
  ];
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes
  });
  res.redirect(url);
});

app.get('/api/auth/callback', async (req, res) => {
  if (!oauthConfigured) {
    res.status(500).send('OAuth env vars are not configured.');
    return;
  }
  const code = req.query.code;
  if (!code) {
    res.status(400).send('Missing code');
    return;
  }
  const auth = createOAuthClient();
  const { tokens } = await auth.getToken(String(code));
  req.session.oauthTokens = tokens;
  // Reset polling markers
  lastSeenMessageId = null;
  activeLiveChatId = null;
  nextPageToken = null;
  authedChannel = null;
  activeBroadcast = null;
  authedChannelAt = null;
  backoffUntil = null;
  backoffMs = 0;
  // Start polling only if enabled
  ensurePolling(req.session);
  res.redirect('/');
});

app.get('/api/auth/logout', (req, res) => {
  req.session = null;
  lastSeenMessageId = null;
  activeLiveChatId = null;
  nextPageToken = null;
  authedChannel = null;
  activeBroadcast = null;
  authedChannelAt = null;
  backoffUntil = null;
  backoffMs = 0;
  stopPolling('ログアウトしました（polling停止）');
  res.redirect('/');
});

// ---- Manual YouTube polling switch ----
app.get('/api/yt/enabled', (_req, res) => {
  res.json({ ytEnabled });
});

app.post('/api/yt/enabled', requireControl, express.json(), (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  ytEnabled = enabled;

  if (!ytEnabled) {
    backoffUntil = null;
    backoffMs = 0;
    resetLiveState('YouTubeコメント取得をOFFにしました');
    stopPolling('YouTubeコメント取得: OFF');
  } else {
    backoffUntil = null;
    backoffMs = 0;
    resetLiveState('YouTubeコメント取得をONにしました（再検出します）');
  }

  res.json({ ytEnabled });
});

// ---- Overlay settings (saved) ----
// GET is public so overlay clients can read the saved defaults.
app.get('/api/settings', (_req, res) => {
  res.json(readSettings());
});

// POST requires control token.
app.post('/api/settings', requireControl, express.json({ limit: '64kb' }), (req, res) => {
  const b = req.body || {};

  // Keep it intentionally small/safe: only allow expected keys.
  const next = {
    announce: typeof b.announce === 'string' ? b.announce : '',
    xid: typeof b.xid === 'string' ? b.xid : '',
    fanart: typeof b.fanart === 'string' ? b.fanart : '',
    logo: typeof b.logo === 'string' ? b.logo : '',
    logoZoom: typeof b.logoZoom === 'number' ? b.logoZoom : (typeof b.logoZoom === 'string' ? Number(b.logoZoom) : undefined),
    chat: typeof b.chat === 'string' ? b.chat : ''
  };
  if (!Number.isFinite(next.logoZoom)) delete next.logoZoom;

  writeSettings(next);
  res.json({ ok: true, settings: next });
});

// ---- Debug state endpoint (for preview UI) ----
app.get('/api/yt/state', (req, res) => {
  res.json({
    oauthConfigured,
    authed: Boolean(req.session?.oauthTokens),
    hasRefreshToken: Boolean(req.session?.oauthTokens?.refresh_token),
    ytEnabled,
    pollMs: Math.max(1200, YT_POLL_MS),
    pollMsEffective: lastPollMsEffective,
    polling: Boolean(pollTimeout),
    nextPollAt,
    backoffUntil,
    sseClients: sseClients.size,
    authedChannel,
    authedChannelAt,
    activeBroadcast,
    activeLiveChatId: activeLiveChatId || null,
    lastSeenMessageId: lastSeenMessageId || null,
    lastPollAt,
    lastStatus
  });
});

// ---- Diagnostics endpoint (preview/debug) ----
// Returns structured details to quickly identify why authedChannel stays '-' or why live isn't detected.
// This endpoint does NOT expose raw tokens.
app.get('/api/yt/diagnose', async (req, res) => {
  const tokens = req.session?.oauthTokens;
  if (!oauthConfigured) {
    res.status(200).json({
      ok: false,
      reason: 'oauth_not_configured',
      oauthConfigured,
      ytEnabled,
    });
    return;
  }
  if (!tokens) {
    res.status(200).json({
      ok: false,
      reason: 'not_authed',
      oauthConfigured,
      ytEnabled,
    });
    return;
  }

  const safeTokenInfo = {
    hasAccessToken: Boolean(tokens.access_token),
    hasRefreshToken: Boolean(tokens.refresh_token),
    tokenType: tokens.token_type || null,
    scope: tokens.scope || null,
    expiryDate: typeof tokens.expiry_date === 'number' ? new Date(tokens.expiry_date).toISOString() : null,
    expired: (typeof tokens.expiry_date === 'number') ? (Date.now() > tokens.expiry_date) : null,
  };

  const auth = createOAuthClient();
  auth.setCredentials(tokens);
  const youtube = google.youtube({ version: 'v3', auth });

  const out = {
    ok: true,
    oauthConfigured,
    ytEnabled,
    token: safeTokenInfo,
    checks: {
      channelsList: null,
      liveBroadcastsList: null,
    },
  };

  // channels.list (mine=true)
  try {
    const r = await youtube.channels.list({ part: ['snippet'], mine: true, maxResults: 5 });
    const items = r?.data?.items || [];
    out.checks.channelsList = {
      ok: true,
      count: items.length,
      first: items[0] ? { id: items[0].id || null, title: items[0]?.snippet?.title || '' } : null,
    };
  } catch (e) {
    const info = summarizeGoogleApiError(e);
    out.checks.channelsList = { ok: false, error: info };
  }

  // liveBroadcasts.list (mine=true, status=active)
  try {
    const r = await youtube.liveBroadcasts.list({ part: ['snippet'], mine: true, status: 'active', maxResults: 5 });
    const items = r?.data?.items || [];
    const first = items[0];
    out.checks.liveBroadcastsList = {
      ok: true,
      count: items.length,
      first: first ? {
        id: first.id || null,
        title: first?.snippet?.title || '',
        liveChatId: first?.snippet?.liveChatId || null,
      } : null,
    };
  } catch (e) {
    const info = summarizeGoogleApiError(e);
    out.checks.liveBroadcastsList = { ok: false, error: info };
  }

  res.status(200).json(out);
});

// ---- SSE events endpoint ----
app.get('/api/events', (req, res) => {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');

  // Initial ping
  res.write(`event: yt\ndata: ${escapeSseData({ kind: 'status', level: 'info', message: 'connected' })}\n\n`);

  sseClients.add(res);

  // Start polling for this session (single session model)
  ensurePolling(req.session);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Serve main.html at /
app.get('/', (_req, res) => {
  res.sendFile(path.join(rootDir, 'main.html'));
});

// Optional: allow /main.html
app.get('/main.html', (_req, res) => {
  res.sendFile(path.join(rootDir, 'main.html'));
});

// Control page
app.get('/control', requireControl, (_req, res) => {
  res.sendFile(path.join(rootDir, 'control.html'));
});

app.get('/control.html', requireControl, (_req, res) => {
  res.sendFile(path.join(rootDir, 'control.html'));
});

const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`Streaming-Screen listening on http://${host}:${port}`);
});
