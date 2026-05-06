const express      = require('express');
const router       = express.Router();
const { requireAuth } = require('./auth');
const SavedShop    = require('../models/shopModel');
const AutoSearchState = require('../models/autoSearchModel');

// ── SAVE SHOP ──
router.post('/save', requireAuth, async (req, res) => {
  let { shopName, shopUrl, shopAvatar, productImage, productUrl, keyword } = req.body;

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
  if (!productUrl && shopName) productUrl = 'https://www.etsy.com/shop/' + shopName;
  if (!productUrl) return res.status(400).json({ error: 'productUrl requis' });

  try {
    const shop = await SavedShop.findOneAndUpdate(
      { userId: req.user.id, productUrl },
      { $set: { shopName: shopName || null, shopUrl: shopUrl || null, shopAvatar: shopAvatar || null, productImage: productImage || null, keyword: keyword || null, savedAt: new Date() } },
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

// ── DELETE ALL SHOPS ──
router.delete('/', requireAuth, async (req, res) => {
  try {
    await SavedShop.deleteMany({ userId: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE SHOP ──
router.delete('/:id', requireAuth, async (req, res) => {
  await SavedShop.deleteOne({ _id: req.params.id, userId: req.user.id });
  res.json({ ok: true });
});

// ── DELETE auto-search state (clear history) ──
router.delete('/auto-state', requireAuth, async (req, res) => {
  try {
    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      { $set: { keywordQueue: [], usedKeywords: [], usedShops: [], updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET auto-search state ──
router.get('/auto-state', requireAuth, async (req, res) => {
  try {
    const state = await AutoSearchState.findOne({ userId: req.user.id });
    if (!state) return res.json({ keywordQueue: [], usedKeywords: [] });
    res.json({
      keywordQueue: state.keywordQueue,
      usedKeywords: state.usedKeywords,
      // usedShops non retourné
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SAVE auto-search state ──
router.post('/auto-state', requireAuth, async (req, res) => {
  try {
    const { keywordQueue, usedKeywords } = req.body;
    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      { $set: { keywordQueue: keywordQueue || [], usedKeywords: usedKeywords || [], updatedAt: new Date() } },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADD used shop — supprimé, boutiques non enregistrées côté serveur ──

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




