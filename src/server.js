require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');

const scrapeRoutes = require('./routes/scrape');
const { router: authRouter } = require('./routes/auth');
const shopRoutes   = require('./routes/shopRoutes');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// ── Proxy image
app.get('/proxy-image', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.aliexpress.com/',
        'Accept': 'image/webp,image/jpeg,image/*'
      }
    });
    const ct = response.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(response.data));
  } catch {
    res.status(502).send('Image fetch failed');
  }
});

// ── Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── Routes API
app.use('/api', scrapeRoutes);
app.use('/api/auth', authRouter);
app.use('/api/shops', shopRoutes);

// ── Pages
app.get('/loading',        (req, res) => res.sendFile(path.join(__dirname, '../public/loading.html')));
app.get('/',               (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/finder',         (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/niche-list',     (req, res) => res.sendFile(path.join(__dirname, '../public/niche-list.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, '../public/reset-password.html')));

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
