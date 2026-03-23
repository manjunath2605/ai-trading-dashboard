from flask import Flask, jsonify, request
import yfinance as yf
import pandas as pd
import datetime
import os
import json
from urllib import request as urllib_request, error
from zoneinfo import ZoneInfo

app = Flask(__name__)

MARKET_TIMEZONE = ZoneInfo(os.getenv("MARKET_TIMEZONE", "Asia/Kolkata"))
MARKET_OPEN_TIME = datetime.time.fromisoformat(os.getenv("MARKET_OPEN_TIME", "09:15"))
MARKET_CLOSE_TIME = datetime.time.fromisoformat(os.getenv("MARKET_CLOSE_TIME", "15:30"))
MARKET_ENTRY_START_TIME = datetime.time.fromisoformat(os.getenv("MARKET_ENTRY_START_TIME", "09:45"))
NO_TRADE_START_TIME = datetime.time.fromisoformat(os.getenv("NO_TRADE_START_TIME", "12:00"))
NO_TRADE_END_TIME = datetime.time.fromisoformat(os.getenv("NO_TRADE_END_TIME", "13:15"))
BACKEND_MARKET_URL = (os.getenv("BACKEND_MARKET_URL", "http://127.0.0.1:4000")).rstrip("/")
MIN_BACKEND_ANALYSIS_CANDLES = int(os.getenv("MIN_BACKEND_ANALYSIS_CANDLES", "60"))

# ================================
# 📊 INDICATORS
# ================================

def calculate_rsi(close_prices, period=14):
    delta = close_prices.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = -delta.clip(upper=0).rolling(period).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))


def calculate_atr(high_prices, low_prices, close_prices, period=14):
    high_low = high_prices - low_prices
    high_close = (high_prices - close_prices.shift()).abs()
    low_close = (low_prices - close_prices.shift()).abs()
    tr = pd.concat([high_low, high_close, low_close], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def calculate_ema_slope(series, lookback=3):
    if len(series.index) <= lookback:
        return 0
    return series.iloc[-1] - series.iloc[-1 - lookback]


def resample_ohlcv(df, rule="1min"):
    if df.empty:
        return df

    resampled = pd.DataFrame({
        "Open": df["Open"].resample(rule).first(),
        "High": df["High"].resample(rule).max(),
        "Low": df["Low"].resample(rule).min(),
        "Close": df["Close"].resample(rule).last(),
        "Volume": df["Volume"].resample(rule).sum(),
    })
    return resampled.dropna(subset=["Open", "High", "Low", "Close"])


def get_market_config(symbol):
    normalized = (symbol or "").lower()
    if normalized == "banknifty":
        return "^NSEBANK", "BANKNIFTY"
    return "^NSEI", "NIFTY"


def load_backend_market_data(symbol):
    normalized = (symbol or "").lower()
    if normalized not in {"nifty", "banknifty"}:
        return pd.DataFrame()

    try:
        with urllib_request.urlopen(f"{BACKEND_MARKET_URL}/market/live/{normalized}", timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (error.URLError, TimeoutError, ValueError, json.JSONDecodeError):
        return pd.DataFrame()

    candles = payload.get("candles") or []
    if not candles:
        return pd.DataFrame()

    df = pd.DataFrame(candles)
    required_columns = ["time", "open", "high", "low", "close", "volume"]
    if any(column not in df.columns for column in required_columns):
        return pd.DataFrame()

    df = df.rename(columns={
        "open": "Open",
        "high": "High",
        "low": "Low",
        "close": "Close",
        "volume": "Volume"
    })
    df["time"] = pd.to_datetime(df["time"], errors="coerce")
    df = df.dropna(subset=["time"])
    df = df.set_index("time").sort_index()
    df = df[["Open", "High", "Low", "Close", "Volume"]].apply(pd.to_numeric, errors="coerce")
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    return df


def load_market_data(symbol, period="5d", interval="1m", prefer_backend=True):
    ticker, name = get_market_config(symbol)
    backend_df = load_backend_market_data(symbol) if prefer_backend else pd.DataFrame()
    if not backend_df.empty and len(backend_df.index) >= MIN_BACKEND_ANALYSIS_CANDLES:
        return backend_df, ticker, name

    df = yf.download(ticker, period=period, interval=interval)

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    if df.empty and not backend_df.empty:
        return backend_df, ticker, name

    if df.empty:
        return df, ticker, name

    df = df.loc[:, ~df.columns.duplicated()].copy()

    required_columns = ["Open", "High", "Low", "Close", "Volume"]
    missing_columns = [column for column in required_columns if column not in df.columns]
    if missing_columns:
        return pd.DataFrame(columns=required_columns), ticker, name

    df = df[required_columns].copy()
    df = df.apply(pd.to_numeric, errors="coerce")
    df = df.dropna(subset=["Open", "High", "Low", "Close"])

    return df, ticker, name


def build_hold_response(name, ticker, price=None, reason="HOLD"):
    response = {
        "symbol": name,
        "ticker": ticker,
        "signal": "HOLD",
        "trade": "WAIT",
        "confidence": 50,
        "reason": reason,
        "buy_score": 0,
        "sell_score": 0,
        "buy_readiness": 0,
        "sell_readiness": 0,
        "trigger_threshold": 10,
        "failed_checks": [],
    }
    if price is not None:
        response["price"] = float(price)
    return response


# ================================
# 🚀 MAIN ANALYSIS
# ================================

@app.route("/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/candles/<symbol>")
def candles(symbol):
    prefer_backend = request.args.get("prefer_backend", "true").lower() != "false"
    limit = int(request.args.get("limit", "120"))
    limit = max(1, min(limit, 500))
    df, ticker, name = load_market_data(symbol, prefer_backend=prefer_backend)

    if df.empty:
        return jsonify({
            "symbol": name,
            "ticker": ticker,
            "candles": []
        })

    candles_data = []
    for idx, row in df.tail(limit).iterrows():
        timestamp = idx.isoformat() if hasattr(idx, "isoformat") else str(idx)
        candles_data.append({
            "time": timestamp,
            "open": float(row["Open"]),
            "high": float(row["High"]),
            "low": float(row["Low"]),
            "close": float(row["Close"]),
            "volume": float(row.get("Volume", 0))
        })

    return jsonify({
        "symbol": name,
        "ticker": ticker,
        "candles": candles_data
    })


@app.route("/analyze/<symbol>")
def analyze(symbol):
    df, ticker, name = load_market_data(symbol)

    if not df.empty and getattr(df.index, "tz", None) is None:
        df.index = df.index.tz_localize("UTC")
    if not df.empty:
        df.index = df.index.tz_convert(MARKET_TIMEZONE)
        df = resample_ohlcv(df, "1min")
    trend_df = resample_ohlcv(df, "5min") if not df.empty else df

    latest_price = float(df['Close'].iloc[-1]) if not df.empty else None
    preliminary_support = None
    preliminary_resistance = None
    if not df.empty and len(df.index) >= 20:
        preliminary_support = float(df['Low'].rolling(20).min().iloc[-1])
        preliminary_resistance = float(df['High'].rolling(20).max().iloc[-1])

    if df.empty or len(df.index) < 120 or trend_df.empty or len(trend_df.index) < 24:
        response = build_hold_response(name, ticker, price=latest_price, reason="Market data not ready")
        failed_checks = []
        if df.empty:
            failed_checks.append("no 1m candles available")
        elif len(df.index) < 120:
            failed_checks.append(f"1m candles low ({len(df.index)}/120)")
        if trend_df.empty:
            failed_checks.append("no 5m candles available")
        elif len(trend_df.index) < 24:
            failed_checks.append(f"5m candles low ({len(trend_df.index)}/24)")
        if not df.empty and len(df.index) < MIN_BACKEND_ANALYSIS_CANDLES:
            failed_checks.append("historical fallback unavailable")
        response.update({
            "support": preliminary_support,
            "resistance": preliminary_resistance,
            "one_min_candles": int(len(df.index)) if not df.empty else 0,
            "five_min_candles": int(len(trend_df.index)) if not trend_df.empty else 0,
            "failed_checks": failed_checks,
        })
        return jsonify(response)

    # Indicators
    df['RSI'] = calculate_rsi(df['Close'])
    df['EMA20'] = df['Close'].ewm(span=20).mean()
    df['EMA50'] = df['Close'].ewm(span=50).mean()
    df['EMA200'] = df['Close'].ewm(span=200).mean()
    df['ATR'] = calculate_atr(df['High'], df['Low'], df['Close'])
    trend_df['EMA20'] = trend_df['Close'].ewm(span=20).mean()
    trend_df['EMA50'] = trend_df['Close'].ewm(span=50).mean()
    trend_df['EMA200'] = trend_df['Close'].ewm(span=200).mean()
    trend_df['RSI'] = calculate_rsi(trend_df['Close'])

    df = df.dropna()
    trend_df = trend_df.dropna()

    if df.empty or len(df.index) < 60 or trend_df.empty or len(trend_df.index) < 12:
        latest_price = float(df['Close'].iloc[-1]) if not df.empty else latest_price
        response = build_hold_response(name, ticker, price=latest_price, reason="Not enough market data after indicators")
        failed_checks = []
        if df.empty:
            failed_checks.append("indicator input candles missing")
        elif len(df.index) < 60:
            failed_checks.append(f"post-indicator 1m candles low ({len(df.index)}/60)")
        if trend_df.empty:
            failed_checks.append("post-indicator 5m candles missing")
        elif len(trend_df.index) < 12:
            failed_checks.append(f"post-indicator 5m candles low ({len(trend_df.index)}/12)")
        response.update({
            "support": float(df['Low'].rolling(20).min().iloc[-1]) if not df.empty and len(df.index) >= 20 else preliminary_support,
            "resistance": float(df['High'].rolling(20).max().iloc[-1]) if not df.empty and len(df.index) >= 20 else preliminary_resistance,
            "one_min_candles": int(len(df.index)) if not df.empty else 0,
            "five_min_candles": int(len(trend_df.index)) if not trend_df.empty else 0,
            "failed_checks": failed_checks,
        })
        return jsonify(response)

    price = df['Close'].iloc[-1]
    rsi = df['RSI'].iloc[-1]
    ema20 = df['EMA20'].iloc[-1]
    ema50 = df['EMA50'].iloc[-1]
    ema200 = df['EMA200'].iloc[-1]
    atr = df['ATR'].iloc[-1]
    trend_ema20 = trend_df['EMA20'].iloc[-1]
    trend_ema50 = trend_df['EMA50'].iloc[-1]
    trend_ema200 = trend_df['EMA200'].iloc[-1]
    trend_rsi = trend_df['RSI'].iloc[-1]
    trend_ema20_slope = calculate_ema_slope(trend_df['EMA20'])

    # ================================
    # 🕒 TIME FILTER
    # ================================
    now = datetime.datetime.now(MARKET_TIMEZONE).time().replace(tzinfo=None)
    if not (MARKET_OPEN_TIME <= now <= MARKET_CLOSE_TIME):
        response = build_hold_response(name, ticker, price=price, reason="Outside trading hours")
        response.update({
            "reason": "Outside trading hours",
            "market_time": now.strftime("%H:%M:%S"),
            "market_open": MARKET_OPEN_TIME.strftime("%H:%M"),
            "market_close": MARKET_CLOSE_TIME.strftime("%H:%M"),
            "timezone": str(MARKET_TIMEZONE)
        })
        return jsonify(response)
    if now < MARKET_ENTRY_START_TIME:
        return jsonify(build_hold_response(name, ticker, price=price, reason="Waiting for post-open confirmation"))
    if NO_TRADE_START_TIME <= now <= NO_TRADE_END_TIME:
        return jsonify(build_hold_response(name, ticker, price=price, reason="No-trade midday zone"))

    # ================================
    # 📊 SUPPORT / RESISTANCE
    # ================================
    resistance = df['High'].rolling(20).max().iloc[-2]
    support = df['Low'].rolling(20).min().iloc[-2]

    breakout_up = price > resistance and df['Close'].iloc[-2] <= resistance
    breakout_down = price < support and df['Close'].iloc[-2] >= support

    # ================================
    # 📊 VOLUME (STRICT)
    # ================================
    avg_vol = df['Volume'].rolling(20).mean().iloc[-1]
    current_vol = df['Volume'].iloc[-1]
    volume_spike = current_vol >= avg_vol * 1.5 if avg_vol and not pd.isna(avg_vol) else False
    volume_available = bool(current_vol > 0 or avg_vol > 0)

    # ================================
    # 🕯️ CANDLE PATTERNS
    # ================================
    current_open = df['Open'].iloc[-1]
    current_close = df['Close'].iloc[-1]
    previous_open = df['Open'].iloc[-2]
    previous_close = df['Close'].iloc[-2]

    bullish_engulfing = (
        previous_close < previous_open and
        current_close > current_open and
        current_open <= previous_close and
        current_close >= previous_open
    )

    bearish_engulfing = (
        previous_close > previous_open and
        current_close < current_open and
        current_open >= previous_close and
        current_close <= previous_open
    )

    # ================================
    # 📈 TREND + STRENGTH
    # ================================
    trend_up = ema20 > ema50
    trend_down = ema20 < ema50

    trend_strength = abs(ema20 - ema50)
    ema20_slope = calculate_ema_slope(df['EMA20'])
    price_above_long_trend = price > ema200
    price_below_long_trend = price < ema200
    strong_trend_up = price > ema20 > ema50 > ema200 and ema20_slope > 0
    strong_trend_down = price < ema20 < ema50 < ema200 and ema20_slope < 0
    five_minute_trend_up = price > trend_ema20 > trend_ema50 > trend_ema200 and trend_ema20_slope > 0 and trend_rsi >= 55
    five_minute_trend_down = price < trend_ema20 < trend_ema50 < trend_ema200 and trend_ema20_slope < 0 and trend_rsi <= 45

    sideways_market = trend_strength < atr * 0.8 and abs(ema20_slope) < atr * 0.2
    bullish_momentum = price > ema20 and rsi >= 60 and rsi <= 72 and ema20_slope > 0
    bearish_momentum = price < ema20 and rsi <= 40 and rsi >= 28 and ema20_slope < 0
    bullish_volume_confirmation = (not volume_available) or (volume_spike and current_close > current_open)
    bearish_volume_confirmation = (not volume_available) or (volume_spike and current_close < current_open)
    candle_body = abs(current_close - current_open)
    bullish_impulse = current_close > current_open and candle_body >= atr * 0.25
    bearish_impulse = current_close < current_open and candle_body >= atr * 0.25

    # ================================
    # 🧠 SCORING SYSTEM
    # ================================
    buy_score = 0
    sell_score = 0

    if strong_trend_up:
        buy_score += 3
    elif trend_up and price_above_long_trend:
        buy_score += 1
    if five_minute_trend_up:
        buy_score += 4

    if strong_trend_down:
        sell_score += 3
    elif trend_down and price_below_long_trend:
        sell_score += 1
    if five_minute_trend_down:
        sell_score += 4

    if breakout_up:
        buy_score += 3
    if breakout_down:
        sell_score += 3

    if bullish_volume_confirmation:
        buy_score += 2
    if bearish_volume_confirmation:
        sell_score += 2

    if bullish_engulfing:
        buy_score += 2
    if bearish_engulfing:
        sell_score += 2

    if bullish_momentum:
        buy_score += 2
    if bearish_momentum:
        sell_score += 2

    if bullish_impulse:
        buy_score += 1
    if bearish_impulse:
        sell_score += 1

    if sideways_market:
        buy_score = max(0, buy_score - 3)
        sell_score = max(0, sell_score - 3)

    # ================================
    # 🎯 FINAL DECISION (STRICT)
    # ================================
    failed_checks = []
    trigger_threshold = 10
    signal = "HOLD"
    confidence = 50
    buy_readiness = min(100, round((buy_score / trigger_threshold) * 100))
    sell_readiness = min(100, round((sell_score / trigger_threshold) * 100))
    reason = "Waiting for confirmation"

    if not strong_trend_up and not strong_trend_down:
        failed_checks.append("1m trend weak")
    if not five_minute_trend_up and not five_minute_trend_down:
        failed_checks.append("5m trend failed")
    if not breakout_up and not breakout_down:
        failed_checks.append("breakout missing")
    if not bullish_momentum and not bearish_momentum:
        failed_checks.append("RSI weak")
    if volume_available and not volume_spike:
        failed_checks.append("volume confirmation missing")
    if not bullish_impulse and not bearish_impulse:
        failed_checks.append("impulse candle missing")
    if sideways_market:
        failed_checks.append("sideways market")

    if (
        buy_score >= trigger_threshold and
        strong_trend_up and
        five_minute_trend_up and
        bullish_momentum and
        breakout_up and
        bullish_volume_confirmation and
        bullish_impulse
    ):
        signal = "BUY CALL"
        confidence = min(95, 52 + buy_score * 5)
        reason = "Bullish breakout confirmed"

    elif (
        sell_score >= trigger_threshold and
        strong_trend_down and
        five_minute_trend_down and
        bearish_momentum and
        breakout_down and
        bearish_volume_confirmation and
        bearish_impulse
    ):
        signal = "BUY PUT"
        confidence = min(95, 52 + sell_score * 5)
        reason = "Bearish breakdown confirmed"
    elif sideways_market:
        reason = "Sideways market, waiting for breakout"
    elif buy_readiness > sell_readiness:
        reason = "Bullish setup building, waiting for breakout"
    elif sell_readiness > buy_readiness:
        reason = "Bearish setup building, waiting for breakdown"

    # ================================
    # 🎯 STRIKE
    # ================================
    strike = round(price / (100 if name == "BANKNIFTY" else 50)) * (100 if name == "BANKNIFTY" else 50)

    trade = "WAIT"
    if signal == "BUY CALL":
        trade = f"{name} {strike} CE"
    elif signal == "BUY PUT":
        trade = f"{name} {strike} PE"

    # ================================
    # 📉 RISK MANAGEMENT (3R)
    # ================================
    stop_loss = 0
    target = 0

    if signal == "BUY CALL":
        stop_loss = round(price - atr * 1.5, 2)
        target = round(price + atr * 3, 2)

    elif signal == "BUY PUT":
        stop_loss = round(price + atr * 1.5, 2)
        target = round(price - atr * 3, 2)

    # ================================
    # 💰 OPTION PRICE ESTIMATE
    # ================================
    option_price = atr * 0.5

    # ================================
    # 📦 RESPONSE
    # ================================
    return jsonify({
        "symbol": name,
        "ticker": ticker,
        "signal": signal,
        "trade": trade,
        "price": float(price),
        "confidence": confidence,
        "reason": reason,
        "buy_score": buy_score,
        "sell_score": sell_score,
        "buy_readiness": buy_readiness,
        "sell_readiness": sell_readiness,
        "trigger_threshold": trigger_threshold,
        "failed_checks": failed_checks,
        "volume_spike": bool(volume_spike),
        "support": float(support),
        "resistance": float(resistance),
        "stop_loss": stop_loss,
        "target": target,
        "estimated_option_price": round(option_price, 2)
    })


if __name__ == "__main__":
    port = int(os.getenv("AI_ENGINE_PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
