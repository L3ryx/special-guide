const express      = require('express');
const router       = express.Router();
const { requireAuth } = require('./auth');
const SavedShop    = require('../models/shopModel');

// ── SAVE SHOP ──
router.post('/save', requireAuth, async (req, res) => {
  let { shopName, shopUrl, shopAvatar, productImage, productUrl } = req.body;

  // Normaliser shopUrl depuis productUrl si besoin
  if (!shopUrl && productUrl) {
    const m = productUrl.match(/etsy\.com\/shop\/([^/?#]+)/);
    shopUrl = m ? `https://www.etsy.com/shop/${m[1]}` : null;
  }
  if (shopUrl) shopUrl = shopUrl.replace(/\/$/, '');

  if (!productUrl) return res.status(400).json({ error: 'productUrl requis' });

  // Extraire shopName depuis shopUrl si manquant
  if (!shopName && shopUrl) {
    const m = shopUrl.match(/\/shop\/([^/?#]+)/);
    shopName = m ? m[1] : null;
  }

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
  await SavedShop.deleteOne({ _id: req.params.id, userId: req.user.id });
  res.json({ ok: true });
});

module.exports = router;

