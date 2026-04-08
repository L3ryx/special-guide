const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  resetPasswordToken:   { type: String },
  resetPasswordExpires: { type: Date },
  email:           { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:        { type: String, required: true },
  createdAt:       { type: Date, default: Date.now },

  // ── Stripe payment / search credits ──
  // Nombre de mots-clés avec boutiques trouvées depuis le dernier paiement
  keywordsWithResults: { type: Number, default: 0 },
  // true = a payé et peut chercher (reset à false quand keywordsWithResults atteint 2)
  searchPaid:          { type: Boolean, default: false },
  // ID de session Stripe pour vérification
  stripeSessionId:     { type: String, default: null },
});

userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function(plain) {
  return bcrypt.compare(plain, this.password);
};

module.exports = mongoose.model('User', userSchema);
