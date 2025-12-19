const path = require('path');
const express = require('express');

const app = express();

// Railway / Heroku style: platform provides PORT
const port = Number(process.env.PORT || 3000);

const rootDir = __dirname;

// Static assets (logo, bottom bar image, etc.)
app.use('/assets', express.static(path.join(rootDir, 'assets'), {
  fallthrough: true,
  etag: true,
  maxAge: '1h'
}));

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
