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

function ChartPanel({ title, symbol, signal, marketStatus }) {
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
                    Buy Readiness {signal?.buy_readiness ?? 0}% | Sell Readiness {signal?.sell_readiness ?? 0}%
                  </div>
                  {Array.isArray(signal?.failed_checks) && signal.failed_checks.length > 0 && (
                    <div style={{ color: "#b45309", marginTop: 8, fontSize: 13 }}>
                      Blocked by: {signal.failed_checks.join(" | ")}
                    </div>
                  )}
                  {typeof signal?.one_min_candles === "number" && typeof signal?.five_min_candles === "number" && (
                    <div style={{ color: "#64748b", marginTop: 6, fontSize: 13 }}>
                      Candles ready: 1m {signal.one_min_candles} | 5m {signal.five_min_candles}
                    </div>
                  )}
                </div>
                <button onClick={selectSignalMarker} style={{ padding: "8px 12px", borderRadius: 999, background: signalColor, color: "#fff", fontWeight: 700, minWidth: 112, border: "none", cursor: "pointer" }}>
                  {activeSignal}
                </button>
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
                        {activeSignal} {signal?.trade && signal.trade !== "WAIT" ? `| ${signal.trade}` : ""}
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
                <button style={{ border: "none", borderRadius: 10, background: ticketAction === "BUY" ? "#0f9d58" : "#dc2626", color: "#fff", padding: "12px 22px", fontWeight: 800, minWidth: 176 }}>
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

  const loadData = () => {
    fetchJson(`${API_BASE_URL}/trades`).then(setTrades).catch(() => {});
    fetchJson(`${API_BASE_URL}/stats`).then(setStats).catch(() => {});
    fetchJson(`${API_BASE_URL}/signals/latest?refresh=true`).then((payload) => setSignals(Array.isArray(payload) ? payload : [])).catch(() => {});
    fetchJson(`${API_BASE_URL}/market/feed-status`).then(setFeedStatus).catch(() => {});
    fetchJson(`${API_BASE_URL}/market/status`).then(setMarketStatus).catch(() => {});
  };

  const updateApproval = async (tradeId, action) => {
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

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 4000);
    return () => clearInterval(interval);
  }, []);

  const signalByKey = Object.fromEntries(signals.map((signal) => [String(signal.symbol || "").toLowerCase(), signal]));

  return (
    <div style={{ padding: 20, fontFamily: "\"Segoe UI\", Arial, sans-serif", background: "#f5f7fb", minHeight: "100vh", color: "#0f172a" }}>
      <h1 style={{ marginTop: 0 }}>AI Trading Dashboard</h1>
      {marketStatus && (
        <div style={{ background: marketStatus.open ? "#ecfdf3" : "#fff7ed", color: marketStatus.open ? "#166534" : "#9a3412", border: `1px solid ${marketStatus.open ? "#bbf7d0" : "#fed7aa"}`, borderRadius: 14, padding: 14, marginBottom: 16, fontWeight: 700 }}>
          Market {marketStatus.open ? "Open" : "Closed"} | Time: {marketStatus.marketTime} | Window: {marketStatus.marketOpen} - {marketStatus.marketClose} ({marketStatus.timezone})
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

      <ChartPanel title="NIFTY Chart" symbol="nifty" signal={signalByKey.nifty} marketStatus={marketStatus} />
      <ChartPanel title="BANKNIFTY Chart" symbol="banknifty" signal={signalByKey.banknifty} marketStatus={marketStatus} />

      <h2>Latest Signals</h2>
      {signals.length === 0 && <p>No signal data yet...</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14, marginBottom: 28 }}>
        {signals.map((signal) => (
          <div key={signal.symbol} style={{ border: "1px solid #d7dce5", borderRadius: 12, padding: 16, background: "#fff" }}>
            <h3 style={{ marginTop: 0 }}>{signal.symbol}</h3>
            <p><b>Signal:</b> {signal.signal}</p>
            <p><b>Trigger Trade:</b> {signal.trade || "WAIT"}</p>
            <p><b>Confidence:</b> {signal.confidence ?? "-"}</p>
            <p><b>Buy Readiness:</b> {signal.buy_readiness ?? 0}%</p>
            <p><b>Sell Readiness:</b> {signal.sell_readiness ?? 0}%</p>
            <p><b>Price:</b> {signal.price ?? "-"}</p>
            <p><b>Reason:</b> {signal.reason || "Strategy conditions checked"}</p>
            <p><b>Support:</b> {signal.support ?? "-"}</p>
            <p><b>Resistance:</b> {signal.resistance ?? "-"}</p>
            {typeof signal.one_min_candles === "number" && typeof signal.five_min_candles === "number" && (
              <p><b>Candles Ready:</b> 1m {signal.one_min_candles} | 5m {signal.five_min_candles}</p>
            )}
            {Array.isArray(signal.failed_checks) && signal.failed_checks.length > 0 && (
              <p><b>Blocked Checks:</b> {signal.failed_checks.join(", ")}</p>
            )}
          </div>
        ))}
      </div>

      <h2>Trade History</h2>
      {trades.length === 0 && <p>No trades yet...</p>}
      {trades.map((trade) => {
        const pending = trade.approvalStatus === "PENDING";
        const busy = actioningTradeId === trade._id;
        return (
          <div key={trade._id} style={{ border: "1px solid #d7dce5", padding: 16, marginBottom: 12, borderRadius: 12, background: "#fff" }}>
            <h3 style={{ marginTop: 0 }}>{trade.derivedSymbol || trade.symbol}</h3>
            {trade.derivedSymbol && trade.derivedSymbol !== trade.symbol && (
              <p><b>Stored Symbol:</b> {trade.symbol}</p>
            )}
            <p><b>Signal:</b> {trade.signal}</p>
            <p><b>Trade:</b> {trade.trade}</p>
            <p><b>Entry Price:</b> {trade.price}</p>
            <p><b>Estimated Option Price:</b> {trade.estimated_option_price ?? "-"}</p>
            <p><b>Stop Loss:</b> {trade.stop_loss}</p>
            <p><b>Target:</b> {trade.target}</p>
            <p><b>Confidence:</b> {trade.confidence ?? "-"}</p>
            <p><b>Approval:</b> {trade.approvalStatus}</p>
            <p><b>Status:</b> {trade.result}</p>
            <p><b>Execution Mode:</b> {trade.executionMode ?? "not executed"}</p>
            {typeof trade.livePrice === "number" && <p><b>Current Market Price:</b> {fmt(trade.livePrice)}</p>}
            {typeof trade.current_pnl === "number" && (
              <p>
                <b>Current P&amp;L:</b>{" "}
                <span style={{ color: trade.current_pnl >= 0 ? "#0f9d58" : "#dc2626", fontWeight: 700 }}>
                  Rs. {fmt(trade.current_pnl)} ({trade.current_pnl_percent ?? 0}%)
                </span>
              </p>
            )}
            {typeof trade.simulatedAmount === "number" && <p><b>Test Amount:</b> Rs. {trade.simulatedAmount}</p>}
            {pending && (
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <button onClick={() => updateApproval(trade._id, "approve")} disabled={busy}>{busy ? "Processing..." : "Approve Buy"}</button>
                <button onClick={() => updateApproval(trade._id, "reject")} disabled={busy}>Reject</button>
              </div>
            )}
            <small>{new Date(trade.createdAt).toLocaleString()}</small>
          </div>
        );
      })}
    </div>
  );
}

export default App;
