const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const axios   = require('axios');
const User    = require('../models/userModel');

const JWT_SECRET = process.env.JWT_SECRET || 'Bretignydu91';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

// ── Auth middleware ──
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── POST /api/stripe/create-payment-intent ──
// Creates a Stripe PaymentIntent for $19.99 (20 searches)
router.post('/create-payment-intent', requireAuth, async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY is not configured on the server.' });
  }

  try {
    const params = new URLSearchParams({
      amount: '1999',          // in cents → $19.99
      currency: 'usd',
      'metadata[userId]': req.user.id,
      'metadata[credits]': '20',
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
    });

    const response = await axios.post(
      'https://api.stripe.com/v1/payment_intents',
      params.toString(),
      {
        headers: {
          'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    res.json({ clientSecret: response.data.client_secret });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

// ── POST /api/stripe/confirm-payment ──
// Called after client-side confirmation to credit the account
router.post('/confirm-payment', requireAuth, async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY is not configured.' });
  }

  const { paymentIntentId } = req.body;
  if (!paymentIntentId) return res.status(400).json({ error: 'Missing paymentIntentId.' });

  try {
    // Verify the PaymentIntent status directly with Stripe
    const response = await axios.get(
      `https://api.stripe.com/v1/payment_intents/${paymentIntentId}`,
      {
        headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
      }
    );

    const pi = response.data;

    if (pi.status !== 'succeeded') {
      return res.status(400).json({ error: `Payment not validated (status: ${pi.status})` });
    }

    // Verify that the metadata userId matches the logged-in user
    if (pi.metadata?.userId !== req.user.id) {
      return res.status(403).json({ error: 'Payment not associated with this account.' });
    }

    const creditsToAdd = parseInt(pi.metadata?.credits || '20', 10);

    // Credit the account (atomic with $inc)
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $inc: { searchCredits: creditsToAdd } },
      { new: true }
    );

    if (!user) return res.status(404).json({ error: 'User not found.' });

    res.json({ ok: true, searchCredits: user.searchCredits });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/stripe/credits ──
// Returns the number of remaining searches and unlimited status
router.get('/credits', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('searchCredits unlimited');
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ searchCredits: user.searchCredits, unlimited: user.unlimited || false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe/consume ──
// Consumes 1 credit when a search is launched (skipped for unlimited accounts)
router.post('/consume', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('searchCredits unlimited');
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Unlimited accounts are never debited
    if (user.unlimited) {
      return res.json({ ok: true, searchCredits: user.searchCredits, unlimited: true });
    }

    if (user.searchCredits <= 0) {
      return res.status(402).json({ error: 'No search credits available.' });
    }
    const updated = await User.findByIdAndUpdate(
      req.user.id,
      { $inc: { searchCredits: -1 } },
      { new: true }
    );
    res.json({ ok: true, searchCredits: updated.searchCredits, unlimited: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

