const mongoose = require('mongoose');

const autoSearchStateSchema = new mongoose.Schema({
  userId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  keywordQueue: { type: [String], default: [] },
  usedKeywords: { type: [String], default: [] },
  usedShops:    { type: [String], default: [] },
  etsyToken:    { type: String, default: null },
  etsyEmail:    { type: String, default: null },
  etsyPassword: { type: String, default: null },
  updatedAt:    { type: Date, default: Date.now },
});

module.exports = mongoose.model('AutoSearchState', autoSearchStateSchema);
