// routes/authEtsy.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const AutoSearchState = require('../models/autoSearchModel');

// IMPORTANT : requireAuth is optional here. If you want only authenticated users to start the flow,
// ensure you use requireAuth middleware on /start and /callback. If you want to support popup
// without session, the flow will return tokens via postMessage and the client must relay to server.
const { requireAuth } = require('./auth'); // adapt path if needed

const ETSY_CLIENT_ID = process.env.ETSY_CLIENT_ID;
const ETSY_CLIENT_SECRET = process.env.ETSY_CLIENT_SECRET;
const REDIRECT_URI = process.env.ETSY_REDIRECT_URI; // e.g. https://yourapp.com/auth/etsy/callback

if (!ETSY_CLIENT_ID || !ETSY_CLIENT_SECRET || !REDIRECT_URI) {
  console.warn('Etsy OAuth env variables missing (ETSY_CLIENT_ID / ETSY_CLIENT_SECRET / ETSY_REDIRECT_URI).');
}

// GET /auth/etsy/start
// If user is authenticated (requireAuth), we store a state token in DB to validate callback.
// If not authenticated (popup without session), we include a state but the callback will return tokens
// via postMessage and the client must supply them to the server.
router.get('/start', requireAuth, async (req, res) => {
  if (!ETSY_CLIENT_ID || !REDIRECT_URI) return res.status(500).send('Etsy client config missing');

  // Generate a random state and store it in AutoSearchState for this user
  const state = Math.random().toString(36).slice(2);
  try {
    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      { $set: { oauthState: state, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (e) {
    console.warn('Failed to store oauth state:', e.message);
  }

  // Build Etsy authorization URL (OAuth2)
  // Scopes depend on your needs; adjust as necessary. Example scopes: 'email_r listings_r listings_w cart_w'
  const scope = encodeURIComponent('email_r listings_r'); // adjust scopes as needed
  const authUrl = `https://www.etsy.com/oauth/connect?response_type=code&client_id=${encodeURIComponent(ETSY_CLIENT_ID)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${scope}&state=${encodeURIComponent(state)}`;
  res.redirect(authUrl);
});

// GET /auth/etsy/callback
// Etsy redirects here with ?code=...&state=...
// We exchange code for tokens and store them in AutoSearchState for the authenticated user.
// If req.user is missing (popup without session), we send a small HTML that posts tokens to the opener.
router.get('/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  if (!code) {
    return res.status(400).send('Missing code');
  }

  try {
    // Exchange code for token
    // Etsy OAuth token endpoint v3:
    const tokenUrl = 'https://api.etsy.com/v3/public/oauth/token';

    const params = new URLSearchParams();
    params.append('grant_type', 'authorization_code');
    params.append('client_id', ETSY_CLIENT_ID);
    params.append('redirect_uri', REDIRECT_URI);
    params.append('code', code);
    // client_secret can be sent in Authorization header or body depending on Etsy; we include in body
    params.append('client_secret', ETSY_CLIENT_SECRET);

    const tokenRes = await axios.post(tokenUrl, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    const tok = tokenRes.data; // expected: { access_token, refresh_token, expires_in, ... }

    // If user is authenticated (session), validate state against stored oauthState and save tokens
    if (req.user && req.user.id) {
      // Validate state if present
      try {
        const stateDoc = await AutoSearchState.findOne({ userId: req.user.id });
        if (stateDoc && state && stateDoc.oauthState && state !== stateDoc.oauthState) {
          console.warn('OAuth state mismatch for user', req.user.id);
          // continue but log warning
        }
      } catch (e) {
        console.warn('State validation failed:', e.message);
      }

      await AutoSearchState.findOneAndUpdate(
        { userId: req.user.id },
        {
          $set: {
            etsyToken: tok.access_token || null,
            etsyRefreshToken: tok.refresh_token || null,
            // store other metadata if needed
            oauthState: null,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );

      // Notify parent window (if popup) and close, or redirect back to your app UI
      return res.send(`<script>
        if (window.opener) {
          try { window.opener.postMessage({ etsyAuth: 'success' }, window.location.origin); } catch(e) {}
          window.close();
        } else {
          // If no opener, just redirect to application
          window.location = '/niche-list';
        }
      </script>`);
    }

    // If no server-side session (req.user missing), return tokens to opener via postMessage
    // WARNING: In this mode the client must send tokens to server to associate with user.
    return res.send(`<script>
      (function(){
        const data = ${JSON.stringify({ status: 'success', tokens: tok })};
        if (window.opener) {
          try { window.opener.postMessage({ etsyAuth: 'success', tokens: data.tokens }, window.location.origin); } catch(e){}
          window.close();
        } else {
          document.body.innerText = 'Authentication completed. You can close this window.';
        }
      })();
    </script>`);
  } catch (err) {
    console.error('Etsy callback error:', err.response?.data || err.message || err);
    const message = err.response?.data ? JSON.stringify(err.response.data) : (err.message || 'Unknown error');
    return res.send(`<script>
      if (window.opener) {
        try { window.opener.postMessage({ etsyAuth: 'error', error: ${JSON.stringify(message)} }, window.location.origin); } catch(e){}
        window.close();
      } else {
        document.body.innerText = 'Etsy auth error: ' + ${JSON.stringify(message)};
      }
    </script>`);
  }
});

// POST /auth/etsy/logout (optional) - requires requireAuth
router.post('/logout', requireAuth, async (req, res) => {
  try {
    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      { $set: { etsyToken: null, etsyRefreshToken: null, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
```

2) backend/routes/shopRoutes.js (version complète mise à jour)
Remplacez votre fichier existant par celui-ci (j'ai intégré l'endpoint POST /clone). J'ai laissé le requireAuth existant tel que vous l'avez.

```js
// routes/shopRoutes.js
const express      = require('express');
const router       = express.Router();
const { requireAuth } = require('./auth');
const SavedShop    = require('../models/shopModel');
const AutoSearchState = require('../models/autoSearchModel');

// ── SAVE SHOP ──
router.post('/save', requireAuth, async (req, res) => {
  let { shopName, shopUrl, shopAvatar, productImage, productUrl } = req.body;

  if (!shopName && shopUrl) {
    const m = shopUrl.match(/etsy\.com\/shop\/([^/?#]+)/i);
    if (m) shopName = m[1];
  }
  if (!shopName && productUrl) {
    const m = productUrl.match(/etsy\.com\/shop\/([^/?#]+)/i);
    if (m) shopName = m[1];
  }

  if (shopName) {
    shopUrl = 'https://www.etsy.com/shop/' + shopName;
  } else if (shopUrl) {
    shopUrl = shopUrl.replace(/\/$/, '');
  }

  if (!productUrl && shopUrl) productUrl = shopUrl;
  if (!productUrl) return res.status(400).json({ error: 'productUrl requis' });

  try {
    const shop = await SavedShop.findOneAndUpdate(
      { userId: req.user.id, productUrl },
      { $set: { shopName: shopName || null, shopUrl: shopUrl || null, shopAvatar: shopAvatar || null, productImage: productImage || null, savedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, shop });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Already saved' });
    res.status(500).json({ error: err.message });
  }
});

// ── CLONE SHOP ──
router.post('/clone', requireAuth, async (req, res) => {
  try {
    const { shopId } = req.body;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });
    const shop = await SavedShop.findOne({ _id: shopId, userId: req.user.id });
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    const newShop = new SavedShop({
      userId: req.user.id,
      shopName: shop.shopName,
      shopUrl: shop.shopUrl,
      shopAvatar: shop.shopAvatar,
      productImage: shop.productImage,
      productUrl: shop.productUrl,
      savedAt: new Date()
    });

    await newShop.save();
    res.json({ ok: true, shop: newShop });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Already saved' });
    res.status(500).json({ error: err.message });
  }
});

// ── LIST SHOPS ──
router.get('/', requireAuth, async (req, res) => {
  try {
    const shops = await SavedShop.find({ userId: req.user.id }).sort({ savedAt: -1 });
    res.json(shops);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE SHOP ──
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await SavedShop.deleteOne({ _id: req.params.id, userId: req.user.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET auto-search state ──
router.get('/auto-state', requireAuth, async (req, res) => {
  try {
    const state = await AutoSearchState.findOne({ userId: req.user.id });
    if (!state) return res.json({ keywordQueue: [], usedKeywords: [], usedShops: [] });
    res.json({
      keywordQueue: state.keywordQueue,
      usedKeywords: state.usedKeywords,
      usedShops:    state.usedShops,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SAVE auto-search state ──
router.post('/auto-state', requireAuth, async (req, res) => {
  try {
    const { keywordQueue, usedKeywords, usedShops } = req.body;
    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      { $set: { keywordQueue: keywordQueue || [], usedKeywords: usedKeywords || [], usedShops: usedShops || [], updatedAt: new Date() } },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADD used shop ──
router.post('/auto-state/shop', requireAuth, async (req, res) => {
  try {
    const { shopName } = req.body;
    if (!shopName) return res.status(400).json({ error: 'shopName required' });
    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      { $addToSet: { usedShops: shopName }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── UPDATE keyword queue ──
router.post('/auto-state/queue', requireAuth, async (req, res) => {
  try {
    const { keywordQueue, usedKeyword } = req.body;
    const update = { $set: { updatedAt: new Date() } };
    if (keywordQueue !== undefined) update.$set.keywordQueue = keywordQueue;
    if (usedKeyword) update.$addToSet = { usedKeywords: usedKeyword };
    await AutoSearchState.findOneAndUpdate({ userId: req.user.id }, update, { upsert: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

3) frontend/components/ShopCard.jsx (React)
Composant prêt à l'emploi. Adaptez les imports / styles selon votre projet.

```jsx
// frontend/components/ShopCard.jsx
import React from 'react';

export default function ShopCard({ shop, token, onDeleted = () => {}, onCloned = () => {} }) {
  const handleDelete = async () => {
    if (!window.confirm('Supprimer cette boutique ?')) return;
    try {
      const res = await fetch(`/shops/${shop._id}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + (token || ''), 'Content-Type': 'application/json' }
      });
      if (!res.ok) throw new Error('Delete failed');
      onDeleted(shop._id);
    } catch (e) {
      alert('Erreur suppression: ' + e.message);
    }
  };

  const handleClone = async () => {
    try {
      const res = await fetch('/shops/clone', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + (token || ''), 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopId: shop._id })
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || 'Clone failed');
      }
      const body = await res.json();
      onCloned(body.shop);
    } catch (e) {
      alert('Erreur clone: ' + e.message);
    }
  };

  const cardStyle = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    marginBottom: '10px',
    background: '#fff'
  };

  const centerStyle = { flex: 1, textAlign: 'center' };
  const shopNameStyle = { fontWeight: 700, marginBottom: 8, fontSize: 16 };
  const cloneBtnStyle = {
    background: '#0069ff',
    color: '#fff',
    padding: '8px 18px',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer'
  };
  const trashBtnStyle = {
    background: 'transparent',
    border: 'none',
    color: '#c53030',
    fontSize: 20,
    cursor: 'pointer'
  };

  return (
    <div style={cardStyle}>
      <div style={centerStyle}>
        <div style={shopNameStyle}>{shop.shopName || shop.shopUrl}</div>
        <button style={cloneBtnStyle} onClick={handleClone}>clone</button>
      </div>
      <div style={{ marginLeft: 12 }}>
        <button onClick={handleDelete} aria-label="Supprimer" style={trashBtnStyle}>🗑️</button>
      </div>
    </div>
  );
}
```

4) frontend/components/EtsyLoginButton.jsx (React)
Affiche le bouton orange et gère la popup + postMessage. Après succès, vous pouvez appeler un endpoint pour récupérer l'état / user data.

```jsx
// frontend/components/EtsyLoginButton.jsx
import React, { useEffect } from 'react';

export default function EtsyLoginButton({ onConnected = () => {} }) {
  useEffect(() => {
    function onMsg(e) {
      if (e.origin !== window.location.origin) return;
      const data = e.data || {};
      if (data.etsyAuth === 'success') {
        // Tokens may be included as data.tokens if flow returned them (in no-session mode).
        // In session mode the server stored tokens already; here we just notify parent.
        onConnected();
      } else if (data.etsyAuth === 'error') {
        alert('Etsy auth error: ' + (data.error || 'unknown'));
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [onConnected]);

  const openAuth = () => {
    // Open popup to start OAuth (server will redirect to Etsy)
    const w = window.open('/auth/etsy/start', 'etsy_auth', 'width=800,height=700');
    if (!w) alert('Popup blocked. Autorisez les popups pour continuer.');
  };

  const btnStyle = {
    background: '#ff7a00',
    color: '#fff',
    padding: '8px 14px',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer'
  };

  return (
    <button style={btnStyle} onClick={openAuth}>etsy login</button>
  );
}
```

5) Montage du router authEtsy dans votre app
Dans votre fichier principal de routes (par ex scrape.js ou app.js), montez le routeur :

```js
// dans scrape.js ou app.js (selon votre structure)
const authEtsyRouter = require('./routes/authEtsy');
router.use('/auth/etsy', authEtsyRouter);
```

ou si vous utilisez un seul auth router, vous pouvez importer et monter à /auth/etsy.

6) Exemple d'utilisation sur la page Niche List (React)
Une page simplifiée montrant le bouton en haut à droite et la liste de ShopCard :

```jsx
import React, { useEffect, useState } from 'react';
import EtsyLoginButton from './EtsyLoginButton';
import ShopCard from './ShopCard';

export default function NicheListPage({ token }) {
  const [shops, setShops] = useState([]);

  useEffect(() => {
    fetch('/shops', { headers: { 'Authorization': 'Bearer ' + (token || '') } })
      .then(r => r.json())
      .then(data => setShops(data))
      .catch(err => console.error(err));
  }, [token]);

  const handleDeleted = (id) => setShops(s => s.filter(x => x._id !== id));
  const handleCloned = (shop) => setShops(s => [shop, ...s]);

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 20 }}>
        <EtsyLoginButton onConnected={() => { /* refresh state, show connected */ }} />
      </div>

      <div>
        {shops.map(shop => (
          <ShopCard key={shop._id} shop={shop} token={token} onDeleted={handleDeleted} onCloned={handleCloned} />
        ))}
      </div>
    </div>
  );
}
