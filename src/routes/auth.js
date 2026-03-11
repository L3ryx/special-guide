const express = require('express');
const router  = express.Router();
const jwt     = require('jsonwebtoken');
const User    = require('../models/userModel');

const JWT_SECRET  = process.env.JWT_SECRET || 'scout_secret_change_me';
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

module.exports = { router, requireAuth };
