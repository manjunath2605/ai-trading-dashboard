import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE_URL = "http://localhost:4000";
const CHART_INTERVAL_LABEL = "1s";
const MIN_VISIBLE = 30;
const DEFAULT_VISIBLE = 120;

const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON response from ${url}. Check backend server and route.`);
  }
  if (!response.ok) {
    throw new Error(data?.details || data?.error || `Request failed for ${url}`);
  }
  return data;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const fmt = (value) => Number(value || 0).toFixed(2);
const fmtTime = (value) => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtExecutionTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const baseTime = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${baseTime}.${String(date.getMilliseconds()).padStart(3, "0")}`;
};
const toNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const formatDateKey = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA").format(date);
};

const formatDayLabel = (value) => {
  if (!value) return "Unknown day";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString([], {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
};

const getTradeDirection = (trade) => (trade?.signal === "BUY PUT" ? -1 : 1);

const getTradeClosedPnl = (trade) => {
  const quoteSource = String(trade?.quote_reliability || trade?.quote_source || "").trim().toLowerCase();
  if (quoteSource === "stale_quote" || quoteSource === "rejected_no_quote") {
    return 0;
  }

  if (typeof trade?.lotPnl === "number") {
    return Number(trade.lotPnl.toFixed(2));
  }

  const entry = toNumber(trade?.price, NaN);
  const exit = toNumber(trade?.exit_price, NaN);
  if (!Number.isFinite(entry) || !Number.isFinite(exit)) {
    return 0;
  }
  return Number(((exit - entry) * getTradeDirection(trade)).toFixed(2));
};

const getTradeOpenPnl = (trade) => {
  if (typeof trade?.current_pnl === "number") {
    return Number(trade.current_pnl.toFixed(2));
  }
  return 0;
};

const getTradeNetPnl = (trade) => (trade?.result === "OPEN" ? getTradeOpenPnl(trade) : getTradeClosedPnl(trade));
const getDisplayLotValue = (trade) => {
  if (typeof trade?.currentLotAmount === "number" && trade.result === "OPEN") {
    return trade.currentLotAmount;
  }

  if (typeof trade?.exitLotAmount === "number") {
    return trade.exitLotAmount;
  }

  return null;
};

const getEntryUnitPrice = (trade) => {
  if (typeof trade?.estimated_option_price === "number") {
    return trade.estimated_option_price;
  }

  if (typeof trade?.entryLotAmount === "number" && typeof trade?.optionQuantity === "number" && trade.optionQuantity > 0) {
    return Number((trade.entryLotAmount / trade.optionQuantity).toFixed(2));
  }

  return null;
};

const getDisplayUnitPrice = (trade) => {
  if (trade?.result === "OPEN" && typeof trade?.currentOptionPrice === "number") {
    return trade.currentOptionPrice;
  }

  if (typeof trade?.exitOptionPrice === "number") {
    return trade.exitOptionPrice;
  }

  const displayLotValue = getDisplayLotValue(trade);
  if (typeof displayLotValue === "number" && typeof trade?.optionQuantity === "number" && trade.optionQuantity > 0) {
    return Number((displayLotValue / trade.optionQuantity).toFixed(2));
  }

  return null;
};

const calcRsi = (candles, period = 14) => {
  if (!candles.length) return [];
  const closes = candles.map((c) => Number(c.close));
  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i += 1) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  return candles.map((candle, index) => {
    if (index < period) return { time: candle.time, value: null };
    const avgGain = gains.slice(index - period, index).reduce((a, b) => a + b, 0) / period;
    const avgLoss = losses.slice(index - period, index).reduce((a, b) => a + b, 0) / period;
    if (avgLoss === 0) return { time: candle.time, value: 100 };
    const rs = avgGain / avgLoss;
    return { time: candle.time, value: 100 - 100 / (1 + rs) };
  });
};

const calcEmaSeries = (candles, period) => {
  if (!candles.length) return [];
  const multiplier = 2 / (period + 1);
  let ema = Number(candles[0]?.close || 0);
  return candles.map((candle) => {
    const close = Number(candle?.close || 0);
    ema = ((close - ema) * multiplier) + ema;
    return { time: candle.time, value: ema };
  });
};

const deriveDynamicReadiness = (candles) => {
  if (!Array.isArray(candles) || candles.length < 25) {
    return { buy: 0, sell: 0 };
  }

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const highs = candles.slice(-20).map((candle) => Number(candle.high || 0));
  const lows = candles.slice(-20).map((candle) => Number(candle.low || 0));
  const ema20 = calcEmaSeries(candles, 20);
  const ema50 = calcEmaSeries(candles, 50);
  const latestEma20 = Number(ema20[ema20.length - 1]?.value || 0);
  const latestEma50 = Number(ema50[ema50.length - 1]?.value || 0);
  const prevEma20 = Number(ema20[ema20.length - 2]?.value || latestEma20);
  const latestClose = Number(last?.close || 0);
  const prevClose = Number(prev?.close || latestClose);
  const latestOpen = Number(last?.open || latestClose);
  const latestRsi = Number(calcRsi(candles).slice(-1)[0]?.value ?? 50);
  const resistance = highs.length ? Math.max(...highs.slice(0, -1)) : latestClose;
  const support = lows.length ? Math.min(...lows.slice(0, -1)) : latestClose;
  const breakoutUp = latestClose > resistance && prevClose <= resistance;
  const breakoutDown = latestClose < support && prevClose >= support;
  const candleUp = latestClose > latestOpen;
  const candleDown = latestClose < latestOpen;
  const emaSlopeUp = latestEma20 > prevEma20;
  const emaSlopeDown = latestEma20 < prevEma20;

  let buy = 35;
  let sell = 35;

  if (latestClose > latestEma20) buy += 12;
  else sell += 12;

  if (latestEma20 > latestEma50) buy += 14;
  else sell += 14;

  if (emaSlopeUp) buy += 10;
  if (emaSlopeDown) sell += 10;

  if (latestRsi >= 55) buy += Math.min(18, (latestRsi - 55) * 1.5);
  if (latestRsi <= 45) sell += Math.min(18, (45 - latestRsi) * 1.5);

  if (breakoutUp) buy += 18;
  if (breakoutDown) sell += 18;

  if (candleUp) buy += 8;
  if (candleDown) sell += 8;

  const total = Math.max(buy + sell, 1);
  return {
    buy: clamp(Math.round((buy / total) * 100), 0, 100),
    sell: clamp(Math.round((sell / total) * 100), 0, 100)
  };
};

const getMarketBias = (signal, buyReadiness, sellReadiness) => {
  const normalizedSignal = String(signal?.signal || "").trim().toUpperCase();
  const normalizedTrade = String(signal?.trade || "").trim().toUpperCase();
  const serverBias = String(signal?.market_bias || signal?.directional_bias || "").trim().toUpperCase();
  const candleBias = String(signal?.candlestick_bias || signal?.candlestick?.bias || "").trim().toUpperCase();

  if (normalizedSignal === "BUY CALL" || normalizedTrade.endsWith("CE") || serverBias === "BULLISH") {
    return {
      label: "UP",
      tone: "bullish",
      color: "#0f9d58",
      detail: candleBias === "BULLISH"
        ? `Bullish bias confirmed by ${signal?.candlestick_pattern?.replace(/_/g, " ") || "candlestick"} pattern`
        : "Market structure & momentum favor upward expansion"
    };
  }

  if (normalizedSignal === "BUY PUT" || normalizedTrade.endsWith("PE") || serverBias === "BEARISH") {
    return {
      label: "DOWN",
      tone: "bearish",
      color: "#dc2626",
      detail: candleBias === "BEARISH"
        ? `Bearish bias confirmed by ${signal?.candlestick_pattern?.replace(/_/g, " ") || "candlestick"} pattern`
        : "Market structure & momentum favor downward expansion"
    };
  }

  if (buyReadiness > sellReadiness + 8) {
    return {
      label: "UP",
      tone: "bullish",
      color: "#0f9d58",
      detail: "Buy readiness is stronger than sell readiness"
    };
  }

  if (sellReadiness > buyReadiness + 8) {
    return {
      label: "DOWN",
      tone: "bearish",
      color: "#dc2626",
      detail: "Sell readiness is stronger than buy readiness"
    };
  }

  return {
    label: "NEUTRAL",
    tone: "neutral",
    color: "#64748b",
    detail: "Consolidating in range; waiting for directional resolution"
  };
};

const getTrendForecast = (signal, buyReadiness, sellReadiness) => {
  const normalizedSignal = String(signal?.signal || "").trim().toUpperCase();
  const normalizedTrade = String(signal?.trade || "").trim().toUpperCase();
  const regime = String(signal?.market_regime || "").trim().toUpperCase();
  const liquidity = String(signal?.liquidity_signal || "").trim().toUpperCase();
  const higherTfBullish = signal?.higher_tf_bullish === true;
  const higherTfBearish = signal?.higher_tf_bearish === true;

  let direction = "NEUTRAL";
  let trend = "Range";
  let detail = "No reliable follow-through yet";

  if (normalizedSignal === "BUY CALL" || normalizedTrade.endsWith("CE") || buyReadiness > sellReadiness + 8) {
    direction = "UP";
    trend = "Continuation";
    detail = "Likely bullish continuation if momentum holds";
  } else if (normalizedSignal === "BUY PUT" || normalizedTrade.endsWith("PE") || sellReadiness > buyReadiness + 8) {
    direction = "DOWN";
    trend = "Continuation";
    detail = "Likely bearish continuation if selling pressure persists";
  }

  if (regime === "TREND_UP" && direction !== "DOWN") {
    direction = "UP";
    trend = "Trend Follow";
    detail = "Higher timeframe and structure favor upside follow-through";
  } else if (regime === "TREND_DOWN" && direction !== "UP") {
    direction = "DOWN";
    trend = "Trend Follow";
    detail = "Higher timeframe and structure favor downside follow-through";
  }

  if (["SWEEP_LOW", "BREAKOUT_UP"].includes(liquidity) && direction !== "DOWN") {
    direction = "UP";
    trend = liquidity === "SWEEP_LOW" ? "Reversal" : "Breakout";
    detail = liquidity === "SWEEP_LOW"
      ? "Liquidity sweep below support can fuel a rebound"
      : "Breakout above resistance can extend the move";
  } else if (["SWEEP_HIGH", "BREAKOUT_DOWN"].includes(liquidity) && direction !== "UP") {
    direction = "DOWN";
    trend = liquidity === "SWEEP_HIGH" ? "Reversal" : "Breakdown";
    detail = liquidity === "SWEEP_HIGH"
      ? "Liquidity sweep above resistance can trigger a drop"
      : "Breakdown below support can extend selling";
  }

  if (higherTfBullish && direction !== "DOWN") {
    direction = "UP";
    trend = trend === "Range" ? "Trend Follow" : trend;
    detail = "5m structure is still leaning bullish";
  } else if (higherTfBearish && direction !== "UP") {
    direction = "DOWN";
    trend = trend === "Range" ? "Trend Follow" : trend;
    detail = "5m structure is still leaning bearish";
  }

  if (direction === "NEUTRAL") {
    trend = "Range";
    detail = "Price may chop until a clearer breakout forms";
  }

  return {
    direction,
    trend,
    color: direction === "UP" ? "#0f9d58" : direction === "DOWN" ? "#dc2626" : "#64748b",
    label: `${direction === "NEUTRAL" ? "NEUTRAL" : direction} / ${trend}`,
    detail
  };
};

function ChartPanel({ title, symbol, signal, marketStatus, onBuySignal }) {
  const chartRef = useRef(null);
  const [data, setData] = useState({ candles: [], ticker: "", source: "", connected: false, latestPrice: null, lastUpdated: null });
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(DEFAULT_VISIBLE);
  const [start, setStart] = useState(0);
  const [hover, setHover] = useState(null);
  const [selected, setSelected] = useState(null);
  const [ticketPrice, setTicketPrice] = useState(null);
  const [drag, setDrag] = useState(null);

  useEffect(() => {
    let active = true;
    let stream;
    fetchJson(`${API_BASE_URL}/market/candles/${symbol}`).then((payload) => {
      if (!active) return;
      setData((prev) => ({
        ...prev,
        candles: Array.isArray(payload.candles) ? payload.candles : [],
        ticker: payload.ticker || symbol.toUpperCase(),
        source: payload.source || "snapshot",
        connected: Boolean(payload.connected),
        latestPrice: payload.latestPrice ?? prev.latestPrice,
        lastUpdated: payload.lastUpdated ?? prev.lastUpdated
      }));
      setError("");
    }).catch((e) => active && setError(e.message));

    stream = new EventSource(`${API_BASE_URL}/market/stream/${symbol}`);
    stream.onmessage = (event) => {
      if (!active) return;
      if (marketStatus && marketStatus.open === false) return;
      const payload = JSON.parse(event.data);
      setData((prev) => ({
        candles: Array.isArray(payload.candles) && payload.candles.length > 0 ? payload.candles : prev.candles,
        ticker: payload.ticker || prev.ticker || symbol.toUpperCase(),
        source: payload.source || prev.source || "live",
        connected: Boolean(payload.connected),
        latestPrice: payload.latestPrice ?? prev.latestPrice ?? null,
        lastUpdated: payload.lastUpdated ?? prev.lastUpdated ?? null
      }));
      setError("");
    };
    stream.onerror = () => active && setError("Live feed disconnected");
    return () => {
      active = false;
      if (stream) stream.close();
    };
  }, [symbol, marketStatus]);

  useEffect(() => {
    if (!data.candles.length) return;
    const count = clamp(visible, MIN_VISIBLE, data.candles.length);
    setVisible(count);
    setStart((prev) => clamp(prev || Math.max(0, data.candles.length - count), 0, Math.max(0, data.candles.length - count)));
    setSelected((prev) => prev ?? data.candles.length - 1);
    setTicketPrice((prev) => prev ?? Number(data.candles[data.candles.length - 1].close));
  }, [data.candles, visible]);

  const metrics = useMemo(() => {
    const width = 1120;
    const candleHeight = 330;
    const rsiHeight = 130;
    const left = 16;
    const right = 78;
    const top = 20;
    const bottom = 26;
    const count = clamp(visible, MIN_VISIBLE, Math.max(data.candles.length, 1));
    const safeStart = clamp(start, 0, Math.max(0, data.candles.length - count));
    const end = Math.min(data.candles.length, safeStart + count);
    const visibleCandles = data.candles.slice(safeStart, end);
    const visibleRsi = calcRsi(data.candles).slice(safeStart, end);
    const chartWidth = width - left - right;
    const highs = visibleCandles.map((c) => Number(c.high));
    const lows = visibleCandles.map((c) => Number(c.low));
    const vols = visibleCandles.map((c) => Number(c.volume || 0));
    const maxHigh = highs.length ? Math.max(...highs) : 1;
    const minLow = lows.length ? Math.min(...lows) : 0;
    const pad = (maxHigh - minLow || 1) * 0.08;
    const maxPrice = maxHigh + pad;
    const minPrice = minLow - pad;
    const range = Math.max(maxPrice - minPrice, 1);
    const drawHeight = candleHeight - top - bottom;
    const gap = chartWidth / Math.max(visibleCandles.length, 1);
    const candleWidth = Math.min(Math.max(gap * 0.62, 4), 12);
    const maxVol = vols.length ? Math.max(...vols) : 1;
    const last = visibleCandles[visibleCandles.length - 1];
    const latest = Number(data.latestPrice ?? last?.close ?? 0);
    const prevClose = visibleCandles.length > 1 ? Number(visibleCandles[visibleCandles.length - 2].close) : latest;
    const change = latest - prevClose;
    const changePct = prevClose ? (change / prevClose) * 100 : 0;
    const latestRsi = [...visibleRsi].reverse().find((point) => point.value !== null)?.value ?? 50;
    return {
      width, candleHeight, rsiHeight, left, right, top, bottom, safeStart, end, visibleCandles, visibleRsi,
      chartWidth, candleWidth, maxVol, maxPrice, range, latest, change, changePct, latestRsi,
      yPrice: (price) => top + ((maxPrice - price) / range) * drawHeight,
      xIndex: (index) => left + ((index + 0.5) * chartWidth) / Math.max(visibleCandles.length, 1),
      gap
    };
  }, [data.candles, data.latestPrice, start, visible]);

  const activeSignal = signal?.signal || "HOLD";
  const dynamicReadiness = useMemo(() => deriveDynamicReadiness(data.candles), [data.candles]);
  const apiBuyReadiness = toNumber(signal?.buy_readiness, 0);
  const apiSellReadiness = toNumber(signal?.sell_readiness, 0);
  const buyReadiness = apiBuyReadiness > 0 ? apiBuyReadiness : dynamicReadiness.buy;
  const sellReadiness = apiSellReadiness > 0 ? apiSellReadiness : dynamicReadiness.sell;
  const marketBias = useMemo(() => getMarketBias(signal, buyReadiness, sellReadiness), [signal, buyReadiness, sellReadiness]);
  const trendForecast = useMemo(() => getTrendForecast(signal, buyReadiness, sellReadiness), [signal, buyReadiness, sellReadiness]);
  const trendMeter = useMemo(() => {
    const diff = buyReadiness - sellReadiness;
    const strength = clamp(Math.min(100, Math.abs(diff) * 1.5 + 20), 15, 100);
    const direction = diff > 8 ? "UP" : diff < -8 ? "DOWN" : "NEUTRAL";
    const position = direction === "UP" ? 50 + (strength / 2) : direction === "DOWN" ? 50 - (strength / 2) : 50;
    return {
      direction,
      position: clamp(position, 8, 92),
      color: direction === "UP" ? "#0f9d58" : direction === "DOWN" ? "#dc2626" : "#64748b",
      label: direction === "NEUTRAL" ? "Balanced" : direction === "UP" ? "Bullish pressure" : "Bearish pressure"
    };
  }, [buyReadiness, sellReadiness]);
  const isHold = activeSignal === "HOLD" || !signal?.trade || signal.trade === "WAIT";
  const blockedReason = !isHold && Array.isArray(signal?.failed_checks) && signal.failed_checks.length > 0 ? signal.failed_checks[0] : "";
  const signalExecutable = !isHold && !blockedReason;
  const signalHeadline = signalExecutable ? activeSignal : (isHold ? "SCANNING (HOLD)" : `${activeSignal} (Blocked)`);
  const signalColor = activeSignal === "BUY CALL" ? "#0f9d58" : activeSignal === "BUY PUT" ? "#dc2626" : "#64748b";
  const ticketAction = activeSignal === "BUY PUT" ? "SELL" : "BUY";
  const ticketMode = activeSignal === "BUY PUT" ? "PUT" : "CALL";
  const activeCandle = data.candles[hover ?? selected ?? (data.candles.length - 1)] || metrics.visibleCandles[metrics.visibleCandles.length - 1];
  const currentTicket = ticketPrice ?? Number(signal?.price || metrics.latest || 0);

  const localIndexFromEvent = (event) => {
    if (!chartRef.current || !metrics.visibleCandles.length) return null;
    const rect = chartRef.current.getBoundingClientRect();
    const x = clamp(event.clientX - rect.left - metrics.left, 0, metrics.chartWidth - 1);
    return clamp(Math.floor(x / Math.max(metrics.gap, 1)), 0, metrics.visibleCandles.length - 1);
  };

  const onMove = (event) => {
    const local = localIndexFromEvent(event);
    if (local === null) return;
    setHover(metrics.safeStart + local);
    if (drag) {
      const shift = Math.round((event.clientX - drag.x) / Math.max(metrics.gap, 1));
      setStart(clamp(drag.start - shift, 0, Math.max(0, data.candles.length - visible)));
    }
  };

  const onClickChart = (event) => {
    const local = localIndexFromEvent(event);
    if (local === null) return;
    const global = metrics.safeStart + local;
    setSelected(global);
    setTicketPrice(Number(data.candles[global]?.close || 0));
  };

  const onWheel = (event) => {
    event.preventDefault();
    if (!data.candles.length) return;
    const focus = hover ?? selected ?? data.candles.length - 1;
    const nextVisible = clamp(visible + (event.deltaY > 0 ? 8 : -8), MIN_VISIBLE, data.candles.length);
    const ratio = metrics.visibleCandles.length ? (focus - metrics.safeStart) / metrics.visibleCandles.length : 1;
    const nextStart = clamp(Math.round(focus - nextVisible * ratio), 0, Math.max(0, data.candles.length - nextVisible));
    setVisible(nextVisible);
    setStart(nextStart);
  };

  const selectSignalMarker = () => {
    setSelected(data.candles.length - 1);
    setTicketPrice(Number(signal?.price || metrics.latest || 0));
  };

  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ marginBottom: 12 }}>{title}</h2>
      <div style={{ border: "1px solid #d8dee8", borderRadius: 16, overflow: "hidden", background: "#fff", boxShadow: "0 22px 50px rgba(15, 23, 42, 0.08)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid #e8edf5", background: "#fbfcfe" }}>
          <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "#4f46e5", fontWeight: 700 }}>Chart</span>
            <span>Overview</span>
            <span>Option Chain</span>
            <span>Stock Composition</span>
          </div>
          <button style={{ border: "1px solid #d7def0", background: "#fff", borderRadius: 10, padding: "8px 14px", color: "#6d28d9", fontWeight: 700 }}>SCALPER MODE</button>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid #eef2f7" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <strong>{CHART_INTERVAL_LABEL}</strong>
            <span>Candles</span>
            <span>Indicators</span>
            <span>Instant Orders</span>
          </div>
          <div style={{ color: "#64748b" }}>Zoom: {metrics.visibleCandles.length}</div>
        </div>

        {error ? (
          <div style={{ padding: 20, color: "#b91c1c" }}>{error}</div>
        ) : !data.candles.length ? (
          <div style={{ padding: 20 }}>Loading market data...</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "54px 1fr", minHeight: 610 }}>
            <div style={{ borderRight: "1px solid #eef2f7", background: "#fcfdff", display: "flex", flexDirection: "column", alignItems: "center", gap: 16, paddingTop: 18, color: "#475569", fontSize: 18 }}>
              <span>+</span><span>/</span><span>=</span><span>[]</span><span>o</span><span>T</span><span>*</span><span>#</span>
            </div>
            <div style={{ padding: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                    <strong style={{ fontSize: 30 }}>{signal?.symbol || title.replace(" Chart", "")} · 5 · NSE</strong>
                    <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#16a34a", display: "inline-block" }} />
                  </div>
                  <div style={{ color: metrics.change >= 0 ? "#0f9d58" : "#d93025", fontSize: 18 }}>
                    O {fmt(activeCandle?.open)} H {fmt(activeCandle?.high)} L {fmt(activeCandle?.low)} C {fmt(activeCandle?.close ?? metrics.latest)} {metrics.change >= 0 ? "+" : ""}{fmt(metrics.change)} ({metrics.change >= 0 ? "+" : ""}{metrics.changePct.toFixed(2)}%)
                  </div>
                  <div style={{ color: "#64748b", marginTop: 6 }}>
                    Volume {Number(activeCandle?.volume || 0).toLocaleString()} | {activeCandle?.time ? fmtTime(activeCandle.time) : "-"}
                  </div>
                  <div style={{ color: "#64748b", marginTop: 6 }}>
                    Buy Readiness {buyReadiness}% | Sell Readiness {sellReadiness}%
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 14px", borderRadius: 999, background: `${marketBias.color}14`, color: marketBias.color, fontWeight: 800, fontSize: 13, border: `1px solid ${marketBias.color}35` }}>
                      <span style={{ fontSize: 15 }}>{marketBias.label === "UP" ? "▲ UP" : marketBias.label === "DOWN" ? "▼ DOWN" : "◆ NEUTRAL"}</span>
                      <span>Market Bias: {marketBias.label}</span>
                      <span style={{ fontWeight: 600, color: "#64748b" }}>— {marketBias.detail}</span>
                    </div>
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 14px", borderRadius: 999, background: `${trendForecast.color}14`, color: trendForecast.color, fontWeight: 800, fontSize: 13, border: `1px solid ${trendForecast.color}35` }}>
                      <span>Next Trend: {trendForecast.label}</span>
                      <span style={{ fontWeight: 600, color: "#64748b" }}>— {trendForecast.detail}</span>
                    </div>
                    {signal?.candlestick_pattern && signal.candlestick_pattern !== "NONE" && (
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 14px", borderRadius: 999, background: "#f0fdf4", color: "#166534", fontWeight: 800, fontSize: 13, border: "1px solid #bbf7d0" }}>
                        <span>🕯️ Candle: {signal.candlestick_pattern.replace(/_/g, " ")}</span>
                        {signal.candlestick_strength > 0 && <span>{"⭐".repeat(Math.min(signal.candlestick_strength, 5))}</span>}
                        {signal.candlestick_description && (
                          <span style={{ fontWeight: 600, color: "#475569" }}>— {signal.candlestick_description}</span>
                        )}
                      </div>
                    )}
                  </div>

                  {signal?.target && (
                    <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, padding: 12, borderRadius: 12, background: "#f8fafc", border: "1px solid #e2e8f0" }}>
                      <div style={{ padding: 10, borderRadius: 10, background: "#ecfdf5", border: "1px solid #a7f3d0" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#065f46", textTransform: "uppercase" }}>Target 1 (1:2.2 RR)</div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: "#047857" }}>Spot: {fmt(signal.target)}</div>
                        {signal.option_target_price && (
                          <div style={{ fontSize: 12, color: "#065f46", marginTop: 2 }}>Option: ₹{fmt(signal.option_target_price)}</div>
                        )}
                        {typeof signal.expected_profit_t1 === "number" && signal.expected_profit_t1 > 0 && (
                          <div style={{ fontSize: 13, fontWeight: 800, color: "#059669", marginTop: 4 }}>
                            +Rs. {Number(signal.expected_profit_t1).toLocaleString("en-IN", { minimumFractionDigits: 2 })}/lot
                          </div>
                        )}
                      </div>
                      {signal.target_2 && (
                        <div style={{ padding: 10, borderRadius: 10, background: "#eff6ff", border: "1px solid #bfdbfe" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#1e40af", textTransform: "uppercase" }}>Target 2 Runner (1:3.6 RR)</div>
                          <div style={{ fontSize: 16, fontWeight: 800, color: "#1d4ed8" }}>Spot: {fmt(signal.target_2)}</div>
                          {signal.option_target_price_2 && (
                            <div style={{ fontSize: 12, color: "#1e40af", marginTop: 2 }}>Option: ₹{fmt(signal.option_target_price_2)}</div>
                          )}
                          {typeof signal.expected_profit_t2 === "number" && signal.expected_profit_t2 > 0 && (
                            <div style={{ fontSize: 13, fontWeight: 800, color: "#2563eb", marginTop: 4 }}>
                              +Rs. {Number(signal.expected_profit_t2).toLocaleString("en-IN", { minimumFractionDigits: 2 })}/lot
                            </div>
                          )}
                        </div>
                      )}
                      {signal.stop_loss && (
                        <div style={{ padding: 10, borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca" }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#991b1b", textTransform: "uppercase" }}>Stop Loss</div>
                          <div style={{ fontSize: 16, fontWeight: 800, color: "#b91c1c" }}>Spot: {fmt(signal.stop_loss)}</div>
                          {signal.option_stop_loss && (
                            <div style={{ fontSize: 12, color: "#991b1b", marginTop: 2 }}>Option: ₹{fmt(signal.option_stop_loss)}</div>
                          )}
                          {typeof signal.max_risk_rupees === "number" && signal.max_risk_rupees > 0 && (
                            <div style={{ fontSize: 13, fontWeight: 800, color: "#dc2626", marginTop: 4 }}>
                              -Rs. {Number(signal.max_risk_rupees).toLocaleString("en-IN", { minimumFractionDigits: 2 })}/lot
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {isHold ? (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 12px", borderRadius: 999, background: "#f1f5f9", color: "#475569", marginTop: 10, fontSize: 13, fontWeight: 600 }}>
                      <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#64748b", display: "inline-block" }} />
                      <span>Status: Waiting for Setup (HOLD)</span>
                      <span style={{ color: "#64748b", fontWeight: 400 }}>— {signal?.reason || "Scanning market for entry confirmation"}</span>
                    </div>
                  ) : (
                    <>
                      {Array.isArray(signal?.failed_checks) && signal.failed_checks.length > 0 && (
                        <div style={{ color: "#b45309", marginTop: 8, fontSize: 13, fontWeight: 600 }}>
                          Trade Gate: {signal.failed_checks.join(" | ")}
                        </div>
                      )}
                      {!signalExecutable && blockedReason && (
                        <div style={{ color: "#b91c1c", marginTop: 8, fontSize: 13, fontWeight: 700 }}>
                          Reason: {blockedReason}
                        </div>
                      )}
                    </>
                  )}
                  {typeof signal?.one_min_candles === "number" && typeof signal?.five_min_candles === "number" && (
                    <div style={{ color: "#64748b", marginTop: 6, fontSize: 13 }}>
                      Candles ready: 1m {signal.one_min_candles} | 5m {signal.five_min_candles}
                    </div>
                  )}
                </div>
                <button onClick={selectSignalMarker} style={{ padding: "8px 12px", borderRadius: 999, background: signalColor, color: "#fff", fontWeight: 700, minWidth: 112, border: "none", cursor: "pointer" }}>
                  {signalHeadline}
                </button>
              </div>

              <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 14, border: "1px solid #dbe4f0", background: "linear-gradient(90deg, #f8fafc 0%, #eef6ff 100%)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12, flexWrap: "wrap" }}>
                  <div style={{ fontWeight: 800, color: "#0f172a" }}>Trend Meter</div>
                  <div style={{ color: trendMeter.color, fontWeight: 800 }}>{trendForecast.label}</div>
                </div>
                <div style={{ position: "relative", height: 16, borderRadius: 999, overflow: "hidden", background: "linear-gradient(90deg, #dc2626 0%, #f59e0b 42%, #cbd5e1 50%, #60a5fa 58%, #0f9d58 100%)" }}>
                  <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 2, background: "#fff" }} />
                  <div style={{ position: "absolute", left: `${trendMeter.position}%`, top: -6, transform: "translateX(-50%)", width: 0, height: 0, borderLeft: "8px solid transparent", borderRight: "8px solid transparent", borderTop: `14px solid ${trendMeter.color}` }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, color: "#64748b", fontSize: 12 }}>
                  <span>Bearish</span>
                  <span>Neutral</span>
                  <span>Bullish</span>
                </div>
                <div style={{ marginTop: 6, color: "#334155", fontSize: 12 }}>{trendMeter.label}</div>
              </div>

              <div style={{ border: "1px solid #d9e1ec", borderRadius: 14, overflow: "hidden", background: "#fbfdff", boxShadow: "0 1px 0 rgba(15, 23, 42, 0.03)" }}>
                <div
                  ref={chartRef}
                  onMouseMove={marketStatus?.open === false ? undefined : onMove}
                  onMouseLeave={() => { setHover(null); setDrag(null); }}
                  onMouseDown={marketStatus?.open === false ? undefined : (event) => setDrag({ x: event.clientX, start: start })}
                  onMouseUp={() => setDrag(null)}
                  onClick={marketStatus?.open === false ? undefined : onClickChart}
                  onWheel={marketStatus?.open === false ? undefined : onWheel}
                  style={{ cursor: marketStatus?.open === false ? "not-allowed" : (drag ? "grabbing" : "crosshair"), position: "relative" }}
                >
                  <svg viewBox={`0 0 ${metrics.width} ${metrics.candleHeight}`} width="100%" height="340">
                    <defs>
                      <marker id="trend-arrow-up" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth">
                        <path d="M0,0 L10,5 L0,10 z" fill={trendForecast.color} />
                      </marker>
                      <marker id="trend-arrow-down" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth">
                        <path d="M0,0 L10,5 L0,10 z" fill={trendForecast.color} />
                      </marker>
                    </defs>
                    <rect width={metrics.width} height={metrics.candleHeight} fill="#fbfdff" />
                    {Array.from({ length: 5 }, (_, index) => {
                      const price = metrics.maxPrice - (metrics.range * index) / 4;
                      const y = metrics.yPrice(price);
                      return (
                        <g key={`grid-${index}`}>
                          <line x1={metrics.left} x2={metrics.width - metrics.right} y1={y} y2={y} stroke="#dbe3ef" strokeDasharray="3 6" />
                          <text x={metrics.width - metrics.right + 10} y={y + 4} fill="#4b5563" fontSize="12">{fmt(price)}</text>
                        </g>
                      );
                    })}

                    {metrics.visibleCandles.map((candle, index) => {
                      const global = metrics.safeStart + index;
                      const x = metrics.xIndex(index);
                      const openY = metrics.yPrice(Number(candle.open));
                      const closeY = metrics.yPrice(Number(candle.close));
                      const highY = metrics.yPrice(Number(candle.high));
                      const lowY = metrics.yPrice(Number(candle.low));
                      const up = Number(candle.close) >= Number(candle.open);
                      const color = up ? "#0f9d8a" : "#ef4b5f";
                      const bodyY = Math.min(openY, closeY);
                      const bodyH = Math.max(Math.abs(closeY - openY), 2);
                      const volH = metrics.maxVol ? (Number(candle.volume || 0) / metrics.maxVol) * 78 : 0;
                      const picked = global === selected;
                      return (
                        <g key={`${candle.time}-${index}`}>
                          {picked && <rect x={x - metrics.candleWidth} y={10} width={metrics.candleWidth * 2} height={metrics.candleHeight - 28} fill="#dff4f1" opacity="0.65" />}
                          <line x1={x} x2={x} y1={highY} y2={lowY} stroke={color} strokeWidth="1.2" />
                          <rect x={x - metrics.candleWidth / 2} y={bodyY} width={metrics.candleWidth} height={bodyH} rx="0.5" fill={color} />
                          <rect x={x - metrics.candleWidth / 2} y={metrics.candleHeight - volH - 8} width={metrics.candleWidth} height={volH} fill={up ? "#9adccf" : "#f6a7b1"} opacity="0.95" />
                        </g>
                      );
                    })}

                    {metrics.visibleCandles.length > 0 && (() => {
                      const lastIndex = metrics.visibleCandles.length - 1;
                      const lastCandle = metrics.visibleCandles[lastIndex];
                      const lastX = metrics.xIndex(lastIndex);
                      const lastClose = Number(lastCandle?.close ?? metrics.latest ?? 0);
                      const projectedPrice = trendForecast.direction === "UP"
                        ? Math.min(metrics.maxPrice, lastClose + (metrics.range * 0.12))
                        : trendForecast.direction === "DOWN"
                          ? Math.max(metrics.maxPrice - metrics.range, lastClose - (metrics.range * 0.12))
                          : lastClose;
                      const projectedX = Math.min(metrics.width - metrics.right - 12, lastX + metrics.gap * 0.85);
                      const projectedY = metrics.yPrice(projectedPrice);
                      const lastY = metrics.yPrice(lastClose);

                      if (trendForecast.direction === "NEUTRAL") {
                        return (
                          <g key="trend-neutral">
                            <line x1={lastX} x2={projectedX} y1={lastY} y2={projectedY} stroke={trendForecast.color} strokeDasharray="4 4" strokeWidth="2" />
                            <circle cx={projectedX} cy={projectedY} r="4.5" fill={trendForecast.color} />
                          </g>
                        );
                      }

                      return (
                        <g key="trend-project">
                          <line
                            x1={lastX}
                            x2={projectedX}
                            y1={lastY}
                            y2={projectedY}
                            stroke={trendForecast.color}
                            strokeWidth="2.5"
                            strokeDasharray="3 4"
                            markerEnd={trendForecast.direction === "UP" ? "url(#trend-arrow-up)" : "url(#trend-arrow-down)"}
                          />
                          <circle cx={projectedX} cy={projectedY} r="5" fill={trendForecast.color} />
                          <text x={projectedX + 8} y={projectedY - 8} fill={trendForecast.color} fontSize="12" fontWeight="800">
                            {trendForecast.direction === "UP" ? "Projected Up" : "Projected Down"}
                          </text>
                        </g>
                      );
                    })()}

                    {Array.from(new Set([0, Math.floor(metrics.visibleCandles.length * 0.33), Math.floor(metrics.visibleCandles.length * 0.66), metrics.visibleCandles.length - 1])).map((index) => {
                      const candle = metrics.visibleCandles[index];
                      return candle ? <text key={candle.time} x={metrics.xIndex(index)} y={metrics.candleHeight - 10} fill="#4b5563" fontSize="12" textAnchor="middle">{fmtTime(candle.time)}</text> : null;
                    })}

                    {hover !== null && hover >= metrics.safeStart && hover < metrics.end && (
                      <>
                        <line x1={metrics.xIndex(hover - metrics.safeStart)} x2={metrics.xIndex(hover - metrics.safeStart)} y1={10} y2={metrics.candleHeight - 28} stroke="#a7b5c8" strokeDasharray="4 4" />
                        <line x1={metrics.left} x2={metrics.width - metrics.right} y1={metrics.yPrice(Number(activeCandle?.close || 0))} y2={metrics.yPrice(Number(activeCandle?.close || 0))} stroke="#a7b5c8" strokeDasharray="4 4" />
                        <g transform={`translate(${Math.min(metrics.xIndex(hover - metrics.safeStart) + 12, metrics.width - 240)}, 18)`}>
                          <rect width="220" height="86" rx="10" fill="#18202c" opacity="0.96" />
                          <text x="12" y="22" fill="#ffffff" fontSize="13" fontWeight="700">{fmtTime(activeCandle.time)}</text>
                          <text x="12" y="42" fill="#d6deea" fontSize="12">O {fmt(activeCandle.open)} H {fmt(activeCandle.high)}</text>
                          <text x="12" y="60" fill="#d6deea" fontSize="12">L {fmt(activeCandle.low)} C {fmt(activeCandle.close)}</text>
                          <text x="12" y="78" fill="#d6deea" fontSize="12">Click to select candle</text>
                        </g>
                      </>
                    )}

                    <line x1={metrics.left} x2={metrics.width - metrics.right} y1={metrics.yPrice(metrics.latest)} y2={metrics.yPrice(metrics.latest)} stroke="#1aa39a" strokeDasharray="2 3" />
                    <g onClick={selectSignalMarker} style={{ cursor: "pointer" }}>
                      <rect x={metrics.left + 18} y={metrics.yPrice(metrics.latest) - 18} width="160" height="28" rx="14" fill={signalColor} />
                      <text x={metrics.left + 98} y={metrics.yPrice(metrics.latest) + 1} fill="#fff" fontSize="12" fontWeight="700" textAnchor="middle">
                        {(signalExecutable ? activeSignal : "Not Executed")} {signal?.trade && signal.trade !== "WAIT" ? `| ${signal.trade}` : ""}
                      </text>
                    </g>
                    <g>
                      <rect x={metrics.width - 238} y="18" width="208" height="44" rx="12" fill={marketBias.color} opacity="0.12" />
                      <text x={metrics.width - 132} y="36" fill={marketBias.color} fontSize="13" fontWeight="800" textAnchor="middle">
                        Market Bias: {marketBias.label}
                      </text>
                      <text x={metrics.width - 132} y="52" fill="#475569" fontSize="11" textAnchor="middle">
                        {marketBias.detail}
                      </text>
                    </g>
                    <g>
                      <rect x={metrics.width - 238} y="70" width="208" height="52" rx="12" fill={trendForecast.color} opacity="0.12" />
                      <text x={metrics.width - 132} y="88" fill={trendForecast.color} fontSize="13" fontWeight="800" textAnchor="middle">
                        Next Trend: {trendForecast.direction}
                      </text>
                      <text x={metrics.width - 132} y="104" fill="#475569" fontSize="11" textAnchor="middle">
                        {trendForecast.trend}
                      </text>
                      <text x={metrics.width - 132} y="118" fill="#475569" fontSize="10" textAnchor="middle">
                        {trendForecast.detail}
                      </text>
                    </g>
                  </svg>
                  {marketStatus?.open === false && (
                    <div style={{ position: "absolute", inset: 0, background: "rgba(255, 247, 237, 0.55)", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "all" }}>
                      <div style={{ background: "#fff7ed", color: "#9a3412", border: "1px solid #fed7aa", borderRadius: 999, padding: "10px 18px", fontWeight: 800, boxShadow: "0 8px 24px rgba(15, 23, 42, 0.08)" }}>
                        Market Closed
                      </div>
                    </div>
                  )}
                </div>

                <svg viewBox={`0 0 ${metrics.width} ${metrics.rsiHeight}`} width="100%" height="140" style={{ borderTop: "1px solid #e3e9f2" }}>
                  <rect width={metrics.width} height={metrics.rsiHeight} fill="#f6f2ff" />
                  {[20, 40, 60, 80].map((level) => {
                    const y = 12 + ((100 - level) / 100) * (metrics.rsiHeight - 28);
                    return (
                      <g key={`rsi-${level}`}>
                        <line x1={metrics.left} x2={metrics.width - metrics.right} y1={y} y2={y} stroke="#c9bbff" strokeDasharray="4 5" />
                        <text x={metrics.width - metrics.right + 10} y={y + 4} fill="#7c63e6" fontSize="12">{level.toFixed(2)}</text>
                      </g>
                    );
                  })}
                  <text x={metrics.left} y="18" fill="#7257e8" fontSize="14" fontWeight="700">RSI 14 {metrics.latestRsi.toFixed(2)}</text>
                  <polyline
                    fill="none"
                    stroke="#7b61ff"
                    strokeWidth="2"
                    points={metrics.visibleRsi.filter((point) => point.value !== null).map((point, index) => `${metrics.xIndex(index)},${12 + ((100 - point.value) / 100) * (metrics.rsiHeight - 28)}`).join(" ")}
                  />
                  {hover !== null && hover >= metrics.safeStart && hover < metrics.end && (
                    <line x1={metrics.xIndex(hover - metrics.safeStart)} x2={metrics.xIndex(hover - metrics.safeStart)} y1={12} y2={metrics.rsiHeight - 16} stroke="#a7b5c8" strokeDasharray="4 4" />
                  )}
                </svg>
              </div>

              <div style={{ marginTop: 14, padding: 12, border: "1px solid #e2e8f0", borderRadius: 16, background: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ minWidth: 92 }}>
                    <div style={{ fontWeight: 700 }}>{signal?.symbol || title.replace(" Chart", "")}</div>
                    <div style={{ color: "#0f9d58", fontWeight: 700 }}>{fmt(metrics.latest)} {metrics.change >= 0 ? "▲" : "▼"} {fmt(Math.abs(metrics.change))} ({metrics.changePct.toFixed(2)}%)</div>
                  </div>
                  <div style={{ display: "flex", border: "1px solid #cbd5e1", borderRadius: 999, overflow: "hidden" }}>
                    <button style={{ padding: "8px 14px", border: "none", background: ticketAction === "BUY" ? "#0f9d58" : "#f8fafc", color: ticketAction === "BUY" ? "#fff" : "#0f172a", fontWeight: 700 }}>B</button>
                    <button style={{ padding: "8px 14px", border: "none", background: ticketAction === "SELL" ? "#dc2626" : "#f8fafc", color: ticketAction === "SELL" ? "#fff" : "#0f172a", fontWeight: 700 }}>S</button>
                  </div>
                  <button style={{ padding: "8px 16px", borderRadius: 10, border: ticketMode === "CALL" ? "1px solid #2563eb" : "1px solid #cbd5e1", background: ticketMode === "CALL" ? "#eef4ff" : "#fff", color: ticketMode === "CALL" ? "#2563eb" : "#0f172a", fontWeight: 700 }}>CALL</button>
                  <button style={{ padding: "8px 16px", borderRadius: 10, border: ticketMode === "PUT" ? "1px solid #dc2626" : "1px solid #cbd5e1", background: ticketMode === "PUT" ? "#fff1f2" : "#fff", color: ticketMode === "PUT" ? "#dc2626" : "#0f172a", fontWeight: 700 }}>PUT</button>
                  <div style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid #cbd5e1", minWidth: 86, textAlign: "center" }}>ATM</div>
                  <div style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid #cbd5e1", minWidth: 70, textAlign: "center" }}>1 Lots</div>
                  <div style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid #cbd5e1", minWidth: 82, textAlign: "center" }}>LIMIT</div>
                  <button onClick={selectSignalMarker} style={{ padding: "8px 14px", borderRadius: 10, border: "1px solid #cbd5e1", minWidth: 110, background: "#fff", cursor: "pointer" }}>
                    {fmt(currentTicket)}
                  </button>
                </div>
                <button
                  onClick={() => onBuySignal?.(symbol)}
                  disabled={marketStatus?.open === false}
                  style={{ border: "none", borderRadius: 10, background: ticketAction === "BUY" ? "#0f9d58" : "#dc2626", color: "#fff", padding: "12px 22px", fontWeight: 800, minWidth: 176, cursor: marketStatus?.open === false ? "not-allowed" : "pointer", opacity: marketStatus?.open === false ? 0.75 : 1 }}
                >
                  {ticketAction} @ {fmt(currentTicket)}
                </button>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", color: "#64748b", fontSize: 13, marginTop: 10 }}>
                <span>Data source: {data.source || "unknown"} | {data.connected ? "live connected" : "waiting for broker ticks"} | Drag to pan | Wheel to zoom</span>
                <span>Updated: {data.lastUpdated ? new Date(data.lastUpdated).toLocaleTimeString() : "-"}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  const [trades, setTrades] = useState([]);
  const [stats, setStats] = useState({});
  const [signals, setSignals] = useState([]);
  const [feedStatus, setFeedStatus] = useState(null);
  const [marketStatus, setMarketStatus] = useState(null);
  const [actioningTradeId, setActioningTradeId] = useState(null);
  const [buyingSymbol, setBuyingSymbol] = useState("");
  const [selectedTradeDate, setSelectedTradeDate] = useState("");
  const [dayPerformanceFilter, setDayPerformanceFilter] = useState("all");
  const [tradeStatusTab, setTradeStatusTab] = useState("all");
  const [resettingToday, setResettingToday] = useState(false);

  const loadData = () => {
    fetchJson(`${API_BASE_URL}/trades`).then(setTrades).catch(() => {});
    fetchJson(`${API_BASE_URL}/stats`).then(setStats).catch(() => {});
    fetchJson(`${API_BASE_URL}/signals/latest?refresh=true`)
      .then((payload) => setSignals(Array.isArray(payload) ? payload : []))
      .catch(() => {
        fetchJson(`${API_BASE_URL}/signal`)
          .then((payload) => setSignals(Array.isArray(payload) ? payload : payload?.results || []))
          .catch(() => {});
      });
    fetchJson(`${API_BASE_URL}/market/feed-status`).then(setFeedStatus).catch(() => {});
    fetchJson(`${API_BASE_URL}/market/status`).then(setMarketStatus).catch(() => {});
  };

  const resetTodayTrades = async () => {
    if (!window.confirm("Are you sure you want to reset all trades for today and start fresh?")) return;
    try {
      setResettingToday(true);
      await fetchJson(`${API_BASE_URL}/trades/reset-today`, { method: "POST" });
      loadData();
      alert("Today's trades cleared. Automated trading is refreshed and ready!");
    } catch (error) {
      alert(`Reset failed: ${error.message}`);
    } finally {
      setResettingToday(false);
    }
  };

  const updateTradeAction = async (tradeId, action) => {
    try {
      setActioningTradeId(tradeId);
      await fetchJson(`${API_BASE_URL}/trades/${tradeId}/${action}`, { method: "POST" });
      loadData();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setActioningTradeId(null);
    }
  };

  const buySignalNow = async (symbol) => {
    const normalizedSymbol = String(symbol || "").toLowerCase();
    if (!normalizedSymbol) return;

    try {
      setBuyingSymbol(normalizedSymbol);
      await fetchJson(`${API_BASE_URL}/signals/${normalizedSymbol}/buy`, { method: "POST" });
      loadData();
    } catch (error) {
      window.alert(error.message);
    } finally {
      setBuyingSymbol("");
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 4000);
    return () => clearInterval(interval);
  }, []);

  const signalByKey = Object.fromEntries(signals.map((signal) => [String(signal.symbol || "").toLowerCase(), signal]));
  const dateOptions = useMemo(() => [...new Set(trades.map((trade) => formatDateKey(trade.createdAt)).filter(Boolean))].sort((a, b) => b.localeCompare(a)), [trades]);
  const daySummaries = useMemo(() => {
    const grouped = trades.reduce((acc, trade) => {
      const dateKey = formatDateKey(trade.createdAt);
      if (!dateKey) return acc;
      if (!acc[dateKey]) {
        acc[dateKey] = { dateKey, total: 0, open: 0, closed: 0, wins: 0, losses: 0, openPnl: 0, closedPnl: 0, totalPnl: 0 };
      }
      const summary = acc[dateKey];
      const closedPnl = trade.result === "OPEN" ? 0 : getTradeClosedPnl(trade);
      const openPnl = trade.result === "OPEN" ? getTradeOpenPnl(trade) : 0;
      summary.total += 1;
      summary.open += trade.result === "OPEN" ? 1 : 0;
      summary.closed += trade.result === "OPEN" ? 0 : 1;
      summary.wins += trade.result === "WIN" ? 1 : 0;
      summary.losses += trade.result === "LOSS" ? 1 : 0;
      summary.openPnl = Number((summary.openPnl + openPnl).toFixed(2));
      summary.closedPnl = Number((summary.closedPnl + closedPnl).toFixed(2));
      summary.totalPnl = Number((summary.totalPnl + closedPnl + openPnl).toFixed(2));
      return acc;
    }, {});

    return Object.values(grouped).sort((a, b) => b.dateKey.localeCompare(a.dateKey));
  }, [trades]);
  const filteredDaySummaries = useMemo(() => daySummaries.filter((summary) => {
    if (selectedTradeDate && summary.dateKey !== selectedTradeDate) return false;
    if (dayPerformanceFilter === "profit") return summary.totalPnl > 0;
    if (dayPerformanceFilter === "loss") return summary.totalPnl < 0;
    return true;
  }), [dayPerformanceFilter, daySummaries, selectedTradeDate]);
  const filteredTrades = useMemo(() => trades.filter((trade) => {
    if (selectedTradeDate && formatDateKey(trade.createdAt) !== selectedTradeDate) return false;
    if (tradeStatusTab === "open") return trade.result === "OPEN";
    if (tradeStatusTab === "closed") return trade.result !== "OPEN";
    if (tradeStatusTab === "wins") return trade.result === "WIN";
    if (tradeStatusTab === "losses") return trade.result === "LOSS";
    return true;
  }), [selectedTradeDate, tradeStatusTab, trades]);
  const groupedTrades = useMemo(() => {
    const grouped = filteredTrades.reduce((acc, trade) => {
      const dateKey = formatDateKey(trade.createdAt) || "unknown";
      if (!acc[dateKey]) acc[dateKey] = [];
      acc[dateKey].push(trade);
      return acc;
    }, {});

    return Object.entries(grouped)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([dateKey, items]) => ({
        dateKey,
        trades: items,
        summary: daySummaries.find((entry) => entry.dateKey === dateKey) || null
      }));
  }, [daySummaries, filteredTrades]);
  const tradeFilterStats = useMemo(() => filteredTrades.reduce((acc, trade) => {
    acc.total += 1;
    acc.open += trade.result === "OPEN" ? 1 : 0;
    acc.closed += trade.result === "OPEN" ? 0 : 1;
    acc.netPnl = Number((acc.netPnl + getTradeNetPnl(trade)).toFixed(2));
    return acc;
  }, { total: 0, open: 0, closed: 0, netPnl: 0 }), [filteredTrades]);
  const tradeStatusTabs = [
    { key: "all", label: "All Trades", count: trades.length },
    { key: "open", label: "Open", count: trades.filter((trade) => trade.result === "OPEN").length },
    { key: "closed", label: "Closed", count: trades.filter((trade) => trade.result !== "OPEN").length },
    { key: "wins", label: "Profit Trades", count: trades.filter((trade) => trade.result === "WIN").length },
    { key: "losses", label: "Loss Trades", count: trades.filter((trade) => trade.result === "LOSS").length }
  ];
  const dayFilterTabs = [
    { key: "all", label: "All Days", count: daySummaries.length },
    { key: "profit", label: "Profit Days", count: daySummaries.filter((day) => day.totalPnl > 0).length },
    { key: "loss", label: "Loss Days", count: daySummaries.filter((day) => day.totalPnl < 0).length }
  ];

  return (
    <div style={{ padding: 20, fontFamily: "\"Segoe UI\", Arial, sans-serif", background: "#f5f7fb", minHeight: "100vh", color: "#0f172a" }}>
      <h1 style={{ marginTop: 0 }}>AI Trading Dashboard</h1>
      {marketStatus && (
        <div style={{ background: marketStatus.open ? "#ecfdf3" : "#fff7ed", color: marketStatus.open ? "#166534" : "#9a3412", border: `1px solid ${marketStatus.open ? "#bbf7d0" : "#fed7aa"}`, borderRadius: 14, padding: 14, marginBottom: 12, fontWeight: 700, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
          <div>Market {marketStatus.open ? "Open" : "Closed"} | Time: {marketStatus.marketTime} | Window: {marketStatus.marketOpen} - {marketStatus.marketClose} ({marketStatus.timezone})</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div>Today Trades: {marketStatus.todayTradesCount ?? 0} / {marketStatus.maxDailyTrades ?? 5}</div>
            <button
              onClick={resetTodayTrades}
              disabled={resettingToday}
              style={{
                background: "#ef4444",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "6px 12px",
                fontWeight: 700,
                fontSize: 12,
                cursor: "pointer"
              }}
            >
              {resettingToday ? "Resetting..." : "🔄 Reset Today"}
            </button>
          </div>
        </div>
      )}
      {marketStatus && marketStatus.maxDailyTradesReached && (
        <div style={{ background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 14, padding: 14, marginBottom: 16, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span>🛑 Daily Trade Cap Reached ({marketStatus.todayTradesCount} / {marketStatus.maxDailyTrades} trades). Automated trading is safely paused for today to lock in performance.</span>
          <span style={{ fontSize: 12, background: "#fee2e2", padding: "4px 10px", borderRadius: 999, border: "1px solid #fca5a5" }}>Locked Until Tomorrow 09:15 AM</span>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 18 }}>
        <div style={{ background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #e2e8f0" }}><div style={{ color: "#64748b", marginBottom: 6 }}>Total Trades</div><div style={{ fontSize: 30, fontWeight: 700 }}>{stats.total ?? 0}</div></div>
        <div style={{ background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #e2e8f0" }}><div style={{ color: "#64748b", marginBottom: 6 }}>Wins / Losses</div><div style={{ fontSize: 30, fontWeight: 700 }}>{stats.wins ?? 0} / {stats.losses ?? 0}</div></div>
        <div style={{ background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #e2e8f0" }}><div style={{ color: "#64748b", marginBottom: 6 }}>Win Rate</div><div style={{ fontSize: 30, fontWeight: 700 }}>{stats.winRate ?? 0}%</div></div>
        <div style={{ background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #e2e8f0" }}><div style={{ color: "#64748b", marginBottom: 6 }}>Closed P&amp;L</div><div style={{ fontSize: 30, fontWeight: 700 }}>Rs. {fmt(stats.profit)}</div></div>
        <div style={{ background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #e2e8f0" }}><div style={{ color: "#64748b", marginBottom: 6 }}>Open P&amp;L</div><div style={{ fontSize: 30, fontWeight: 700, color: (stats.openProfit ?? 0) >= 0 ? "#0f9d58" : "#dc2626" }}>Rs. {fmt(stats.openProfit)}</div></div>
        <div style={{ background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #e2e8f0" }}><div style={{ color: "#64748b", marginBottom: 6 }}>Total P&amp;L</div><div style={{ fontSize: 30, fontWeight: 700, color: (stats.totalProfitWithOpen ?? 0) >= 0 ? "#0f9d58" : "#dc2626" }}>Rs. {fmt(stats.totalProfitWithOpen)}</div></div>
      </div>

      {feedStatus && (
        <div style={{ background: "#fff", borderRadius: 14, padding: 16, border: "1px solid #e2e8f0", marginBottom: 20, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          <div><b>Feed Transport:</b> {feedStatus.transport}</div>
          <div><b>Websocket:</b> {feedStatus.websocketConnected ? "connected" : "not connected"}</div>
          <div><b>Ticks:</b> {feedStatus.websocketTicks ?? 0}</div>
          <div><b>Quote Polls:</b> {feedStatus.pollCount ?? 0}</div>
          <div><b>Last Tick:</b> {feedStatus.lastTickAt ? new Date(feedStatus.lastTickAt).toLocaleTimeString() : "-"}</div>
          <div><b>Last Error:</b> {feedStatus.lastError || "-"}</div>
        </div>
      )}

      <ChartPanel title="NIFTY Chart" symbol="nifty" signal={signalByKey.nifty} marketStatus={marketStatus} onBuySignal={buySignalNow} />
      <ChartPanel title="BANKNIFTY Chart" symbol="banknifty" signal={signalByKey.banknifty} marketStatus={marketStatus} onBuySignal={buySignalNow} />

      <h2>Latest Signals</h2>
      {signals.length === 0 && <p>No signal data yet...</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginBottom: 28 }}>
        {signals.map((signal) => {
          const sBias = String(signal?.market_bias || signal?.directional_bias || "").toUpperCase();
          const isUp = sBias === "BULLISH" || signal.signal === "BUY CALL" || String(signal.trade || "").endsWith("CE");
          const isDown = sBias === "BEARISH" || signal.signal === "BUY PUT" || String(signal.trade || "").endsWith("PE");
          const biasColor = isUp ? "#0f9d58" : isDown ? "#dc2626" : "#64748b";
          const biasText = isUp ? "▲ UP (Bullish)" : isDown ? "▼ DOWN (Bearish)" : "◆ NEUTRAL";

          return (
          <div key={signal.symbol} style={{ border: "1px solid #d7dce5", borderRadius: 14, padding: 18, background: "#fff", boxShadow: "0 4px 12px rgba(15, 23, 42, 0.04)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 20 }}>{signal.symbol}</h3>
              <span style={{ padding: "4px 10px", borderRadius: 999, background: `${biasColor}15`, color: biasColor, fontWeight: 800, fontSize: 12, border: `1px solid ${biasColor}30` }}>
                {biasText}
              </span>
            </div>
            <p style={{ margin: "6px 0" }}><b>Signal:</b> <span style={{ fontWeight: 800, color: signal.signal === "BUY CALL" ? "#0f9d58" : signal.signal === "BUY PUT" ? "#dc2626" : "#475569" }}>{signal.signal}</span></p>
            <p style={{ margin: "6px 0" }}><b>Trigger Trade:</b> {signal.trade || "WAIT"}</p>

            {signal.candlestick_pattern && signal.candlestick_pattern !== "NONE" && (
              <div style={{ margin: "10px 0", padding: "8px 12px", borderRadius: 8, background: "#f0fdf4", border: "1px solid #bbf7d0", fontSize: 13 }}>
                <div style={{ fontWeight: 800, color: "#166534" }}>
                  🕯️ Pattern: {signal.candlestick_pattern.replace(/_/g, " ")} {signal.candlestick_strength > 0 && "⭐".repeat(Math.min(signal.candlestick_strength, 5))}
                </div>
                {signal.candlestick_description && (
                  <div style={{ color: "#475569", fontSize: 12, marginTop: 2 }}>{signal.candlestick_description}</div>
                )}
              </div>
            )}

            {signal.target && (
              <div style={{ margin: "10px 0", padding: "10px 12px", borderRadius: 8, background: "#f8fafc", border: "1px solid #e2e8f0", fontSize: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", color: "#065f46", fontWeight: 700 }}>
                  <span>T1 (1:2.2): {fmt(signal.target)}</span>
                  {typeof signal.expected_profit_t1 === "number" && signal.expected_profit_t1 > 0 && (
                    <span style={{ color: "#059669" }}>+Rs. {fmt(signal.expected_profit_t1)}/lot</span>
                  )}
                </div>
                {signal.target_2 && (
                  <div style={{ display: "flex", justifyContent: "space-between", color: "#1e40af", fontWeight: 700, marginTop: 4 }}>
                    <span>T2 Runner (1:3.6): {fmt(signal.target_2)}</span>
                    {typeof signal.expected_profit_t2 === "number" && signal.expected_profit_t2 > 0 && (
                      <span style={{ color: "#2563eb" }}>+Rs. {fmt(signal.expected_profit_t2)}/lot</span>
                    )}
                  </div>
                )}
                {signal.stop_loss && (
                  <div style={{ display: "flex", justifyContent: "space-between", color: "#991b1b", fontWeight: 700, marginTop: 4 }}>
                    <span>SL: {fmt(signal.stop_loss)}</span>
                    {typeof signal.max_risk_rupees === "number" && signal.max_risk_rupees > 0 && (
                      <span style={{ color: "#dc2626" }}>-Rs. {fmt(signal.max_risk_rupees)}/lot</span>
                    )}
                  </div>
                )}
              </div>
            )}

            <p style={{ margin: "4px 0", fontSize: 13 }}><b>Confidence:</b> {signal.confidence ?? "-"}% | <b>Score:</b> {fmt(signal.quality_score)}</p>
            <p style={{ margin: "4px 0", fontSize: 13 }}><b>Buy Readiness:</b> {toNumber(signal.buy_readiness, 0)}% | <b>Sell:</b> {toNumber(signal.sell_readiness, 0)}%</p>
            <p style={{ margin: "4px 0", fontSize: 13 }}><b>Spot Price:</b> ₹{fmt(signal.price)}</p>
            {signal.estimated_option_price && (
              <p style={{ margin: "4px 0", fontSize: 13 }}><b>Est. ATM Option:</b> ₹{fmt(signal.estimated_option_price)}</p>
            )}
            <p style={{ margin: "4px 0", fontSize: 13, color: "#475569" }}><b>Setup Note:</b> {signal.reason || "Conditions checked"}</p>
            <p style={{ margin: "4px 0", fontSize: 13 }}><b>Support / Res:</b> {fmt(signal.support)} / {fmt(signal.resistance)}</p>
            <p style={{ margin: "4px 0", fontSize: 13 }}><b>Liquidity:</b> {signal.liquidity_signal ?? "-"}</p>
            {typeof signal.one_min_candles === "number" && typeof signal.five_min_candles === "number" && (
              <p style={{ margin: "4px 0", fontSize: 12, color: "#64748b" }}><b>Candles:</b> 1m {signal.one_min_candles} | 5m {signal.five_min_candles}</p>
            )}
            {signal.signal === "HOLD" ? (
              <p style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}><b>Status:</b> Scanning for setup — {signal.reason || "Waiting for entry"}</p>
            ) : (
              Array.isArray(signal.failed_checks) && signal.failed_checks.length > 0 && (
                <p style={{ color: "#b45309", fontSize: 13, marginTop: 6 }}><b>Gate Checks:</b> {signal.failed_checks.join(", ")}</p>
              )
            )}
            <button
              onClick={() => buySignalNow(signal.symbol)}
              disabled={buyingSymbol === String(signal.symbol || "").toLowerCase() || signal.signal === "HOLD"}
              style={{
                marginTop: 10,
                border: "none",
                borderRadius: 10,
                padding: "10px 14px",
                background: signal.signal === "HOLD" ? "#94a3b8" : "#0f9d58",
                color: "#fff",
                fontWeight: 700,
                cursor: signal.signal === "HOLD" ? "not-allowed" : "pointer",
                opacity: buyingSymbol === String(signal.symbol || "").toLowerCase() ? 0.7 : 1
              }}
              title={signal.signal === "HOLD" ? "Strategy is currently in HOLD. Bot will execute automatically when entry conditions trigger." : "Execute trade manually"}
            >
              {buyingSymbol === String(signal.symbol || "").toLowerCase()
                ? "Buying..."
                : signal.signal === "HOLD"
                ? "Auto-Scanning (HOLD)"
                : "Buy Now"}
            </button>
          </div>
          );
        })}
      </div>

      <h2>Trade History</h2>
      <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, padding: 16, marginBottom: 18 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>Day-wise Trade Journal</div>
            <div style={{ color: "#64748b", marginTop: 4 }}>Filter by date, review profit days or loss days, and switch between open and closed trades.</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <input type="date" value={selectedTradeDate} onChange={(event) => setSelectedTradeDate(event.target.value)} style={{ border: "1px solid #cbd5e1", borderRadius: 10, padding: "10px 12px", background: "#fff" }} />
            <button onClick={() => setSelectedTradeDate("")} style={{ border: "1px solid #cbd5e1", borderRadius: 10, padding: "10px 12px", background: "#fff", cursor: "pointer" }}>Clear Date</button>
          </div>
        </div>

        {dateOptions.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            {dateOptions.slice(0, 10).map((dateKey) => (
              <button
                key={dateKey}
                onClick={() => setSelectedTradeDate(dateKey === selectedTradeDate ? "" : dateKey)}
                style={{
                  border: selectedTradeDate === dateKey ? "1px solid #0f766e" : "1px solid #cbd5e1",
                  background: selectedTradeDate === dateKey ? "#ccfbf1" : "#fff",
                  color: selectedTradeDate === dateKey ? "#115e59" : "#0f172a",
                  borderRadius: 999,
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontWeight: 600
                }}
              >
                {formatDayLabel(dateKey)}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {dayFilterTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setDayPerformanceFilter(tab.key)}
              style={{
                border: dayPerformanceFilter === tab.key ? "1px solid #1d4ed8" : "1px solid #cbd5e1",
                background: dayPerformanceFilter === tab.key ? "#dbeafe" : "#fff",
                color: dayPerformanceFilter === tab.key ? "#1d4ed8" : "#0f172a",
                borderRadius: 999,
                padding: "8px 12px",
                cursor: "pointer",
                fontWeight: 700
              }}
            >
              {tab.label} ({tab.count})
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {tradeStatusTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setTradeStatusTab(tab.key)}
              style={{
                border: tradeStatusTab === tab.key ? "1px solid #7c3aed" : "1px solid #cbd5e1",
                background: tradeStatusTab === tab.key ? "#ede9fe" : "#fff",
                color: tradeStatusTab === tab.key ? "#6d28d9" : "#0f172a",
                borderRadius: 999,
                padding: "8px 12px",
                cursor: "pointer",
                fontWeight: 700
              }}
            >
              {tab.label} ({tab.count})
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, background: "#f8fafc" }}><div style={{ color: "#64748b", marginBottom: 6 }}>Filtered Trades</div><div style={{ fontSize: 28, fontWeight: 700 }}>{tradeFilterStats.total}</div></div>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, background: "#f8fafc" }}><div style={{ color: "#64748b", marginBottom: 6 }}>Closed Trades</div><div style={{ fontSize: 28, fontWeight: 700 }}>{tradeFilterStats.closed}</div></div>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, background: "#f8fafc" }}><div style={{ color: "#64748b", marginBottom: 6 }}>Open Trades</div><div style={{ fontSize: 28, fontWeight: 700 }}>{tradeFilterStats.open}</div></div>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 14, background: "#f8fafc" }}><div style={{ color: "#64748b", marginBottom: 6 }}>Filtered P&amp;L</div><div style={{ fontSize: 28, fontWeight: 700, color: tradeFilterStats.netPnl >= 0 ? "#0f9d58" : "#dc2626" }}>Rs. {fmt(tradeFilterStats.netPnl)}</div></div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, marginBottom: 20 }}>
        {filteredDaySummaries.map((summary) => (
          <button
            key={summary.dateKey}
            onClick={() => setSelectedTradeDate(summary.dateKey === selectedTradeDate ? "" : summary.dateKey)}
            style={{ textAlign: "left", border: selectedTradeDate === summary.dateKey ? "1px solid #0f766e" : "1px solid #d7dce5", borderRadius: 14, padding: 16, background: "#fff", cursor: "pointer" }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 8 }}>
              <strong>{formatDayLabel(summary.dateKey)}</strong>
              <span style={{ color: summary.totalPnl >= 0 ? "#0f9d58" : "#dc2626", fontWeight: 700 }}>Rs. {fmt(summary.totalPnl)}</span>
            </div>
            <div style={{ color: "#475569", marginBottom: 6 }}>Trades {summary.total} | Closed {summary.closed} | Open {summary.open}</div>
            <div style={{ color: "#475569", marginBottom: 6 }}>Wins {summary.wins} | Losses {summary.losses}</div>
            <div style={{ color: "#64748b" }}>Closed Rs. {fmt(summary.closedPnl)} | Open Rs. {fmt(summary.openPnl)}</div>
          </button>
        ))}
      </div>

      {groupedTrades.length === 0 && <p>No trades found for the selected filters.</p>}
      {groupedTrades.map((group) => (
        <div key={group.dateKey} style={{ marginBottom: 22, background: "#fff", border: "1px solid #dbe3ef", borderRadius: 18, overflow: "hidden", boxShadow: "0 12px 32px rgba(15, 23, 42, 0.06)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "16px 18px", flexWrap: "wrap", background: "linear-gradient(135deg, #f8fafc 0%, #eef6ff 100%)", borderBottom: "1px solid #e2e8f0" }}>
            <div>
              <h3 style={{ margin: 0, marginBottom: 4 }}>{group.dateKey === "unknown" ? "Unknown day" : formatDayLabel(group.dateKey)}</h3>
              <div style={{ color: "#64748b" }}>{group.trades.length} executed trades in this view</div>
            </div>
            {group.summary && <div style={{ color: "#475569", fontWeight: 700 }}>Closed {group.summary.closed} | Open {group.summary.open} | Day P&amp;L <span style={{ color: group.summary.totalPnl >= 0 ? "#0f9d58" : "#dc2626" }}>Rs. {fmt(group.summary.totalPnl)}</span></div>}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1200 }}>
              <thead>
                <tr style={{ background: "#f8fafc", color: "#475569", textAlign: "left" }}>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Time</th>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Symbol</th>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Trade</th>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Entry / Exit</th>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>1 Lot Value</th>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Risk</th>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Status</th>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Approval</th>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>P&amp;L</th>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Execution</th>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Notes</th>
                  <th style={{ padding: "12px 14px", borderBottom: "1px solid #e2e8f0", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {group.trades.map((trade, index) => {
                  const pending = trade.approvalStatus === "PENDING";
                  const busy = actioningTradeId === trade._id;
                  const tradePnl = getTradeNetPnl(trade);
                  const displayLotValue = getDisplayLotValue(trade);
                  const entryUnitPrice = getEntryUnitPrice(trade);
                  const displayUnitPrice = getDisplayUnitPrice(trade);
                  const optionQuantity = typeof trade.optionQuantity === "number" ? trade.optionQuantity : null;
                  const lotPnl = typeof trade.lotPnl === "number" ? trade.lotPnl : null;
                  const quoteReliability = String(trade.quote_reliability || trade.quote_source || "").trim().toLowerCase();
                  const quoteStale = quoteReliability === "stale_quote" || quoteReliability === "rejected_no_quote";
                  const noLiveQuote = trade.result === "OPEN" && quoteStale;
                  const pnlPositive = tradePnl >= 0;
                  const lotPnlPositive = (lotPnl ?? 0) >= 0;
                  const rowBackground = index % 2 === 0 ? "#ffffff" : "#fbfdff";
                  return (
                    <tr key={trade._id} style={{ background: rowBackground, verticalAlign: "top" }}>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7", whiteSpace: "nowrap" }}>
                        <div style={{ fontWeight: 700 }}>{fmtExecutionTime(trade.createdAt)}</div>
                        <div style={{ color: "#64748b", fontSize: 12 }}>{new Date(trade.createdAt).toLocaleDateString()}</div>
                      </td>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7" }}>
                        <div style={{ fontWeight: 700 }}>{trade.derivedSymbol || trade.symbol}</div>
                        <div style={{ color: "#64748b", fontSize: 12 }}>{trade.trade || "-"}</div>
                      </td>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7" }}>
                        <div style={{ display: "inline-flex", padding: "6px 10px", borderRadius: 999, background: trade.signal === "BUY CALL" ? "#dcfce7" : trade.signal === "BUY PUT" ? "#fee2e2" : "#e2e8f0", color: trade.signal === "BUY CALL" ? "#166534" : trade.signal === "BUY PUT" ? "#991b1b" : "#334155", fontWeight: 700 }}>
                          {trade.signal}
                        </div>
                        <div style={{ color: "#64748b", fontSize: 12, marginTop: 8 }}>Confidence {trade.confidence ?? "-"} | RR {trade.risk_reward ?? "-"}</div>
                      </td>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7" }}>
                        <div>Entry: <b>{fmt(trade.price)}</b></div>
                        <div style={{ color: "#475569", marginTop: 4 }}>Exit: <b>{typeof trade.exit_price === "number" ? fmt(trade.exit_price) : "-"}</b></div>
                        <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>Option: {trade.estimated_option_price ?? "-"}</div>
                      </td>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7", minWidth: 180 }}>
                        {noLiveQuote ? (
                          <>
                            <div style={{ color: "#b45309", fontWeight: 700 }}>No live quote</div>
                            <div style={{ color: "#92400e", fontSize: 12, marginTop: 6 }}>
                              Premium values were not reliable for this trade, so P&amp;L is not counted.
                            </div>
                            <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>
                              Entry premium: {typeof entryUnitPrice === "number" ? `Rs. ${fmt(entryUnitPrice)}` : "-"}
                            </div>
                            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>
                              Exit premium: {typeof displayUnitPrice === "number" ? `Rs. ${fmt(displayUnitPrice)}` : "-"}
                            </div>
                          </>
                        ) : entryUnitPrice !== null && optionQuantity !== null ? (
                          <>
                            <div>Buy: <b>{typeof trade.entryLotAmount === "number" ? `Rs. ${fmt(trade.entryLotAmount)}` : "-"}</b></div>
                            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>
                              {fmt(entryUnitPrice)} x {optionQuantity} = {typeof trade.entryLotAmount === "number" ? `Rs. ${fmt(trade.entryLotAmount)}` : "-"}
                            </div>
                            <div style={{ color: "#475569", marginTop: 8 }}>{trade.result === "OPEN" ? "Now" : "Sell"}: <b>{typeof displayLotValue === "number" ? `Rs. ${fmt(displayLotValue)}` : "-"}</b></div>
                            {displayUnitPrice !== null && typeof displayLotValue === "number" && (
                              <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>
                                {fmt(displayUnitPrice)} x {optionQuantity} = Rs. {fmt(displayLotValue)}
                              </div>
                            )}
                            <div style={{ color: lotPnlPositive ? "#0f9d58" : "#dc2626", fontSize: 12, marginTop: 6, fontWeight: 700 }}>
                              Lot Profit: {typeof lotPnl === "number" ? `Rs. ${fmt(lotPnl)}` : "-"}
                            </div>
                            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>1 Lot = {optionQuantity} shares</div>
                          </>
                        ) : (
                          <>
                            <div style={{ color: "#0f172a", fontWeight: 700 }}>Option buy price unavailable</div>
                            <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>
                              Lot calculation needs the actual option entry price, not the BANKNIFTY spot price.
                            </div>
                            {optionQuantity !== null && <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>Configured quantity: {optionQuantity}</div>}
                          </>
                        )}
                      </td>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7" }}>
                        <div>SL: <b>{trade.stop_loss ?? "-"}</b></div>
                        <div style={{ color: "#475569", marginTop: 4 }}>Target: <b>{trade.target ?? "-"}</b></div>
                        {typeof trade.livePrice === "number" && <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>Live: {fmt(trade.livePrice)}</div>}
                      </td>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7" }}>
                        <div style={{ display: "inline-flex", padding: "6px 10px", borderRadius: 999, background: trade.result === "WIN" ? "#dcfce7" : trade.result === "LOSS" ? "#fee2e2" : trade.result === "OPEN" ? "#dbeafe" : "#e2e8f0", color: trade.result === "WIN" ? "#166534" : trade.result === "LOSS" ? "#991b1b" : trade.result === "OPEN" ? "#1d4ed8" : "#334155", fontWeight: 800 }}>
                          {trade.result}
                        </div>
                        {trade.exit_reason && <div style={{ color: "#64748b", fontSize: 12, marginTop: 8 }}>{trade.exit_reason}</div>}
                      </td>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7" }}>
                        <div style={{ display: "inline-flex", padding: "6px 10px", borderRadius: 999, background: trade.approvalStatus === "APPROVED" || trade.approvalStatus === "NOT_REQUIRED" ? "#ecfdf3" : trade.approvalStatus === "REJECTED" ? "#fff1f2" : "#fff7ed", color: trade.approvalStatus === "APPROVED" || trade.approvalStatus === "NOT_REQUIRED" ? "#166534" : trade.approvalStatus === "REJECTED" ? "#be123c" : "#9a3412", fontWeight: 700 }}>
                          {trade.approvalStatus}
                        </div>
                      </td>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7" }}>
                        {noLiveQuote ? (
                          <div style={{ fontWeight: 800, color: "#b45309", fontSize: 16 }}>
                            No live quote
                          </div>
                        ) : (
                          <div style={{ fontWeight: 800, color: pnlPositive ? "#0f9d58" : "#dc2626", fontSize: 16 }}>
                            Rs. {fmt(tradePnl)}
                          </div>
                        )}
                        {typeof trade.current_pnl === "number" && (
                          <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>
                            Live {fmt(trade.current_pnl)} ({trade.current_pnl_percent ?? 0}%)
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7" }}>
                        <div style={{ fontWeight: 700 }}>{trade.executionMode ?? "not executed"}</div>
                        {typeof trade.simulatedAmount === "number" && <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>Amount Rs. {fmt(trade.simulatedAmount)}</div>}
                      </td>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7", color: "#475569", minWidth: 220 }}>
                        <div>Q Score: <b>{trade.quality_score ?? "-"}</b></div>
                        <div style={{ marginTop: 6 }}>Quote: <b>{trade.quote_source ?? (trade.currentQuoteAvailable ? "live_quote" : "rejected_no_quote")}</b></div>
                        {quoteStale && <div style={{ color: "#b45309", fontSize: 12, marginTop: 4 }}>P&amp;L excluded</div>}
                        {Array.isArray(trade.reasons) && trade.reasons.length > 0 && (
                          <div style={{ color: "#64748b", fontSize: 12, marginTop: 6 }}>{trade.reasons.slice(0, 2).join(" | ")}</div>
                        )}
                      </td>
                      <td style={{ padding: "14px", borderBottom: "1px solid #eef2f7", minWidth: 150 }}>
                        {pending ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <button onClick={() => updateTradeAction(trade._id, "approve")} disabled={busy} style={{ border: "none", borderRadius: 10, background: "#0f9d58", color: "#fff", padding: "9px 12px", fontWeight: 700, cursor: "pointer" }}>
                              {busy ? "Processing..." : "Approve"}
                            </button>
                            <button onClick={() => updateTradeAction(trade._id, "reject")} disabled={busy} style={{ border: "1px solid #fecdd3", borderRadius: 10, background: "#fff1f2", color: "#be123c", padding: "9px 12px", fontWeight: 700, cursor: "pointer" }}>
                              Reject
                            </button>
                          </div>
                        ) : trade.result === "OPEN" ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            <button onClick={() => updateTradeAction(trade._id, "sell")} disabled={busy} style={{ border: "none", borderRadius: 10, background: "#dc2626", color: "#fff", padding: "9px 12px", fontWeight: 700, cursor: "pointer" }}>
                              {busy ? "Selling..." : "Sell Now"}
                            </button>
                            <div style={{ color: "#64748b", fontSize: 12 }}>Exit before stop loss or target</div>
                          </div>
                        ) : (
                          <div style={{ color: "#94a3b8", fontSize: 13 }}>No action</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

export default App;
