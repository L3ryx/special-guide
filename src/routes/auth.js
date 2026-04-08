const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const axios   = require('axios');
const User    = require('../models/userModel');

const JWT_SECRET  = process.env.JWT_SECRET || 'Bretignydu91';
const JWT_EXPIRES = '30d';

const APP_URL = process.env.APP_URL || 'https://www.finder-niche.com';

// Stripe
const STRIPE_SECRET_KEY          = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET      = process.env.STRIPE_WEBHOOK_SECRET;
const SEARCH_PRICE_CENTS         = 2000; // $20.00
const KEYWORDS_WITH_RESULTS_LIMIT = 2;   // Après 2 mots-clés avec résultats → payer à nouveau

function makeToken(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

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

// ══════════════════════════════════════════════════════════════════
// STRIPE PAYMENT
// ══════════════════════════════════════════════════════════════════

// POST /api/auth/payment/create-session
// Crée une session Stripe Checkout de $20
router.post('/payment/create-session', requireAuth, async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY manquant' });
  }
  try {
    const stripe = require('stripe')(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Finder Niche — Search Access',
            description: 'Unlimited searches until dropshipping shops are found for 2 keywords',
          },
          unit_amount: SEARCH_PRICE_CENTS,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: APP_URL + '/finder?payment=success&session_id={CHECKOUT_SESSION_ID}',
      cancel_url:  APP_URL + '/finder?payment=cancelled',
      metadata: { userId: req.user.id },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/payment/webhook
// Webhook Stripe — confirme le paiement et active les crédits
router.post('/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) {
    return res.status(500).json({ error: 'STRIPE_WEBHOOK_SECRET manquant' });
  }
  const stripe = require('stripe')(STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId  = session.metadata?.userId;
    if (userId) {
      try {
        await User.findByIdAndUpdate(userId, {
          searchPaid:          true,
          keywordsWithResults: 0,
          stripeSessionId:     session.id,
        });
      } catch (e) {
        console.error('Webhook DB update error:', e.message);
      }
    }
  }

  res.json({ received: true });
});

// GET /api/auth/payment/status
// Retourne le statut de paiement de l'utilisateur connecté
router.get('/payment/status', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('searchPaid keywordsWithResults');
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({
      paid:                user.searchPaid,
      keywordsWithResults: user.keywordsWithResults,
      limit:               KEYWORDS_WITH_RESULTS_LIMIT,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/payment/verify-session
// Vérifie une session Stripe côté client après redirection success
router.post('/payment/verify-session', requireAuth, async (req, res) => {
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'STRIPE_SECRET_KEY manquant' });
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId manquant' });
  try {
    const stripe  = require('stripe')(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid' && String(session.metadata?.userId) === String(req.user.id)) {
      await User.findByIdAndUpdate(req.user.id, {
        searchPaid:          true,
        keywordsWithResults: 0,
        stripeSessionId:     session.id,
      });
      return res.json({ ok: true, paid: true });
    }
    res.json({ ok: false, paid: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/payment/record-result
// Appelé par le backend de recherche quand un mot-clé a trouvé ≥1 boutique
// Incrémente keywordsWithResults et révoque searchPaid si limite atteinte
router.post('/payment/record-result', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });

    user.keywordsWithResults = (user.keywordsWithResults || 0) + 1;

    if (user.keywordsWithResults >= KEYWORDS_WITH_RESULTS_LIMIT) {
      user.searchPaid          = false;
      user.keywordsWithResults = 0; // reset pour le prochain cycle
    }

    await user.save();
    res.json({
      paid:                user.searchPaid,
      keywordsWithResults: user.keywordsWithResults,
      limit:               KEYWORDS_WITH_RESULTS_LIMIT,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// AUTH CLASSIQUE (email / mot de passe)
// ══════════════════════════════════════════════════════════════════

router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  if (password.length < 6)  return res.status(400).json({ error: 'Mot de passe trop court (6 chars min)' });
  try {
    const user  = await new User({ email, password }).save();
    const token = makeToken(user._id);
    res.json({ token, email: user.email });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
  try {
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    const ok = await user.comparePassword(password);
    if (!ok)   return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    res.json({ token: makeToken(user._id), email: user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json({ email: user.email, id: user._id });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both fields required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password too short (6+ chars)' });
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await user.comparePassword(currentPassword);
    if (!ok) return res.status(401).json({ error: 'Current password incorrect' });
    user.password = newPassword;
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/delete-account', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });
    await user.deleteOne();
    const SavedShop = require('../models/shopModel');
    await SavedShop.deleteMany({ userId: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/change-email', requireAuth, async (req, res) => {
  const { newEmail, password } = req.body;
  if (!newEmail || !password) return res.status(400).json({ error: 'Both fields required' });
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'Incorrect password' });
    const exists = await User.findOne({ email: newEmail });
    if (exists) return res.status(409).json({ error: 'Email already in use' });
    user.email = newEmail;
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.json({ ok: true });

    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken   = token;
    user.resetPasswordExpires = Date.now() + 1000 * 60 * 60;
    await user.save();

    const resetUrl = APP_URL + '/reset-password?token=' + token;

    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'Finder Niche <noreply@finderniche.com>',
      to: user.email,
      subject: 'Reset your password',
      html: `
        <div style="font-family:Inter,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0a0a0a;color:#fff;border-radius:16px;">
          <h2 style="margin-bottom:16px;">Reset your password</h2>
          <p style="color:rgba(255,255,255,0.7);margin-bottom:24px;">Click the button below to reset your password. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;padding:12px 28px;background:#22c55e;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;">Reset Password</a>
          <p style="color:rgba(255,255,255,0.4);margin-top:24px;font-size:0.8rem;">If you didn't request this, ignore this email.</p>
        </div>
      `
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 6)  return res.status(400).json({ error: 'Password too short (6+ chars)' });
  try {
    const user = await User.findOne({
      resetPasswordToken:   token,
      resetPasswordExpires: { $gt: Date.now() }
    });
    if (!user) return res.status(400).json({ error: 'Invalid or expired link' });
    user.password             = password;
    user.resetPasswordToken   = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, requireAuth };

