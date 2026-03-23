require("dotenv").config();

const axios = require("axios");
const crypto = require("crypto");
const os = require("os");
const { EventEmitter } = require("events");
const { SmartAPI, WebSocketV2 } = require("smartapi-javascript");
const { ACTION, MODE, EXCHANGES } = require("smartapi-javascript/config/constant");

const PAPER_MODE = process.env.PAPER_MODE === "true";
const ENABLE_REAL_TRADING = process.env.ENABLE_REAL_TRADING === "true";
const API_BASE = (process.env.ANGEL_API_BASE || "https://apiconnect.angelone.in").replace(/\/$/, "");
const SOURCE_ID = process.env.ANGEL_SOURCE_ID || "WEB";
const USER_TYPE = process.env.ANGEL_USER_TYPE || "USER";
const EXCHANGE = process.env.ANGEL_EXCHANGE || "NFO";
const PRODUCT_TYPE = process.env.ANGEL_PRODUCT_TYPE || "CARRYFORWARD";
const ORDER_TYPE = process.env.ANGEL_ORDER_TYPE || "MARKET";
const VARIETY = process.env.ANGEL_VARIETY || "NORMAL";
const DURATION = process.env.ANGEL_DURATION || "DAY";
const PRICE = process.env.ANGEL_PRICE || "0";
const SQUARE_OFF = process.env.ANGEL_SQUARE_OFF || "0";
const STOP_LOSS = process.env.ANGEL_STOP_LOSS || "0";
const LIVE_PRICE_SCALE = Number(process.env.ANGEL_PRICE_SCALE || 100);
const MAX_LIVE_CANDLES = Number(process.env.ANGEL_MAX_LIVE_CANDLES || 240);
const LIVE_POLL_INTERVAL_MS = Number(process.env.ANGEL_LIVE_POLL_INTERVAL_MS || 1000);
const LIVE_CANDLE_INTERVAL_SECONDS = Number(process.env.ANGEL_LIVE_CANDLE_INTERVAL_SECONDS || 1);
const HISTORY_BACKFILL_CANDLES = Number(process.env.ANGEL_HISTORY_BACKFILL_CANDLES || 180);
const MIN_HISTORY_READY_CANDLES = Number(process.env.ANGEL_MIN_HISTORY_READY_CANDLES || 120);
const HISTORY_BACKFILL_RETRY_MS = Number(process.env.ANGEL_HISTORY_BACKFILL_RETRY_MS || 30000);
const AI_ENGINE_URL = (process.env.AI_ENGINE_URL || "http://127.0.0.1:5000").replace(/\/$/, "");

const liveFeedEmitter = new EventEmitter();
let liveFeedStarted = false;
let liveFeedStartPromise = null;
let marketSocket = null;
let marketPollTimer = null;
let smartApiSession = null;
let historicalBackfillTimer = null;
let historicalBackfillPromise = null;

const liveFeedStatus = {
  started: false,
  transport: "none",
  websocketConnected: false,
  websocketTicks: 0,
  lastTickAt: null,
  pollCount: 0,
  lastPollAt: null,
  lastError: null
};

const liveMarketState = {
  nifty: {
    symbol: "NIFTY",
    ticker: "^NSEI",
    source: "angel-live",
    connected: false,
    latestPrice: null,
    lastUpdated: null,
    candles: []
  },
  banknifty: {
    symbol: "BANKNIFTY",
    ticker: "^NSEBANK",
    source: "angel-live",
    connected: false,
    latestPrice: null,
    lastUpdated: null,
    candles: []
  }
};

const getLocalIp = () => {
  const interfaces = os.networkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        return address.address;
      }
    }
  }

  return "127.0.0.1";
};

const createTotp = (secret, step = 30, digits = 6) => {
  const normalized = secret.replace(/\s+/g, "").toUpperCase();
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";

  for (const char of normalized) {
    const index = alphabet.indexOf(char);
    if (index === -1) {
      throw new Error("ANGEL_TOTP_SECRET is not valid base32");
    }
    bits += index.toString(2).padStart(5, "0");
  }

  const bytes = bits.match(/.{1,8}/g)?.map((chunk) => parseInt(chunk.padEnd(8, "0"), 2)) || [];
  const key = Buffer.from(bytes);
  const counter = Math.floor(Date.now() / 1000 / step);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) % (10 ** digits);

  return String(code).padStart(digits, "0");
};

const buildHeaders = (jwtToken) => {
  const apiKey = process.env.ANGEL_API_KEY;

  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-UserType": USER_TYPE,
    "X-SourceID": SOURCE_ID,
    "X-ClientLocalIP": process.env.ANGEL_CLIENT_LOCAL_IP || getLocalIp(),
    "X-ClientPublicIP": process.env.ANGEL_CLIENT_PUBLIC_IP || getLocalIp(),
    "X-MACAddress": process.env.ANGEL_MAC_ADDRESS || "00:00:00:00:00:00",
    "X-PrivateKey": apiKey,
    "X-Api-Key": apiKey,
    ...(jwtToken ? { Authorization: `Bearer ${jwtToken}` } : {})
  };
};

const requireEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value;
};

const parseTrade = (trade) => {
  const match = /^([A-Z]+)\s+(\d+)\s+(CE|PE)$/i.exec((trade || "").trim());
  if (!match) {
    throw new Error(`Unsupported trade format: ${trade}`);
  }

  return {
    underlying: match[1].toUpperCase(),
    strike: match[2],
    optionType: match[3].toUpperCase()
  };
};

const getQuantityForTrade = (underlying) => {
  const quantityMap = {
    NIFTY: process.env.ANGEL_NIFTY_QTY,
    BANKNIFTY: process.env.ANGEL_BANKNIFTY_QTY
  };

  const quantity = quantityMap[underlying];
  if (!quantity) {
    throw new Error(`Missing quantity env for ${underlying}. Set ANGEL_${underlying}_QTY.`);
  }

  return Number(quantity);
};

const buildTradingSymbol = ({ underlying, strike, optionType }) => {
  const expiry = requireEnv("ANGEL_OPTION_EXPIRY");
  return `${underlying}${expiry}${strike}${optionType}`;
};

const buildSimulatedOrder = (trade, context = {}) => {
  const parsed = parseTrade(trade);
  const quantity = getQuantityForTrade(parsed.underlying);
  const simulatedPrice = Number(context.estimatedOptionPrice || 0);
  const simulatedAmount = Number((simulatedPrice * quantity).toFixed(2));

  return {
    mode: PAPER_MODE ? "paper" : "simulated",
    trade,
    quantity,
    simulatedPrice,
    simulatedAmount,
    liveOrderPlaced: false
  };
};

const buildSimulatedExit = (trade, context = {}) => {
  const parsed = parseTrade(trade);
  const quantity = getQuantityForTrade(parsed.underlying);
  const exitPrice = Number(context.exitPrice || 0);
  const exitAmount = Number((exitPrice * quantity).toFixed(2));

  return {
    mode: PAPER_MODE ? "paper" : "simulated",
    trade,
    quantity,
    exitPrice,
    exitAmount,
    liveOrderPlaced: false
  };
};

const createSmartApiClient = () => new SmartAPI({
  api_key: requireEnv("ANGEL_API_KEY")
});

const sdkLogin = async () => {
  const smartApi = createSmartApiClient();
  const clientCode = requireEnv("ANGEL_CLIENT_ID");
  const password = requireEnv("ANGEL_PASSWORD");
  const totp = createTotp(requireEnv("ANGEL_TOTP_SECRET"));

  const loginResponse = await smartApi.generateSession(clientCode, password, totp);

  if (!loginResponse?.status) {
    throw new Error(`Angel SDK login failed: ${JSON.stringify(loginResponse)}`);
  }

  if (loginResponse?.data?.jwtToken) {
    smartApi.setAccessToken(loginResponse.data.jwtToken);
  }

  if (loginResponse?.data?.refreshToken) {
    smartApi.setPublicToken(loginResponse.data.refreshToken);
  }

  smartApi.setClientCode(clientCode);

  return {
    smartApi,
    clientCode,
    jwtToken: loginResponse?.data?.jwtToken,
    feedToken: loginResponse?.data?.feedToken
  };
};

const getInstrumentConfigs = () => ([
  getLiveInstrumentConfig("nifty"),
  getLiveInstrumentConfig("banknifty")
]);

const login = async () => {
  const clientcode = requireEnv("ANGEL_CLIENT_ID");
  const password = requireEnv("ANGEL_PASSWORD");
  const totpSecret = requireEnv("ANGEL_TOTP_SECRET");
  const totp = createTotp(totpSecret);

  const response = await axios.post(
    `${API_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`,
    { clientcode, password, totp },
    { headers: buildHeaders() }
  );

  const jwtToken = response.data?.data?.jwtToken;
  if (!jwtToken) {
    throw new Error(`Angel login failed: ${JSON.stringify(response.data)}`);
  }

  return { jwtToken };
};

const searchScrip = async (jwtToken, tradingSymbol) => {
  const response = await axios.post(
    `${API_BASE}/rest/secure/angelbroking/order/v1/searchScrip`,
    {
      exchange: EXCHANGE,
      searchscrip: tradingSymbol
    },
    { headers: buildHeaders(jwtToken) }
  );

  const results = response.data?.data || [];
  const exactMatch = results.find((item) => item.tradingsymbol === tradingSymbol);

  if (!exactMatch?.symboltoken) {
    throw new Error(`Unable to resolve symbol token for ${tradingSymbol}`);
  }

  return exactMatch;
};

const placeAngelOrder = async (jwtToken, orderParams) => {
  const response = await axios.post(
    `${API_BASE}/rest/secure/angelbroking/order/v1/placeOrder`,
    orderParams,
    { headers: buildHeaders(jwtToken) }
  );

  if (response.data?.status === false) {
    throw new Error(`Angel order rejected: ${JSON.stringify(response.data)}`);
  }

  return response.data;
};

const buildOrderParams = async (jwtToken, trade, transactiontype = "BUY") => {
  const parsed = parseTrade(trade);
  const tradingsymbol = buildTradingSymbol(parsed);
  const scrip = await searchScrip(jwtToken, tradingsymbol);

  return {
    variety: VARIETY,
    tradingsymbol,
    symboltoken: String(scrip.symboltoken),
    transactiontype,
    exchange: EXCHANGE,
    ordertype: ORDER_TYPE,
    producttype: PRODUCT_TYPE,
    duration: DURATION,
    price: PRICE,
    squareoff: SQUARE_OFF,
    stoploss: STOP_LOSS,
    quantity: String(getQuantityForTrade(parsed.underlying))
  };
};

const realBrokerOrder = async (trade, transactiontype) => {
  const { jwtToken } = await login();
  const orderParams = await buildOrderParams(jwtToken, trade, transactiontype);
  const orderResponse = await placeAngelOrder(jwtToken, orderParams);

  return {
    mode: "live",
    trade,
    transactiontype,
    quantity: Number(orderParams.quantity),
    tradingsymbol: orderParams.tradingsymbol,
    liveOrderPlaced: true,
    brokerResponse: orderResponse
  };
};

const realTrade = async (trade) => realBrokerOrder(trade, "BUY");
const realExitTrade = async (trade) => realBrokerOrder(trade, "SELL");

const getLiveInstrumentConfig = (symbol) => {
  const normalized = String(symbol || "").toLowerCase();

  if (normalized === "nifty") {
    return {
      stateKey: "nifty",
      symbol: "NIFTY",
      ticker: "^NSEI",
      token: requireEnv("ANGEL_NIFTY_SPOT_TOKEN"),
      exchangeType: EXCHANGES.nse_cm
    };
  }

  if (normalized === "banknifty") {
    return {
      stateKey: "banknifty",
      symbol: "BANKNIFTY",
      ticker: "^NSEBANK",
      token: requireEnv("ANGEL_BANKNIFTY_SPOT_TOKEN"),
      exchangeType: EXCHANGES.nse_cm
    };
  }

  throw new Error(`Unsupported live symbol: ${symbol}`);
};

const normalizeTickPrice = (rawPrice) => Number(rawPrice) / LIVE_PRICE_SCALE;

const getBucketIso = (timestamp) => {
  const date = new Date(timestamp);
  date.setMilliseconds(0);
  const seconds = date.getSeconds();
  date.setSeconds(seconds - (seconds % LIVE_CANDLE_INTERVAL_SECONDS));
  return date.toISOString();
};

const emitLiveState = (stateKey) => {
  liveFeedEmitter.emit(`tick:${stateKey}`, getLiveMarketSnapshot(stateKey));
};

const isReasonablePriceForState = (stateKey, price) => {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice)) {
    return false;
  }

  if (stateKey === "nifty") {
    return numericPrice >= 15000 && numericPrice <= 35000;
  }

  if (stateKey === "banknifty") {
    return numericPrice >= 30000 && numericPrice <= 70000;
  }

  return true;
};

const mergeHistoricalCandles = (stateKey, candles = []) => {
  const state = liveMarketState[stateKey];
  if (!state || !Array.isArray(candles) || candles.length === 0) {
    return;
  }

  const merged = new Map();

  [...state.candles, ...candles].forEach((candle) => {
    if (!candle?.time) {
      return;
    }

    const normalized = {
      time: candle.time,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume: Number(candle.volume || 0)
    };

    if (
      [normalized.open, normalized.high, normalized.low, normalized.close].every(Number.isFinite) &&
      [normalized.open, normalized.high, normalized.low, normalized.close].every((price) => isReasonablePriceForState(stateKey, price))
    ) {
      merged.set(normalized.time, normalized);
    }
  });

  state.candles = [...merged.values()]
    .sort((left, right) => new Date(left.time) - new Date(right.time))
    .slice(-MAX_LIVE_CANDLES);

  if (state.latestPrice === null && state.candles.length > 0) {
    const lastCandle = state.candles[state.candles.length - 1];
    state.latestPrice = lastCandle.close;
    state.lastUpdated = lastCandle.time;
  }

  emitLiveState(stateKey);
};

const backfillHistoricalCandles = async () => {
  if (historicalBackfillPromise) {
    return historicalBackfillPromise;
  }

  historicalBackfillPromise = Promise.all(
    ["nifty", "banknifty"].map(async (symbol) => {
      try {
        const { data } = await axios.get(`${AI_ENGINE_URL}/candles/${symbol}`, {
          params: {
            prefer_backend: "false",
            limit: HISTORY_BACKFILL_CANDLES
          }
        });

        mergeHistoricalCandles(symbol, data?.candles || []);
      } catch (error) {
        liveFeedStatus.lastError = error.message;
      }
    })
  ).finally(() => {
    historicalBackfillPromise = null;
  });

  return historicalBackfillPromise;
};

const hasEnoughHistoricalCandles = () => Object.values(liveMarketState).every(
  (state) => Array.isArray(state.candles) && state.candles.length >= MIN_HISTORY_READY_CANDLES
);

const startHistoricalBackfillRetry = () => {
  if (historicalBackfillTimer) {
    return;
  }

  const runBackfill = async () => {
    if (hasEnoughHistoricalCandles()) {
      clearInterval(historicalBackfillTimer);
      historicalBackfillTimer = null;
      return;
    }

    await backfillHistoricalCandles();
  };

  historicalBackfillTimer = setInterval(() => {
    runBackfill().catch(() => {});
  }, HISTORY_BACKFILL_RETRY_MS);

  runBackfill().catch(() => {});
};

const updateLiveCandle = (stateKey, tick) => {
  const state = liveMarketState[stateKey];
  if (!state) {
    return;
  }

  const timestamp = Number(tick.exchange_timestamp || Date.now());
  const price = normalizeTickPrice(tick.last_traded_price);
  if (!isReasonablePriceForState(stateKey, price)) {
    return;
  }
  const bucket = getBucketIso(timestamp);
  const lastCandle = state.candles[state.candles.length - 1];

  state.connected = true;
  state.source = "angel-live";
  state.latestPrice = price;
  state.lastUpdated = new Date(timestamp).toISOString();
  liveFeedStatus.websocketTicks += 1;
  liveFeedStatus.lastTickAt = state.lastUpdated;
  liveFeedStatus.lastError = null;
  liveFeedStatus.transport = "websocket";

  if (!lastCandle || lastCandle.time !== bucket) {
    state.candles.push({
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: Number(tick.vol_traded || 0)
    });

    if (state.candles.length > MAX_LIVE_CANDLES) {
      state.candles = state.candles.slice(-MAX_LIVE_CANDLES);
    }
  } else {
    lastCandle.high = Math.max(lastCandle.high, price);
    lastCandle.low = Math.min(lastCandle.low, price);
    lastCandle.close = price;
    lastCandle.volume = Number(tick.vol_traded || lastCandle.volume || 0);
  }

  emitLiveState(stateKey);
};

const updateLiveQuote = (stateKey, quote, source) => {
  const state = liveMarketState[stateKey];
  if (!state) {
    return;
  }

  const price = Number(quote?.ltp);
  if (!Number.isFinite(price)) {
    return;
  }
  if (!isReasonablePriceForState(stateKey, price)) {
    return;
  }

  const timestamp = Date.now();
  const bucket = getBucketIso(timestamp);
  const lastCandle = state.candles[state.candles.length - 1];
  const volume = Number.isFinite(Number(quote?.tradeVolume)) ? Number(quote.tradeVolume) : 0;

  state.connected = true;
  state.source = source;
  state.latestPrice = price;
  state.lastUpdated = new Date(timestamp).toISOString();

  if (!lastCandle || lastCandle.time !== bucket) {
    const candleOpen = lastCandle ? Number(lastCandle.close) : price;
    state.candles.push({
      time: bucket,
      open: candleOpen,
      high: Math.max(price, candleOpen),
      low: Math.min(price, candleOpen),
      close: price,
      volume
    });

    if (state.candles.length > MAX_LIVE_CANDLES) {
      state.candles = state.candles.slice(-MAX_LIVE_CANDLES);
    }
  } else {
    lastCandle.high = Math.max(lastCandle.high, price);
    lastCandle.low = Math.min(lastCandle.low, price);
    lastCandle.close = price;
    lastCandle.volume = Math.max(lastCandle.volume || 0, volume);
  }

  emitLiveState(stateKey);
};

const startMarketDataPolling = () => {
  if (marketPollTimer) {
    return;
  }

  const pollQuotes = async () => {
    try {
      if (!smartApiSession) {
        smartApiSession = await sdkLogin();
      }

      const response = await smartApiSession.smartApi.marketData({
        mode: "FULL",
        exchangeTokens: {
          NSE: getInstrumentConfigs().map((item) => String(item.token))
        }
      });

      if (!response?.status) {
        throw new Error(`Angel marketData failed: ${JSON.stringify(response)}`);
      }

      const fetchedQuotes = response?.data?.fetched || [];
      liveFeedStatus.pollCount += 1;
      liveFeedStatus.lastPollAt = new Date().toISOString();
      liveFeedStatus.lastError = null;

      fetchedQuotes.forEach((quote) => {
        const token = String(quote?.symbolToken || "");
        if (token === String(requireEnv("ANGEL_NIFTY_SPOT_TOKEN"))) {
          updateLiveQuote("nifty", quote, "angel-quote");
        }
        if (token === String(requireEnv("ANGEL_BANKNIFTY_SPOT_TOKEN"))) {
          updateLiveQuote("banknifty", quote, "angel-quote");
        }
      });
    } catch (error) {
      liveFeedStatus.lastError = error.message;
    }
  };

  marketPollTimer = setInterval(pollQuotes, LIVE_POLL_INTERVAL_MS);
  pollQuotes().catch(() => {});
};

const subscribeLiveTicks = async () => {
  const session = await sdkLogin();
  const { clientCode, jwtToken, feedToken } = session;
  smartApiSession = session;

  if (!feedToken) {
    throw new Error("Angel live feed token missing from login response");
  }

  liveFeedStatus.started = true;
  liveFeedStatus.transport = "startup";
  liveFeedStatus.lastError = null;

  marketSocket = new WebSocketV2({
    jwttoken: jwtToken,
    apikey: requireEnv("ANGEL_API_KEY"),
    clientcode: clientCode,
    feedtype: feedToken
  });

  marketSocket.customError();
  marketSocket.reconnection("simple", 5000);

  if (typeof marketSocket.on === "function") {
    marketSocket.on("connect", () => {
      liveFeedStatus.websocketConnected = true;
      liveFeedStatus.lastError = null;
    });
  }

  marketSocket.on("tick", (tick) => {
    const token = String(tick?.token || "").trim();

    if (token === String(requireEnv("ANGEL_NIFTY_SPOT_TOKEN"))) {
      updateLiveCandle("nifty", tick);
    }

    if (token === String(requireEnv("ANGEL_BANKNIFTY_SPOT_TOKEN"))) {
      updateLiveCandle("banknifty", tick);
    }
  });

  await marketSocket.connect();
  liveFeedStatus.websocketConnected = true;

  const subscriptions = getInstrumentConfigs();

  subscriptions.forEach((item) => {
    marketSocket.fetchData({
      correlationID: `live-${item.stateKey}`,
      action: ACTION.Subscribe,
      mode: MODE.LTP,
      exchangeType: item.exchangeType,
      tokens: [String(item.token)]
    });
  });

  startMarketDataPolling();
};

const startLiveMarketFeed = async () => {
  if (liveFeedStarted) {
    return;
  }

  if (liveFeedStartPromise) {
    return liveFeedStartPromise;
  }

  liveFeedStartPromise = subscribeLiveTicks()
    .then(() => {
      liveFeedStarted = true;
      startHistoricalBackfillRetry();
      return backfillHistoricalCandles();
    })
    .catch((error) => {
      liveFeedStarted = false;
      liveFeedStartPromise = null;
      liveFeedStatus.started = false;
      liveFeedStatus.lastError = error.message;
      throw error;
    });

  return liveFeedStartPromise;
};

const getLiveMarketSnapshot = (symbol) => {
  const stateKey = getLiveInstrumentConfig(symbol).stateKey;
  const state = liveMarketState[stateKey];

  return {
    symbol: state.symbol,
    ticker: state.ticker,
    source: state.source,
    connected: state.connected,
    latestPrice: state.latestPrice,
    lastUpdated: state.lastUpdated,
    candles: [...state.candles]
  };
};

const getLiveMarketFeedStatus = () => ({
  ...liveFeedStatus,
  symbols: Object.fromEntries(
    Object.entries(liveMarketState).map(([key, value]) => [
      key,
      {
        connected: value.connected,
        source: value.source,
        latestPrice: value.latestPrice,
        lastUpdated: value.lastUpdated,
        candleCount: value.candles.length
      }
    ])
  )
});

const subscribeToLiveMarket = (symbol, callback) => {
  const stateKey = getLiveInstrumentConfig(symbol).stateKey;
  const eventName = `tick:${stateKey}`;

  liveFeedEmitter.on(eventName, callback);
  return () => liveFeedEmitter.off(eventName, callback);
};

const placeOrder = async (trade, context = {}) => {
  if (!trade || trade === "WAIT") {
    return null;
  }

  if (PAPER_MODE || !ENABLE_REAL_TRADING) {
    return buildSimulatedOrder(trade, context);
  }

  return realTrade(trade);
};

const closeTrade = async (trade, context = {}) => {
  if (!trade || trade === "WAIT") {
    return null;
  }

  if (PAPER_MODE || !ENABLE_REAL_TRADING) {
    return buildSimulatedExit(trade, context);
  }

  return realExitTrade(trade);
};

module.exports = {
  placeOrder,
  closeTrade,
  startLiveMarketFeed,
  getLiveMarketSnapshot,
  subscribeToLiveMarket,
  getLiveMarketFeedStatus
};
