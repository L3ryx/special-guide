const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const axios   = require('axios');
const User    = require('../models/userModel');

const JWT_SECRET = process.env.JWT_SECRET || 'Bretignydu91';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

// ── Middleware auth ──
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

// ── POST /api/stripe/create-payment-intent ──
// Crée un PaymentIntent Stripe pour 24,99 USD (10 recherches)
router.post('/create-payment-intent', requireAuth, async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY non configurée sur le serveur.' });
  }

  try {
    const params = new URLSearchParams({
      amount: '2499',          // en centimes → $24.99
      currency: 'usd',
      'metadata[userId]': req.user.id,
      'metadata[credits]': '10',
      'automatic_payment_methods[enabled]': 'true',
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
// Appelé après confirmation côté client pour créditer le compte
router.post('/confirm-payment', requireAuth, async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY non configurée.' });
  }

  const { paymentIntentId } = req.body;
  if (!paymentIntentId) return res.status(400).json({ error: 'paymentIntentId manquant.' });

  try {
    // Vérifier le statut du PaymentIntent directement auprès de Stripe
    const response = await axios.get(
      `https://api.stripe.com/v1/payment_intents/${paymentIntentId}`,
      {
        headers: { 'Authorization': `Bearer ${STRIPE_SECRET_KEY}` },
      }
    );

    const pi = response.data;

    if (pi.status !== 'succeeded') {
      return res.status(400).json({ error: `Paiement non validé (statut: ${pi.status})` });
    }

    // Vérifier que le metadata userId correspond bien à l'utilisateur connecté
    if (pi.metadata?.userId !== req.user.id) {
      return res.status(403).json({ error: 'Paiement non associé à ce compte.' });
    }

    const creditsToAdd = parseInt(pi.metadata?.credits || '10', 10);

    // Créditer le compte (atomique avec $inc)
    const user = await User.findByIdAndUpdate(
      req.user.id,
      { $inc: { searchCredits: creditsToAdd } },
      { new: true }
    );

    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

    res.json({ ok: true, searchCredits: user.searchCredits });
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/stripe/credits ──
// Retourne le nombre de recherches restantes
router.get('/credits', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('searchCredits');
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    res.json({ searchCredits: user.searchCredits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe/consume ──
// Consomme 1 crédit au lancement d'une recherche
router.post('/consume', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('searchCredits');
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    if (user.searchCredits <= 0) {
      return res.status(402).json({ error: 'Aucun crédit de recherche disponible.' });
    }
    const updated = await User.findByIdAndUpdate(
      req.user.id,
      { $inc: { searchCredits: -1 } },
      { new: true }
    );
    res.json({ ok: true, searchCredits: updated.searchCredits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

