const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const axios   = require('axios');
const User    = require('../models/userModel');

const JWT_SECRET  = process.env.JWT_SECRET || 'Bretignydu91';
const JWT_EXPIRES = '30d';

const ETSY_CLIENT_ID     = process.env.ETSY_CLIENT_ID;
const ETSY_CLIENT_SECRET = process.env.ETSY_CLIENT_SECRET;
const APP_URL            = process.env.APP_URL || 'https://www.finder-niche.com';
const ETSY_REDIRECT_URI  = APP_URL + '/api/auth/etsy/callback';

// Stockage temporaire des code_verifier (en mémoire — suffit pour un seul serveur)
// Pour multi-instance, remplacer par Redis ou MongoDB
const pkceStore = new Map();

function makeToken(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// ── Middleware auth — vérifie le JWT dans le header Authorization ──
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
// ETSY OAUTH 2.0 (PKCE)
// ══════════════════════════════════════════════════════════════════

// Génère un code_verifier aléatoire et son code_challenge SHA-256
function generatePKCE() {
  const verifier  = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// GET /api/auth/etsy
// Redirige l'utilisateur vers la page d'autorisation Etsy
router.get('/etsy', (req, res) => {
  if (!ETSY_CLIENT_ID) {
    return res.status(500).json({ error: 'ETSY_CLIENT_ID manquant dans les variables d\'environnement' });
  }

  // Récupérer l'userId depuis le JWT — accepte header Authorization OU query param ?token=
  const header = req.headers.authorization || '';
  const token  = (header.startsWith('Bearer ') ? header.slice(7) : null) || req.query.token || req.query.jwt || null;
  if (!token) {
    return res.redirect(APP_URL + '/niche-list?etsy_error=' + encodeURIComponent('Connecte-toi d\'abord à ton compte avant de lier Etsy'));
  }
  let userId;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    userId = decoded.id;
  } catch {
    return res.redirect(APP_URL + '/niche-list?etsy_error=' + encodeURIComponent('Session expirée — reconnecte-toi'));
  }

  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');
  const redirectTo = req.query.redirectTo || '/niche-list';

  pkceStore.set(state, { verifier, userId, redirectTo, createdAt: Date.now() });
  setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000);

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             ETSY_CLIENT_ID,
    redirect_uri:          ETSY_REDIRECT_URI,
    scope:                 'email_r listings_r shops_r',
    state,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });

  res.redirect('https://www.etsy.com/oauth/connect?' + params.toString());
});

// GET /api/auth/etsy/callback
// Etsy redirige ici après l'autorisation de l'utilisateur
router.get('/etsy/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(APP_URL + '/niche-list?etsy_error=' + encodeURIComponent(error));
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Paramètres manquants (code ou state)' });
  }

  const pkce = pkceStore.get(state);
  if (!pkce) {
    return res.status(400).json({ error: 'State invalide ou expiré — recommence la connexion' });
  }
  pkceStore.delete(state);

  try {
    // Échanger le code contre un access_token
    const tokenRes = await axios.post(
      'https://api.etsy.com/v3/public/oauth/token',
      new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     ETSY_CLIENT_ID,
        redirect_uri:  ETSY_REDIRECT_URI,
        code,
        code_verifier: pkce.verifier,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );

    const { access_token, refresh_token, expires_in } = tokenRes.data;
    const etsyTokenExpires = new Date(Date.now() + (expires_in - 60) * 1000);

    // Récupérer le profil Etsy pour avoir l'email / user_id
    const profileRes = await axios.get('https://api.etsy.com/v3/application/users/me', {
      headers: {
        'x-api-key':     ETSY_CLIENT_SECRET ? `${ETSY_CLIENT_ID}:${ETSY_CLIENT_SECRET}` : ETSY_CLIENT_ID,
        'Authorization': 'Bearer ' + access_token,
      },
      timeout: 10000,
    });

    const etsyUser  = profileRes.data;
    const etsyId    = String(etsyUser.user_id);
    // Etsy ne retourne pas toujours l'email — on utilise l'etsyId comme identifiant unique
    const etsyEmail = etsyUser.primary_email || etsyUser.email || null;
    // Email de substitution basé sur le user_id Etsy si pas d'email fourni
    const userEmail = etsyEmail ? etsyEmail.toLowerCase().trim() : ('etsy_' + etsyId + '@finder-niche.com');

    // Lier la boutique Etsy au compte déjà connecté
    const user = await User.findById(pkce.userId);
    if (!user) {
      return res.redirect(APP_URL + '/niche-list?etsy_error=' + encodeURIComponent('Compte introuvable — reconnecte-toi'));
    }
    user.etsyUserId       = etsyId;
    user.etsyAccessToken  = access_token;
    user.etsyRefreshToken = refresh_token;
    user.etsyTokenExpires = etsyTokenExpires;
    await user.save();

    const appToken = makeToken(user._id);
    // Redirige vers la page d'origine (pkce.redirectTo) ou niche-list par défaut
    const redirectTo = pkce.redirectTo || '/niche-list';
    res.redirect(APP_URL + redirectTo + '?token=' + appToken + '&etsy_linked=1&email=' + encodeURIComponent(user.email));

  } catch (err) {
    console.error('Etsy OAuth error:', err.response?.data || err.message);
    const msg = err.response?.data?.error_description || err.message;
    res.redirect(APP_URL + '/niche-list?etsy_error=' + encodeURIComponent(msg));
  }
});

// GET /api/auth/etsy/status
// Permet au frontend de savoir si ETSY_CLIENT_ID est configuré
router.get('/etsy/status', (req, res) => {
  res.json({ configured: !!ETSY_CLIENT_ID });
});

// GET /api/auth/etsy/me
// Vérifie si l'utilisateur a un token Etsy valide — rafraîchit si expiré
router.get('/etsy/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id).select('etsyUserId etsyAccessToken etsyRefreshToken etsyTokenExpires');
  if (!user) return res.status(404).json({ linked: false });
  if (!user.etsyAccessToken) return res.json({ linked: false });

  // Vérifier si le token est encore valide (avec 5 min de marge)
  const now = Date.now();
  const expires = user.etsyTokenExpires ? new Date(user.etsyTokenExpires).getTime() : 0;
  if (expires > now + 5 * 60 * 1000) {
    return res.json({ linked: true, etsyUserId: user.etsyUserId });
  }

  // Token expiré — tenter un refresh
  if (!user.etsyRefreshToken) {
    user.etsyAccessToken = null; user.etsyRefreshToken = null; user.etsyTokenExpires = null;
    await user.save();
    return res.json({ linked: false, reason: 'token_expired' });
  }
  try {
    const tokenRes = await axios.post(
      'https://api.etsy.com/v3/public/oauth/token',
      new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     ETSY_CLIENT_ID,
        refresh_token: user.etsyRefreshToken,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    const { access_token, refresh_token, expires_in } = tokenRes.data;
    user.etsyAccessToken  = access_token;
    user.etsyRefreshToken = refresh_token || user.etsyRefreshToken;
    user.etsyTokenExpires = new Date(now + (expires_in - 60) * 1000);
    await user.save();
    return res.json({ linked: true, etsyUserId: user.etsyUserId });
  } catch (e) {
    console.warn('[etsy/me] refresh failed:', e.response?.data || e.message);
    user.etsyAccessToken = null; user.etsyRefreshToken = null; user.etsyTokenExpires = null;
    await user.save();
    return res.json({ linked: false, reason: 'refresh_failed' });
  }
});

// ══════════════════════════════════════════════════════════════════
// AUTH CLASSIQUE (email / mot de passe)
// ══════════════════════════════════════════════════════════════════

// POST /api/auth/register
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

// POST /api/auth/login
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

// GET /api/auth/me
router.get('/me', requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id).select('-password');
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  res.json({ email: user.email, id: user._id });
});

// POST /api/auth/change-password
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

// DELETE /api/auth/delete-account
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

// POST /api/auth/change-email
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

// POST /api/auth/forgot-password
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

// POST /api/auth/reset-password
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




