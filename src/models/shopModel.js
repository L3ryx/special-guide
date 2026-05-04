const mongoose = require('mongoose');

const savedShopSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  shopName:     { type: String, default: null },
  shopUrl:      { type: String, default: null },
  shopAvatar:   { type: String, default: null },
  productImage: { type: String, default: null },
  productUrl:   { type: String, default: null },
  keyword:      { type: String, default: null },
  numSales:     { type: Number, default: null },
  salesPerYear: { type: Number, default: null },
  savedAt:      { type: Date, default: Date.now },
});

savedShopSchema.index({ userId: 1, productUrl: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('SavedShop', savedShopSchema);
