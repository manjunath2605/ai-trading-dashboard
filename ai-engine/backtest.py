import argparse
import json
from dataclasses import dataclass

import pandas as pd

from app import (
    MARKET_ENTRY_START_TIME,
    MARKET_TIMEZONE,
    NO_TRADE_END_TIME,
    NO_TRADE_START_TIME,
    calculate_atr,
    calculate_ema_slope,
    calculate_rsi,
    load_market_data,
    resample_ohlcv,
)


@dataclass
class BacktestTrade:
    symbol: str
    signal: str
    entry_time: str
    exit_time: str
    entry_price: float
    exit_price: float
    stop_loss: float
    target: float
    pnl: float
    gross_pnl: float
    costs: float
    result: str


def prepare_market_data(symbol: str, period: str, interval: str) -> tuple[pd.DataFrame, str, str]:
    df, ticker, name = load_market_data(symbol, period=period, interval=interval, prefer_backend=False)

    if df.empty:
        return df, ticker, name

    if getattr(df.index, "tz", None) is None:
        df.index = df.index.tz_localize("UTC")

    df.index = df.index.tz_convert(MARKET_TIMEZONE)
    df = resample_ohlcv(df, "1min")
    return df, ticker, name


def build_entry_frame(df: pd.DataFrame) -> pd.DataFrame:
    frame = df.copy()
    frame["RSI"] = calculate_rsi(frame["Close"])
    frame["EMA20"] = frame["Close"].ewm(span=20).mean()
    frame["EMA50"] = frame["Close"].ewm(span=50).mean()
    frame["EMA200"] = frame["Close"].ewm(span=200).mean()
    frame["ATR"] = calculate_atr(frame["High"], frame["Low"], frame["Close"])
    return frame.dropna()


def build_trend_frame(df: pd.DataFrame) -> pd.DataFrame:
    trend = resample_ohlcv(df, "5min").copy()
    trend["EMA20"] = trend["Close"].ewm(span=20).mean()
    trend["EMA50"] = trend["Close"].ewm(span=50).mean()
    trend["EMA200"] = trend["Close"].ewm(span=200).mean()
    trend["RSI"] = calculate_rsi(trend["Close"])
    return trend.dropna()


def generate_signal(snapshot: pd.DataFrame, name: str, ticker: str, strict_mode: bool = False) -> dict:
    if snapshot.empty or len(snapshot.index) < 220:
        return {
            "symbol": name,
            "ticker": ticker,
            "signal": "HOLD",
            "trade": "WAIT",
            "confidence": 50,
            "reason": "Market data not ready",
            "stop_loss": 0,
            "target": 0,
        }

    trend_snapshot = build_trend_frame(snapshot)
    if trend_snapshot.empty or len(trend_snapshot.index) < 20:
        return {
            "symbol": name,
            "ticker": ticker,
            "signal": "HOLD",
            "trade": "WAIT",
            "confidence": 50,
            "reason": "Higher timeframe trend not ready",
            "stop_loss": 0,
            "target": 0,
        }

    bar_time = snapshot.index[-1].time().replace(tzinfo=None)
    if bar_time < MARKET_ENTRY_START_TIME:
        return {
            "symbol": name,
            "ticker": ticker,
            "signal": "HOLD",
            "trade": "WAIT",
            "confidence": 50,
            "reason": "Waiting for post-open confirmation",
            "stop_loss": 0,
            "target": 0,
        }
    if NO_TRADE_START_TIME <= bar_time <= NO_TRADE_END_TIME:
        return {
            "symbol": name,
            "ticker": ticker,
            "signal": "HOLD",
            "trade": "WAIT",
            "confidence": 50,
            "reason": "No-trade midday zone",
            "stop_loss": 0,
            "target": 0,
        }

    price = snapshot["Close"].iloc[-1]
    rsi = snapshot["RSI"].iloc[-1]
    ema20 = snapshot["EMA20"].iloc[-1]
    ema50 = snapshot["EMA50"].iloc[-1]
    ema200 = snapshot["EMA200"].iloc[-1]
    atr = snapshot["ATR"].iloc[-1]
    trend_ema20 = trend_snapshot["EMA20"].iloc[-1]
    trend_ema50 = trend_snapshot["EMA50"].iloc[-1]
    trend_ema200 = trend_snapshot["EMA200"].iloc[-1]
    trend_rsi = trend_snapshot["RSI"].iloc[-1]

    resistance = snapshot["High"].rolling(20).max().iloc[-2]
    support = snapshot["Low"].rolling(20).min().iloc[-2]
    breakout_up = price > resistance and snapshot["Close"].iloc[-2] <= resistance
    breakout_down = price < support and snapshot["Close"].iloc[-2] >= support

    avg_vol = snapshot["Volume"].rolling(20).mean().iloc[-1]
    current_vol = snapshot["Volume"].iloc[-1]
    volume_spike = current_vol >= avg_vol * 1.5 if avg_vol and not pd.isna(avg_vol) else False
    volume_available = bool(current_vol > 0 or avg_vol > 0)

    current_open = snapshot["Open"].iloc[-1]
    current_close = snapshot["Close"].iloc[-1]
    previous_open = snapshot["Open"].iloc[-2]
    previous_close = snapshot["Close"].iloc[-2]

    bullish_engulfing = (
        previous_close < previous_open
        and current_close > current_open
        and current_open <= previous_close
        and current_close >= previous_open
    )
    bearish_engulfing = (
        previous_close > previous_open
        and current_close < current_open
        and current_open >= previous_close
        and current_close <= previous_open
    )

    ema20_slope = calculate_ema_slope(snapshot["EMA20"])
    trend_ema20_slope = calculate_ema_slope(trend_snapshot["EMA20"])
    trend_up = ema20 > ema50
    trend_down = ema20 < ema50
    trend_strength = abs(ema20 - ema50)
    strong_trend_up = price > ema20 > ema50 > ema200 and ema20_slope > 0
    strong_trend_down = price < ema20 < ema50 < ema200 and ema20_slope < 0
    five_minute_trend_up = price > trend_ema20 > trend_ema50 > trend_ema200 and trend_ema20_slope > 0 and trend_rsi >= 55
    five_minute_trend_down = price < trend_ema20 < trend_ema50 < trend_ema200 and trend_ema20_slope < 0 and trend_rsi <= 45

    sideways_market = trend_strength < atr * 0.8 and abs(ema20_slope) < atr * 0.2
    bullish_momentum = price > ema20 and 60 <= rsi <= 72 and ema20_slope > 0
    bearish_momentum = price < ema20 and 28 <= rsi <= 40 and ema20_slope < 0
    bullish_volume_confirmation = (not volume_available) or (volume_spike and current_close > current_open)
    bearish_volume_confirmation = (not volume_available) or (volume_spike and current_close < current_open)
    candle_body = abs(current_close - current_open)
    bullish_impulse = current_close > current_open and candle_body >= atr * 0.25
    bearish_impulse = current_close < current_open and candle_body >= atr * 0.25

    buy_score = 0
    sell_score = 0

    if strong_trend_up:
        buy_score += 3
    elif trend_up and price > ema200:
        buy_score += 1
    if five_minute_trend_up:
        buy_score += 4

    if strong_trend_down:
        sell_score += 3
    elif trend_down and price < ema200:
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

    trigger_threshold = 12 if strict_mode else 10
    signal = "HOLD"
    confidence = 50
    reason = "Waiting for confirmation"

    strict_buy_filter = True
    strict_sell_filter = True
    if strict_mode:
        strict_buy_filter = (
            rsi >= 62
            and trend_rsi >= 58
            and current_close > resistance + atr * 0.1
            and candle_body >= atr * 0.35
        )
        strict_sell_filter = (
            rsi <= 38
            and trend_rsi <= 42
            and current_close < support - atr * 0.1
            and candle_body >= atr * 0.35
        )

    if (
        buy_score >= trigger_threshold
        and strong_trend_up
        and five_minute_trend_up
        and bullish_momentum
        and breakout_up
        and bullish_volume_confirmation
        and bullish_impulse
        and strict_buy_filter
    ):
        signal = "BUY CALL"
        confidence = min(95, 52 + buy_score * 4)
        reason = "Bullish breakout confirmed"
    elif (
        sell_score >= trigger_threshold
        and strong_trend_down
        and five_minute_trend_down
        and bearish_momentum
        and breakout_down
        and bearish_volume_confirmation
        and bearish_impulse
        and strict_sell_filter
    ):
        signal = "BUY PUT"
        confidence = min(95, 52 + sell_score * 4)
        reason = "Bearish breakdown confirmed"
    elif sideways_market:
        reason = "Sideways market, waiting for breakout"
    elif buy_score > sell_score:
        reason = "Bullish setup building, waiting for breakout"
    elif sell_score > buy_score:
        reason = "Bearish setup building, waiting for breakdown"

    strike_step = 100 if name == "BANKNIFTY" else 50
    strike = round(price / strike_step) * strike_step
    trade = "WAIT"
    stop_loss = 0.0
    target = 0.0

    if signal == "BUY CALL":
        trade = f"{name} {strike} CE"
        stop_loss = round(price - atr * 1.5, 2)
        target = round(price + atr * 3, 2)
    elif signal == "BUY PUT":
        trade = f"{name} {strike} PE"
        stop_loss = round(price + atr * 1.5, 2)
        target = round(price - atr * 3, 2)

    return {
        "symbol": name,
        "ticker": ticker,
        "signal": signal,
        "trade": trade,
        "price": float(price),
        "confidence": confidence,
        "reason": reason,
        "stop_loss": stop_loss,
        "target": target,
    }


def run_backtest(
    symbol: str,
    period: str,
    interval: str,
    initial_capital: float,
    strict_mode: bool = False,
    brokerage_per_side: float = 20.0,
    slippage_per_side: float = 2.0,
) -> dict:
    df, ticker, name = prepare_market_data(symbol, period, interval)
    if df.empty or len(df.index) < 260:
        raise RuntimeError(f"Not enough historical data for {symbol}.")

    frame = build_entry_frame(df)
    if frame.empty or len(frame.index) < 260:
        raise RuntimeError(f"Not enough indicator-ready data for {symbol}.")

    trades: list[BacktestTrade] = []
    capital = float(initial_capital)
    equity_curve = [capital]
    position = None
    warmup = 220

    for i in range(warmup, len(frame.index) - 1):
        snapshot = frame.iloc[: i + 1]
        candle = frame.iloc[i]
        next_candle = frame.iloc[i + 1]

        if position is not None:
            exit_price = None
            result = None

            if position["signal"] == "BUY CALL":
                if candle["Low"] <= position["stop_loss"]:
                    exit_price = position["stop_loss"]
                    result = "LOSS"
                elif candle["High"] >= position["target"]:
                    exit_price = position["target"]
                    result = "WIN"
            else:
                if candle["High"] >= position["stop_loss"]:
                    exit_price = position["stop_loss"]
                    result = "LOSS"
                elif candle["Low"] <= position["target"]:
                    exit_price = position["target"]
                    result = "WIN"

            next_day = i + 1 < len(frame.index) and snapshot.index[-1].date() != next_candle.name.date()
            if exit_price is None and next_day:
                exit_price = float(candle["Close"])
                result = "TIME_EXIT"

            if exit_price is not None:
                direction = 1 if position["signal"] == "BUY CALL" else -1
                gross_pnl = round((exit_price - position["entry_price"]) * direction, 2)
                total_costs = round((brokerage_per_side + slippage_per_side) * 2, 2)
                pnl = round(gross_pnl - total_costs, 2)
                capital = round(capital + pnl, 2)
                equity_curve.append(capital)
                trades.append(
                    BacktestTrade(
                        symbol=name,
                        signal=position["signal"],
                        entry_time=position["entry_time"],
                        exit_time=snapshot.index[-1].isoformat(),
                        entry_price=position["entry_price"],
                        exit_price=exit_price,
                        stop_loss=position["stop_loss"],
                        target=position["target"],
                        pnl=pnl,
                        gross_pnl=gross_pnl,
                        costs=total_costs,
                        result=result,
                    )
                )
                position = None
                continue

        if position is not None:
            continue

        signal = generate_signal(snapshot, name, ticker, strict_mode=strict_mode)
        if signal["signal"] not in {"BUY CALL", "BUY PUT"}:
            continue

        position = {
            "signal": signal["signal"],
            "entry_price": float(next_candle["Open"]),
            "entry_time": next_candle.name.isoformat(),
            "stop_loss": float(signal["stop_loss"]),
            "target": float(signal["target"]),
        }

    if position is not None:
        final_candle = frame.iloc[-1]
        direction = 1 if position["signal"] == "BUY CALL" else -1
        exit_price = float(final_candle["Close"])
        gross_pnl = round((exit_price - position["entry_price"]) * direction, 2)
        total_costs = round((brokerage_per_side + slippage_per_side) * 2, 2)
        pnl = round(gross_pnl - total_costs, 2)
        capital = round(capital + pnl, 2)
        equity_curve.append(capital)
        trades.append(
            BacktestTrade(
                symbol=name,
                signal=position["signal"],
                entry_time=position["entry_time"],
                exit_time=final_candle.name.isoformat(),
                entry_price=position["entry_price"],
                exit_price=exit_price,
                stop_loss=position["stop_loss"],
                target=position["target"],
                pnl=pnl,
                gross_pnl=gross_pnl,
                costs=total_costs,
                result="FORCED_EXIT",
            )
        )

    wins = [trade for trade in trades if trade.pnl > 0]
    losses = [trade for trade in trades if trade.pnl < 0]
    gross_profit = round(sum(trade.pnl for trade in wins), 2)
    gross_loss = round(abs(sum(trade.pnl for trade in losses)), 2)
    total_pnl = round(sum(trade.pnl for trade in trades), 2)
    win_rate = round((len(wins) / len(trades) * 100), 2) if trades else 0.0
    average_win = round(gross_profit / len(wins), 2) if wins else 0.0
    average_loss = round(gross_loss / len(losses), 2) if losses else 0.0
    expectancy = round(total_pnl / len(trades), 2) if trades else 0.0
    profit_factor = round(gross_profit / gross_loss, 2) if gross_loss else None

    peak = equity_curve[0]
    max_drawdown = 0.0
    for value in equity_curve:
        peak = max(peak, value)
        if peak:
            drawdown = ((peak - value) / peak) * 100
            max_drawdown = max(max_drawdown, drawdown)

    return {
        "symbol": name,
        "ticker": ticker,
        "period": period,
        "interval": interval,
        "strict_mode": strict_mode,
        "initial_capital": round(initial_capital, 2),
        "ending_capital": round(capital, 2),
        "total_trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": win_rate,
        "gross_profit": gross_profit,
        "gross_loss": gross_loss,
        "net_pnl": total_pnl,
        "brokerage_per_side": brokerage_per_side,
        "slippage_per_side": slippage_per_side,
        "average_win": average_win,
        "average_loss": average_loss,
        "expectancy_per_trade": expectancy,
        "profit_factor": profit_factor,
        "max_drawdown_percent": round(max_drawdown, 2),
        "trades": [trade.__dict__ for trade in trades],
    }


def main():
    parser = argparse.ArgumentParser(description="Run a historical backtest for the current AI trading strategy.")
    parser.add_argument("--symbol", default="nifty", choices=["nifty", "banknifty"])
    parser.add_argument("--period", default="7d", help="Yahoo Finance period, for example 7d or 30d.")
    parser.add_argument("--interval", default="1m", help="Yahoo Finance interval, for example 1m or 5m.")
    parser.add_argument("--capital", type=float, default=100000.0, help="Initial paper capital.")
    parser.add_argument("--strict", action="store_true", help="Use stricter entry filters.")
    parser.add_argument("--brokerage", type=float, default=20.0, help="Brokerage cost per side.")
    parser.add_argument("--slippage", type=float, default=2.0, help="Slippage cost per side.")
    parser.add_argument("--output", choices=["json", "pretty"], default="pretty")
    args = parser.parse_args()

    results = run_backtest(
        args.symbol,
        args.period,
        args.interval,
        args.capital,
        strict_mode=args.strict,
        brokerage_per_side=args.brokerage,
        slippage_per_side=args.slippage,
    )

    if args.output == "json":
        print(json.dumps(results, indent=2))
        return

    print(f"Backtest: {results['symbol']} ({results['period']} @ {results['interval']})")
    print(f"Trades: {results['total_trades']}")
    print(f"Strict Mode: {results['strict_mode']}")
    print(f"Wins / Losses: {results['wins']} / {results['losses']}")
    print(f"Win Rate: {results['win_rate']}%")
    print(f"Net P&L: {results['net_pnl']}")
    print(f"Ending Capital: {results['ending_capital']}")
    print(f"Brokerage / Slippage per side: {results['brokerage_per_side']} / {results['slippage_per_side']}")
    print(f"Average Win / Loss: {results['average_win']} / {results['average_loss']}")
    print(f"Expectancy / Trade: {results['expectancy_per_trade']}")
    print(f"Profit Factor: {results['profit_factor']}")
    print(f"Max Drawdown: {results['max_drawdown_percent']}%")


if __name__ == "__main__":
    main()
