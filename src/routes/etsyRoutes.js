const express = require('express');
const router = express.Router();
const axios = require('axios');

const AutoSearchState = require('../models/autoSearchModel');
const { requireAuth } = require('./auth');

const ETSY_CLIENT_ID = process.env.ETSY_CLIENT_ID;
const ETSY_CLIENT_SECRET = process.env.ETSY_CLIENT_SECRET;
const ETSY_REDIRECT_URI =
  process.env.ETSY_REDIRECT_URI || 'https://www.finder-niche.com/etsy/callback';

// Etsy OAuth endpoints
const AUTH_URL = 'https://www.etsy.com/oauth/connect';
const TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token';

function makeState() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getEtsyScopes() {
  // Scopes “listing” + “profile” (à ajuster si nécessaire)
  // Etsy scopes peuvent changer selon l’app : mets ceux dont tu as besoin.
  return [
    'listings_r',
    'listings_w_r',
    'favorites_r',
    'favorites_w_r',
    'profile_r',
    'profile_w_r',
  ].join(' ');
}

// GET /api/etsy/login-url
router.get('/login-url', requireAuth, async (req, res) => {
  try {
    if (!ETSY_CLIENT_ID || !ETSY_CLIENT_SECRET) {
      return res.status(500).json({ error: 'Missing ETSY_CLIENT_ID or ETSY_CLIENT_SECRET' });
    }

    const state = makeState();

    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      { $set: { oauthState: state, updatedAt: new Date() } },
      { upsert: true, new: true }
    );

    const url = AUTH_URL + '?' + new URLSearchParams({
      response_type: 'code',
      client_id: ETSY_CLIENT_ID,
      redirect_uri: ETSY_REDIRECT_URI,
      scope: getEtsyScopes(),
      state,
    }).toString();

    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/etsy/callback
router.get('/callback', requireAuth, async (req, res) => {
  try {
    if (!ETSY_CLIENT_ID || !ETSY_CLIENT_SECRET) {
      return res.status(500).send('Missing ETSY_CLIENT_ID or ETSY_CLIENT_SECRET');
    }

    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing "code"');
    if (!state) return res.status(400).send('Missing "state"');

    const doc = await AutoSearchState.findOne({ userId: req.user.id });
    if (!doc) return res.status(400).send('OAuth state not found');
    if (doc.oauthState && doc.oauthState !== state) {
      return res.status(400).send('Invalid OAuth state');
    }

    const tokenResp = await axios.post(
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

    const data = tokenResp.data || {};
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;

    if (!accessToken) {
      return res.status(400).send('No access_token returned by Etsy');
    }

    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      {
        $set: {
          etsyToken: accessToken,
          etsyRefreshToken: refreshToken || null,
          updatedAt: new Date(),
          oauthState: null,
        },
      },
      { upsert: true, new: true }
    );

    // Petite page “success” + tentative de fermeture popup
    return res.send(`
      <html>
        <body style="font-family:Inter,system-ui;padding:24px;">
          <h2>✅ Etsy connected</h2>
          <p>You can close this window.</p>
          <script>
            try { window.opener && window.opener.postMessage({ type: 'etsy_connected' }, '*'); } catch(e){}
            try { window.close(); } catch(e){}
          </script>
        </body>
      </html>
    `);
  } catch (err) {
    const msg = err.response?.data?.error || err.response?.data?.message || err.message;
    res.status(500).send('OAuth callback failed: ' + msg);
  }
});

module.exports = router;
