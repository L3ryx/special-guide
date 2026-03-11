const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const User    = require('../models/userModel');

const JWT_SECRET  = process.env.JWT_SECRET || 'finder_niche_secret_change_me';
const JWT_EXPIRES = '30d';

function makeToken(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

// Middleware auth — vérifie le JWT dans le header Authorization
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
    // Also delete all saved shops
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
const crypto = require('crypto');
const { Resend } = require('resend');

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const user = await User.findOne({ email: email.toLowerCase().trim() });
    // Always return success to avoid user enumeration
    if (!user) return res.json({ ok: true });

    // Generate token
    const token = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken   = token;
    user.resetPasswordExpires = Date.now() + 1000 * 60 * 60; // 1h
    await user.save();

    const resetUrl = (process.env.APP_URL || 'https://etsy-money-finder-2-3ub5.onrender.com') + '/reset-password?token=' + token;

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
