const mongoose = require('mongoose');

const savedShopSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  shopName:  { type: String, required: true },
  shopUrl:   { type: String, required: true },
  shopAvatar:{ type: String, default: null },
  savedAt:   { type: Date, default: Date.now },
  lastFind: {
    runAt:   { type: Date, default: null },
    results: { type: Array, default: [] },
  }
});

savedShopSchema.index({ userId: 1, shopUrl: 1 }, { unique: true });

module.exports = mongoose.model('SavedShop', savedShopSchema);
