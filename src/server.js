require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const { Server } = require('socket.io');

const scrapeRoutes = require('./routes/scrape');
const { router: authRouter } = require('./routes/auth');
const shopRoutes   = require('./routes/shopRoutes');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});
const PORT   = process.env.PORT || 3000;

// ── Online users tracking ──
let onlineCount = 0;

io.on('connection', (socket) => {
  onlineCount++;
  io.emit('online_count', onlineCount);

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit('online_count', onlineCount);
  });
});

app.get('/api/online-count', (req, res) => {
  res.json({ count: onlineCount });
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// ── Proxy image ──
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

// ── Health check ──
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ── Routes API ──
app.use('/api', scrapeRoutes);
app.use('/api/auth', authRouter);
app.use('/api/shops', shopRoutes);

// ── Pages ──
app.get('/',               (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/finder',         (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/niche-list',     (req, res) => res.sendFile(path.join(__dirname, '../public/niche-list.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(__dirname, '../public/reset-password.html')));

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

// ── Keep-alive DINOv2 intelligent ──
const { isClipAvailable } = require('./services/dinoCompare');

const KEEPALIVE_NORMAL_MS  = 4 * 60 * 1000;
const KEEPALIVE_URGENT_MS  = 20 * 1000;

let keepaliveTimer = null;

async function runKeepalive() {
  try {
    const { available, status } = await isClipAvailable();

    if (!available || status === null) {
      console.log('[clip-keepalive] ⚠️ Service DINOv2 indisponible — ping accéléré (20s)');
      scheduleKeepalive(KEEPALIVE_URGENT_MS);
    } else if (status === 'loading') {
      console.log('[clip-keepalive] 🔄 DINOv2 en cours de chargement (cold start) — ping accéléré (20s)');
      scheduleKeepalive(KEEPALIVE_URGENT_MS);
    } else {
      console.log('[clip-keepalive] ✅ CLIP actif');
      scheduleKeepalive(KEEPALIVE_NORMAL_MS);
    }
  } catch {
    console.log('[clip-keepalive] ⚠️ Erreur keepalive — retry dans 20s');
    scheduleKeepalive(KEEPALIVE_URGENT_MS);
  }
}

function scheduleKeepalive(delayMs) {
  if (keepaliveTimer) clearTimeout(keepaliveTimer);
  keepaliveTimer = setTimeout(runKeepalive, delayMs);
}

runKeepalive();
