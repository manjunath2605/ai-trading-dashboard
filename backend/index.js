require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const cron = require("node-cron");
const mongoose = require("mongoose");

const sendSignal = require("./telegram");
const {
  placeOrder,
  closeTrade,
  startLiveMarketFeed,
  getLiveMarketSnapshot,
  subscribeToLiveMarket,
  getLiveMarketFeedStatus
} = require("./tradingEngine");
const Trade = require("./models/Trade");

const app = express();
app.use(cors());
app.use(express.json());

let lastSignals = {};
let tradesToday = 0;
let latestSignalResults = [];

const MONGODB_URI = process.env.MONGODB_URI;
const MAX_TRADES = Number(process.env.MAX_TRADES || 3);
const PORT = Number(process.env.PORT || 4000);
const AI_ENGINE_URL = (process.env.AI_ENGINE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");
const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || "Asia/Kolkata";
const MARKET_OPEN_TIME = process.env.MARKET_OPEN_TIME || "09:15";
const MARKET_CLOSE_TIME = process.env.MARKET_CLOSE_TIME || "15:30";

const getMarketTimeString = () => {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: MARKET_TIMEZONE
  });

  return formatter.format(new Date());
};

const isMarketOpen = () => {
  const now = getMarketTimeString();
  return now >= `${MARKET_OPEN_TIME}:00` && now <= `${MARKET_CLOSE_TIME}:00`;
};

const connectDatabase = async () => {
  if (!MONGODB_URI) {
    throw new Error("Missing MONGODB_URI in backend/.env");
  }

  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
    family: 4
  });

  console.log("MongoDB connected");
};

startLiveMarketFeed().catch((error) => {
  console.error("Live market feed failed to start:", error.message);
});

const fetchSignalAnalysis = async (symbol) => {
  const { data } = await axios.get(`${AI_ENGINE_URL}/analyze/${symbol}`);
  return data;
};

const buildSignalMessage = (data) => `Auto trade for ${data.symbol}
${data.signal}
${data.trade}
Confidence: ${data.confidence}
SL: ${data.stop_loss}
Target: ${data.target}`;

const buildExitMessage = (trade, outcome, currentPnl, exitPrice) => `Auto exit for ${trade.derivedSymbol || trade.symbol}
${trade.trade}
Result: ${outcome}
Exit Price: ${exitPrice}
P&L: ${currentPnl ?? 0}`;

const inferSymbolFromPrice = (price) => {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice)) {
    return null;
  }
  return numericPrice >= 30000 ? "BANKNIFTY" : "NIFTY";
};

const getSnapshotKeyForTrade = (trade) => {
  const rawSymbol = String(trade?.symbol || "").toUpperCase();
  const rawTrade = String(trade?.trade || "").toUpperCase();
  const inferredFromPrice = inferSymbolFromPrice(trade?.price);

  let normalizedSymbol = rawSymbol;

  if (rawTrade.startsWith("NIFTY ")) {
    normalizedSymbol = "NIFTY";
  }

  if (rawTrade.startsWith("BANKNIFTY ")) {
    normalizedSymbol = "BANKNIFTY";
  }

  if (normalizedSymbol === "BANKNIFTY" && inferredFromPrice === "NIFTY") {
    normalizedSymbol = "NIFTY";
  }

  if (normalizedSymbol === "NIFTY" && inferredFromPrice === "BANKNIFTY") {
    normalizedSymbol = "BANKNIFTY";
  }

  if (normalizedSymbol === "NIFTY") {
    return "nifty";
  }

  if (normalizedSymbol === "BANKNIFTY") {
    return "banknifty";
  }

  if (inferredFromPrice === "NIFTY") {
    return "nifty";
  }

  if (inferredFromPrice === "BANKNIFTY") {
    return "banknifty";
  }

  return null;
};

const enrichTradeWithLivePnl = (tradeDoc) => {
  const trade = tradeDoc.toObject ? tradeDoc.toObject() : { ...tradeDoc };
  const snapshotKey = getSnapshotKeyForTrade(trade);
  trade.derivedSymbol = snapshotKey === "banknifty" ? "BANKNIFTY" : snapshotKey === "nifty" ? "NIFTY" : trade.symbol;

  if (!snapshotKey) {
    return trade;
  }

  const snapshot = getLiveMarketSnapshot(snapshotKey);
  const latestPrice = Number(snapshot?.latestPrice);
  const entryPrice = Number(trade.price);

  trade.livePrice = Number.isFinite(latestPrice) ? latestPrice : null;
  trade.livePriceSource = snapshot?.source || null;

    if (
    ["APPROVED", "NOT_REQUIRED"].includes(trade.approvalStatus) &&
    trade.result === "OPEN" &&
    Number.isFinite(latestPrice) &&
    Number.isFinite(entryPrice)
  ) {
    const direction = trade.signal === "BUY PUT" ? -1 : 1;
    const quantity = Number(trade.simulatedQuantity || 1);
    const currentPnl = Number(((latestPrice - entryPrice) * direction * quantity).toFixed(2));
    const currentPnlPercent = entryPrice ? Number((((latestPrice - entryPrice) * direction) / entryPrice * 100).toFixed(2)) : 0;

    trade.current_pnl = currentPnl;
    trade.current_pnl_percent = currentPnlPercent;
  } else {
    trade.current_pnl = null;
    trade.current_pnl_percent = null;
  }

  return trade;
};

app.get("/signal", async (req, res) => {
  try {
    const symbols = ["nifty", "banknifty"];
    const results = [];

    for (const symbol of symbols) {
      const data = await fetchSignalAnalysis(symbol);
      results.push(data);

      if (
        data.signal !== "HOLD" &&
        data.confidence >= 80 &&
        lastSignals[symbol] !== data.signal
      ) {
        if (tradesToday >= MAX_TRADES) {
          return res.json({
            results,
            skipped: `Max trades reached for today (${MAX_TRADES})`
          });
        }

        const existingOpen = await Trade.findOne({
          symbol: data.symbol,
          result: "OPEN"
        });

        if (existingOpen) {
          lastSignals[symbol] = data.signal;
          continue;
        }

        const existingPending = await Trade.findOne({
          symbol: data.symbol,
          signal: data.signal,
          trade: data.trade,
          approvalStatus: "PENDING"
        });

        if (!existingPending) {
          const orderResponse = await placeOrder(data.trade, {
            estimatedOptionPrice: data.estimated_option_price
          });

          await Trade.create({
            ...data,
            result: "OPEN",
            approvalStatus: "NOT_REQUIRED",
            approvedAt: new Date(),
            executionMode: orderResponse?.mode || "unknown",
            simulatedPrice: orderResponse?.simulatedPrice,
            simulatedQuantity: orderResponse?.quantity,
            simulatedAmount: orderResponse?.simulatedAmount,
            orderResponse
          });

          sendSignal(buildSignalMessage(data));
          tradesToday += 1;
        }

        lastSignals[symbol] = data.signal;
      }
    }

    latestSignalResults = results;

    return res.json(results);
  } catch (error) {
    const status = error.code === "ECONNREFUSED" ? 503 : 500;
    console.error("Failed to fetch AI signal:", error.message);
    return res.status(status).json({
      error: "AI engine unavailable",
      details: error.message,
      aiEngineUrl: AI_ENGINE_URL
    });
  }
});

const autoCloseOpenTrades = async () => {
  const openTrades = await Trade.find({
    result: "OPEN",
    approvalStatus: { $in: ["APPROVED", "NOT_REQUIRED"] }
  });

  for (const tradeDoc of openTrades) {
    const trade = enrichTradeWithLivePnl(tradeDoc);
    const livePrice = Number(trade.livePrice);

    if (!Number.isFinite(livePrice)) {
      continue;
    }

    let outcome = null;

    if (trade.signal === "BUY CALL") {
      if (livePrice >= Number(trade.target)) outcome = "WIN";
      if (livePrice <= Number(trade.stop_loss)) outcome = "LOSS";
    }

    if (trade.signal === "BUY PUT") {
      if (livePrice <= Number(trade.target)) outcome = "WIN";
      if (livePrice >= Number(trade.stop_loss)) outcome = "LOSS";
    }

    if (!outcome) {
      continue;
    }

    const exitResponse = await closeTrade(trade.trade, {
      exitPrice: livePrice
    });
    const realizedPnl = trade.current_pnl;

    tradeDoc.result = outcome;
    tradeDoc.exit_price = livePrice;
    tradeDoc.closedAt = new Date();
    tradeDoc.exitOrderResponse = exitResponse;
    await tradeDoc.save();

    sendSignal(buildExitMessage(trade, outcome, realizedPnl, livePrice));
  }
};

app.get("/signals/latest", async (req, res) => {
  try {
    if (latestSignalResults.length === 0 || req.query.refresh === "true") {
      const symbols = ["nifty", "banknifty"];
      latestSignalResults = await Promise.all(symbols.map(fetchSignalAnalysis));
    }

    return res.json(latestSignalResults);
  } catch (error) {
    return res.status(500).json({
      error: "Failed to load latest signals",
      details: error.message
    });
  }
});

app.get("/market/status", async (req, res) => {
  const marketTime = getMarketTimeString();
  res.json({
    open: isMarketOpen(),
    marketTime,
    marketOpen: MARKET_OPEN_TIME,
    marketClose: MARKET_CLOSE_TIME,
    timezone: MARKET_TIMEZONE
  });
});

app.get("/trades", async (req, res) => {
  const trades = await Trade.find().sort({ createdAt: -1 });
  res.json(trades.map(enrichTradeWithLivePnl));
});

app.get("/stats", async (req, res) => {
  const trades = await Trade.find({
    approvalStatus: { $in: ["APPROVED", "NOT_REQUIRED"] }
  });
  const enrichedTrades = trades.map(enrichTradeWithLivePnl);

  let profit = 0;
  let openProfit = 0;
  let wins = 0;
  let losses = 0;

  enrichedTrades.forEach((t) => {
    if (t.result === "WIN") {
      wins += 1;
      profit += (t.target - t.price);
    }

    if (t.result === "LOSS") {
      losses += 1;
      profit -= (t.price - t.stop_loss);
    }

    if (t.result === "OPEN" && typeof t.current_pnl === "number") {
      openProfit += t.current_pnl;
    }
  });

  res.json({
    total: enrichedTrades.length,
    wins,
    losses,
    winRate: enrichedTrades.length ? (wins / enrichedTrades.length * 100).toFixed(2) : 0,
    profit,
    openProfit: Number(openProfit.toFixed(2)),
    totalProfitWithOpen: Number((profit + openProfit).toFixed(2))
  });
});

app.get("/market/candles/:symbol", async (req, res) => {
  try {
    const snapshot = getLiveMarketSnapshot(req.params.symbol);

    if (snapshot.candles.length > 0) {
      return res.json(snapshot);
    }

    const { data } = await axios.get(`${AI_ENGINE_URL}/candles/${req.params.symbol}`);
    return res.json({
      ...data,
      source: "ai-engine"
    });
  } catch (error) {
    console.error("Failed to fetch market candle data:", error.message);
    return res.status(500).json({
      error: "Failed to fetch market candle data",
      details: error.message
    });
  }
});

app.get("/market/live/:symbol", async (req, res) => {
  try {
    return res.json(getLiveMarketSnapshot(req.params.symbol));
  } catch (error) {
    return res.status(500).json({
      error: "Failed to load live market snapshot",
      details: error.message
    });
  }
});

app.get("/market/feed-status", async (req, res) => {
  try {
    return res.json(getLiveMarketFeedStatus());
  } catch (error) {
    return res.status(500).json({
      error: "Failed to load market feed status",
      details: error.message
    });
  }
});

app.get("/market/stream/:symbol", async (req, res) => {
  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    const sendSnapshot = (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    sendSnapshot(getLiveMarketSnapshot(req.params.symbol));

    const unsubscribe = subscribeToLiveMarket(req.params.symbol, sendSnapshot);

    req.on("close", () => {
      unsubscribe();
      res.end();
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to stream live market data",
      details: error.message
    });
  }
});

app.post("/trades/:id/approve", async (req, res) => {
  try {
    const trade = await Trade.findById(req.params.id);

    if (!trade) {
      return res.status(404).json({ error: "Trade not found" });
    }

    if (trade.approvalStatus === "APPROVED") {
      return res.status(400).json({ error: "Trade already approved" });
    }

    if (trade.approvalStatus === "REJECTED") {
      return res.status(400).json({ error: "Trade already rejected" });
    }

    if (tradesToday >= MAX_TRADES) {
      return res.status(400).json({ error: `Max trades reached for today (${MAX_TRADES})` });
    }

    const orderResponse = await placeOrder(trade.trade, {
      estimatedOptionPrice: trade.estimated_option_price
    });

    trade.approvalStatus = "APPROVED";
    trade.approvedAt = new Date();
    trade.result = "OPEN";
    trade.executionMode = orderResponse?.mode || "unknown";
    trade.simulatedPrice = orderResponse?.simulatedPrice;
    trade.simulatedQuantity = orderResponse?.quantity;
    trade.simulatedAmount = orderResponse?.simulatedAmount;
    trade.orderResponse = orderResponse;
    await trade.save();

    tradesToday += 1;

    return res.json(trade);
  } catch (error) {
    console.error("Trade approval failed:", error.message);
    return res.status(500).json({
      error: "Trade approval failed",
      details: error.message
    });
  }
});

app.post("/trades/:id/reject", async (req, res) => {
  try {
    const trade = await Trade.findById(req.params.id);

    if (!trade) {
      return res.status(404).json({ error: "Trade not found" });
    }

    if (trade.approvalStatus !== "PENDING") {
      return res.status(400).json({ error: "Only pending trades can be rejected" });
    }

    trade.approvalStatus = "REJECTED";
    trade.rejectedAt = new Date();
    trade.result = "REJECTED";
    await trade.save();

    return res.json(trade);
  } catch (error) {
    console.error("Trade rejection failed:", error.message);
    return res.status(500).json({
      error: "Trade rejection failed",
      details: error.message
    });
  }
});

cron.schedule("*/1 * * * *", async () => {
  try {
    if (!isMarketOpen()) {
      return;
    }
    await axios.get(`http://localhost:${PORT}/signal`);
  } catch (error) {
    console.error("Scheduled signal check failed:", error.message);
  }
});

cron.schedule("*/15 * * * * *", async () => {
  try {
    await autoCloseOpenTrades();
  } catch (error) {
    console.error("Auto close check failed:", error.message);
  }
});

cron.schedule("0 0 * * *", () => {
  tradesToday = 0;
});

connectDatabase()
  .then(() => {
    app.listen(PORT, () => console.log(`Backend running on ${PORT}`));
  })
  .catch((error) => {
    console.error("MongoDB connection failed:", error.message);
    process.exit(1);
  });
