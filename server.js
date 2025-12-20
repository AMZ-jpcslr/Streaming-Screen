const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const { google } = require('googleapis');

const app = express();

// Railway / Heroku style: platform provides PORT
const port = Number(process.env.PORT || 3000);

const rootDir = __dirname;

// ===== YouTube API / OAuth config =====
// Required env vars:
//   YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REDIRECT_URL
// Optional:
//   YT_CHANNEL_ID (to pick a channel if the account has multiple)
//   YT_POLL_MS (default 2500)
//   SESSION_SECRET (cookie encryption secret)
const YT_CLIENT_ID = process.env.YT_CLIENT_ID || '';
const YT_CLIENT_SECRET = process.env.YT_CLIENT_SECRET || '';
const YT_REDIRECT_URL = process.env.YT_REDIRECT_URL || '';
const YT_CHANNEL_ID = process.env.YT_CHANNEL_ID || '';
const YT_POLL_MS = Number(process.env.YT_POLL_MS || 2500);

const oauthConfigured = Boolean(YT_CLIENT_ID && YT_CLIENT_SECRET && YT_REDIRECT_URL);

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

  lastPollAt = new Date().toISOString();

  const auth = createOAuthClient();
  auth.setCredentials(oauthTokens);
  const youtube = google.youtube({ version: 'v3', auth });

  // Cache which channel is actually authorized (helps debugging)
  if (!authedChannel) {
    try {
      authedChannel = await getAuthedChannel(youtube);
      if (authedChannel?.title) {
        broadcastEvent({ kind: 'status', level: 'info', message: `認可チャンネル: ${authedChannel.title}` });
      }
    } catch (e) {
      broadcastEvent({ kind: 'status', level: 'warn', message: `channels.list failed: ${e?.message || e}` });
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

    // Always broadcast normal chat messages (best-effort)
    if (text) {
      broadcastEvent({
        kind: 'chat',
        id,
        name,
        text,
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

  broadcastEvent({ kind: 'status', level: 'info', message: `取得完了（items=${items.length}）` });
}

function ensurePolling(session) {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      await pollLiveChat(session?.oauthTokens);
    } catch (e) {
      broadcastEvent({ kind: 'status', level: 'error', message: `poll error: ${e?.message || e}` });
    }
  }, Math.max(1200, YT_POLL_MS));
}

// Static assets (logo, bottom bar image, etc.)
app.use('/assets', express.static(path.join(rootDir, 'assets'), {
  fallthrough: true,
  etag: true,
  maxAge: '1h'
}));

// ---- Auth endpoints ----
app.get('/api/auth/status', (req, res) => {
  res.json({
    oauthConfigured,
    authed: Boolean(req.session?.oauthTokens),
    redirectUrl: YT_REDIRECT_URL ? true : false
  });
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
  res.redirect('/');
});

// ---- Debug state endpoint (for preview UI) ----
app.get('/api/yt/state', (req, res) => {
  res.json({
    oauthConfigured,
    authed: Boolean(req.session?.oauthTokens),
    hasRefreshToken: Boolean(req.session?.oauthTokens?.refresh_token),
    pollMs: Math.max(1200, YT_POLL_MS),
    polling: Boolean(pollTimer),
    sseClients: sseClients.size,
    authedChannel,
    activeBroadcast,
    activeLiveChatId: activeLiveChatId || null,
    lastSeenMessageId: lastSeenMessageId || null,
    lastPollAt,
    lastStatus
  });
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

app.listen(port, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`Streaming-Screen listening on port ${port}`);
});
