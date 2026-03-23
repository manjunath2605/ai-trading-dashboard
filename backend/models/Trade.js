const mongoose = require("mongoose");

const TradeSchema = new mongoose.Schema({
  symbol: String,
  trade: String,
  signal: String,
  price: Number,
  estimated_option_price: Number,
  confidence: Number,
  stop_loss: Number,
  target: Number,
  result: { type: String, default: "OPEN" },
  approvalStatus: { type: String, default: "PENDING" },
  executionMode: String,
  simulatedPrice: Number,
  simulatedQuantity: Number,
  simulatedAmount: Number,
  approvedAt: Date,
  rejectedAt: Date,
  orderResponse: mongoose.Schema.Types.Mixed,
  exitOrderResponse: mongoose.Schema.Types.Mixed,
  exit_price: Number,
  closedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Trade", TradeSchema);
