const mongoose = require('mongoose');

const savedShopSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  shopName:  { type: String, required: true },
  shopUrl:   { type: String, required: true },
  shopAvatar:   { type: String, default: null },
  productImage: { type: String, default: null },
  productUrl:   { type: String, default: null },
  keyword:      { type: String, default: null },
  savedAt:      { type: Date, default: Date.now },
  // Last FIND analysis
  lastFind: {
    runAt:    { type: Date, default: null },
    results:  { type: Array, default: [] },
  },
  // Last COMPETITION analysis
  lastCompetition: {
    runAt:           { type: Date, default: null },
    keyword:         { type: String, default: null },
    totalShops:      { type: Number, default: null },
    dropshippers:    { type: Number, default: null },
    dropshipperShops:{ type: Array,  default: [] }, // [{shopName, shopUrl}]
    label:           { type: String, default: null },
    color:           { type: String, default: null },
    description:     { type: String, default: null },
    saturation:      { type: Number, default: null },
  }
});

// Unique shop per user
savedShopSchema.index({ userId: 1, shopUrl: 1 }, { unique: true });

module.exports = mongoose.model('SavedShop', savedShopSchema);
