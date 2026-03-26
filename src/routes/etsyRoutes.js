const express = require('express');
const router = express.Router();
const axios = require('axios');
const AutoSearchState = require('../models/autoSearchModel');
const { requireAuth } = require('./auth');

const ETSY_CLIENT_ID = process.env.ETSY_CLIENT_ID;
const ETSY_CLIENT_SECRET = process.env.ETSY_CLIENT_SECRET;
const ETSY_REDIRECT_URI =
  process.env.ETSY_REDIRECT_URI || 'https://www.finder-niche.com/api/etsy/callback';

if (!ETSY_CLIENT_ID || !ETSY_CLIENT_SECRET) {
  console.warn('[etsyRoutes] Missing ETSY_CLIENT_ID or ETSY_CLIENT_SECRET in env');
}

// Etsy OAuth endpoints
const AUTH_URL = 'https://www.etsy.com/oauth/connect';
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';

// Génère un "state" simple
function makeState() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

router.get('/login-url', requireAuth, (req, res) => {
  const state = makeState();

  // Optionnel: stocker oauthState dans ton AutoSearchState
  // (utile pour valider le callback)
  AutoSearchState.findOneAndUpdate(
    { userId: req.user.id },
    { $set: { oauthState: state, updatedAt: new Date() } },
    { upsert: true, new: true }
  ).then(() => {
    const url = AUTH_URL + '?' + new URLSearchParams({
      response_type: 'code',
      client_id: ETSY_CLIENT_ID,
      redirect_uri: ETSY_REDIRECT_URI,
      scope: 'listings_r listings_w_r favorites_r favorites_w_r profile_r profile_w_r' // scopes courants (ajuste selon besoin)
        .split(' ')
        .filter(Boolean)
        .join(' '),
      state,
      // Etsy autorise parfois "code_challenge" si PKCE activé (non requis ici)
    }).toString();

    res.json({ url });
  }).catch(err => {
    res.status(500).json({ error: err.message });
  });
});

// Callback OAuth
router.get('/callback', requireAuth, async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing "code"');
    if (!state) return res.status(400).send('Missing "state"');

    // Valider state
    const doc = await AutoSearchState.findOne({ userId: req.user.id });
    if (doc?.oauthState && doc.oauthState !== state) {
      return res.status(400).send('Invalid OAuth state');
    }

    // Echanger code contre tokens
    const r = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ETSY_CLIENT_ID,
        client_secret: ETSY_CLIENT_SECRET,
        code,
        redirect_uri: ETSY_REDIRECT_URI,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
    );

    const data = r.data || {};
    const accessToken = data.access_token || null;
    const refreshToken = data.refresh_token || null;

    if (!accessToken) {
      return res.status(400).send('No access_token returned by Etsy');
    }

    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      {
        $set: {
          etsyToken: accessToken,
          etsyRefreshToken: refreshToken,
          updatedAt: new Date(),
          // tu as aussi etsyEmail/etsyPassword etc mais pas besoin ici
          oauthVerifier: code,
          oauthState: null,
        },
      },
      { upsert: true }
    );

    // Page finale simple
    return res.send(`
      <html>
        <body style="font-family:Inter,system-ui;padding:24px;">
          <h2>✅ Etsy connecté</h2>
          <p>Vous pouvez fermer cette fenêtre.</p>
          <script>window.close && window.close();</script>
        </body>
      </html>
    `);
  } catch (err) {
    return res.status(500).send('OAuth callback failed: ' + (err.response?.data?.error || err.message));
  }
});

module.exports = router;
