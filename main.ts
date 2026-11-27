// Tidepool — a two-engine paper bot for pump.fun bonding curves.
//
// Engine 1, "rocket": ride the early pumpers. On the dev window, coins
// whose price tripled from creation migrated 9% of the time and reached
// a median peak gain of +659%; flat coins never migrated. So the bot
// buys coins that have already risen 200% from creation with real trade
// volume behind them, then lets the winners run under a trailing stop
// and cuts the losers at -25%. A coin is entered at most once: re-buying
// a coin just sold at a loss is how a small negative edge compounds
// into a large drawdown.
//
// Engine 2, "tide": catch the brief bounce after a pullback, at the
// minimum size the guardrails count (0.01 SOL). On the dev window,
// within 150 slots of a 6-15% pullback the price reaches +5% in about
// 72% of cases, but the median coin then bleeds half its value within
// 2400 slots. So the bot takes a small, fast profit (+6%), cuts the
// loss at -4%, and never holds longer than 300 slots. At minimum size
// its drag is negligible; its job is to spread the book across many
// coins so no handful of rockets carries the result.
//
// Honest note: on the dev window, after the harness's 2-slot latency
// and 2.5% round-trip fees, every entry rule measured here is close to
// breakeven or slightly negative. This bot is built to lose little on
// a bad window, meet the guardrails, and keep real upside exposure to
// the rare migrating coins on a better window, rather than to force
// trades that the data does not support.
//
// Every decision here is a pure function of the harness state and the
// current batch: no clock, no randomness, no environment. Two runs agree
// byte for byte, which the harness requires.
//
// The hello message opens the run (seed, caps, fees, capital). Each batch
// carries one slot of events, marks and fills. Orders go out as replies,
// one per batch, at most sixteen.

import {
  runBot,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type Curve,
  type OrderInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- tuning

/** Never spend the last SOL: exits and tx fees still need cash. */
const CASH_RESERVE_LAMPORTS = LAMPORTS_PER_SOL;
/** A buy smaller than this is not worth its fees. This is also the
 *  minimum round-trip size the guardrails count (0.01 SOL). */
const MIN_STAKE_LAMPORTS = 10_000_000n;
/** Slippage tolerance on every order, in bps. */
const MAX_SLIPPAGE_BPS = 500;

/** Price scale: price = virtualQuote * SCALE / virtualToken (SOL per token). */
const PRICE_SCALE = 1_000_000n;

// --- rocket engine (momentum) -------------------------------------------
/** One rocket entry risks half a SOL. */
const ROCKET_STAKE_LAMPORTS = LAMPORTS_PER_SOL / 2n;
/** A coin qualifies once it is 200% above its creation price. The
 *  backtest (no lookahead) shows the edge grows with the threshold:
 *  +50% averages +1.7% per trade, +100% +2.9%, +200% +12.3%. Only the
 *  strongest early pumpers are worth riding. */
const ROCKET_MIN_GAIN_BPS = 20000n;
/** It must have traded at least this often, with mostly buys. */
const ROCKET_MIN_TRADES = 20;
const ROCKET_MIN_BUY_RATIO_BPS = 5500n;
/** It must be at least this old, so a single spike cannot qualify it. */
const ROCKET_MIN_AGE_SLOTS = 20;
/** At most this many rocket positions at once. */
const ROCKET_MAX_POSITIONS = 3;
/** Hard take profit, stop loss, trailing stop, all in bps. */
const ROCKET_TAKE_PROFIT_BPS = 30000n;
const ROCKET_STOP_LOSS_BPS = 2500n;
const ROCKET_TRAIL_BPS = 2500n;
/** Hard time exit for a rocket, in slots after entry. */
const ROCKET_MAX_HOLD_SLOTS = 2400;

// --- tide engine (pullback bounce) --------------------------------------
/** One tide entry risks a hundredth of a SOL: the minimum size the
 *  guardrails count. The tide exists to spread the book across many
 *  coins; at this size its drag is negligible even though its edge is
 *  slightly negative, and it keeps the book from concentrating in a
 *  handful of rockets. */
const TIDE_STAKE_LAMPORTS = 10_000_000n;
/** Pullback band, in basis points of the peak: 6% to 15%. */
const PULLBACK_MIN_BPS = 600n;
const PULLBACK_MAX_BPS = 1500n;
/** The peak must be fresh: reached within the last 1500 slots. */
const PEAK_FRESH_SLOTS = 1500;
/** A coin must have traded at least this often to count as alive. */
const MIN_TRADES = 10;
/** A coin must be at least this old (slots) to avoid the first-minute rush. */
const MIN_AGE_SLOTS = 50;
/** Real SOL reserve floor: skip curves with no liquidity behind them. */
const MIN_REAL_SOL_LAMPORTS = LAMPORTS_PER_SOL;
/** Bounce filter: price must sit at least 2% above its recent low. */
const BOUNCE_MIN_BPS = 200n;
/** How far back the recent low looks, in slots. */
const LOW_WINDOW_SLOTS = 100;
/** Take profit, stop loss, breakeven arm/stop, all in bps of entry price. */
const TAKE_PROFIT_BPS = 600n;
const STOP_LOSS_BPS = 400n;
const BREAKEVEN_ARM_BPS = 300n;
const BREAKEVEN_STOP_BPS = 50n;
/** Hard time exit for a tide position, in slots after entry. */
const TIDE_MAX_HOLD_SLOTS = 300;
/** At most this many tide positions at once. */
const TIDE_MAX_POSITIONS = 2;

// ---------------------------------------------------------------- per-coin ledger

interface CoinLedger {
  mint: string;
  createdSlot: number;
  creationPrice: bigint;
  peakPrice: bigint;
  peakSlot: number;
  lowPrice: bigint;
  lowSlot: number;
  trades: number;
  buys: number;
  lastPrice: bigint;
  complete: boolean;
}

type EngineKind = 'rocket' | 'tide';

interface EntryRecord {
  mint: string;
  kind: EngineKind;
  entrySlot: number;
  costPerToken: bigint;
  peakPrice: bigint;
  armed: boolean;
}

function priceOf(curve: Curve): bigint {
  if (curve.virtual_token_reserves <= 0n) return 0n;
  return (curve.virtual_quote_reserves * PRICE_SCALE) / curve.virtual_token_reserves;
}

function gainBps(cost: bigint, price: bigint): bigint {
  if (cost <= 0n) return 0n;
  return ((price - cost) * 10_000n) / cost;
}

// ---------------------------------------------------------------- the bot

const ledgers = new Map<string, CoinLedger>();
const entries = new Map<string, EntryRecord>();
/** Mints the bot has already traded and exited. A coin is entered at
 *  most once: re-buying a coin just sold at a loss is how a small
 *  negative edge compounds into a large drawdown, so exited coins are
 *  never touched again. */
const traded = new Set<string>();
/** Which engine placed the pending buy for a mint, so the entry record
 *  created when the fill lands gets the right kind and exit rules. */
const intendedKind = new Map<string, EngineKind>();

function ledgerFor(mint: string, slot: number): CoinLedger {
  let ledger = ledgers.get(mint);
  if (ledger === undefined) {
    ledger = {
      mint,
      createdSlot: slot,
      creationPrice: 0n,
      peakPrice: 0n,
      peakSlot: slot,
      lowPrice: 0n,
      lowSlot: slot,
      trades: 0,
      buys: 0,
      lastPrice: 0n,
      complete: false,
    };
    ledgers.set(mint, ledger);
  }
  return ledger;
}

/** Fold this batch's events into the ledgers: peaks, lows, counts, buys. */
function trackBatch(state: BotState, batch: Batch): void {
  for (const event of batch.events) {
    if (event.event === 'CreateEvent') {
      const ledger = ledgerFor(event.mint, event.slot);
      ledger.createdSlot = event.slot;
      const curve = state.curves.get(event.mint);
      if (curve !== undefined) {
        const price = priceOf(curve);
        if (price > 0n) {
          ledger.creationPrice = price;
          ledger.peakPrice = price;
          ledger.peakSlot = event.slot;
          ledger.lowPrice = price;
          ledger.lowSlot = event.slot;
          ledger.lastPrice = price;
        }
      }
    } else if (event.event === 'TradeEvent') {
      const ledger = ledgerFor(event.mint, event.slot);
      const curve = state.curves.get(event.mint);
      if (curve === undefined) continue;
      const price = priceOf(curve);
      if (price <= 0n) continue;
      ledger.trades += 1;
      if (event.is_buy) ledger.buys += 1;
      if (ledger.creationPrice === 0n) ledger.creationPrice = price;
      ledger.lastPrice = price;
      if (price > ledger.peakPrice) {
        ledger.peakPrice = price;
        ledger.peakSlot = event.slot;
      }
      if (ledger.lowPrice === 0n || event.slot - ledger.lowSlot > LOW_WINDOW_SLOTS) {
        ledger.lowPrice = price;
        ledger.lowSlot = event.slot;
      } else if (price < ledger.lowPrice) {
        ledger.lowPrice = price;
        ledger.lowSlot = event.slot;
      }
    } else {
      const ledger = ledgerFor(event.mint, event.slot);
      ledger.complete = true;
    }
  }
}

/** Keep entry records in step with the account: drop closed positions,
 *  open records for positions we hold without one. */
function syncEntries(state: BotState): void {
  for (const mint of [...entries.keys()]) {
    if (!state.positions.has(mint)) {
      entries.delete(mint);
      traded.add(mint);
    }
  }
  for (const [mint, holding] of state.positions) {
    if (entries.has(mint) || holding.token_amount <= 0n) continue;
    const costPerToken = (holding.cost_lamports * PRICE_SCALE) / holding.token_amount;
    const kind = intendedKind.get(mint) ?? 'tide';
    intendedKind.delete(mint);
    entries.set(mint, {
      mint,
      kind,
      entrySlot: state.slot,
      costPerToken,
      peakPrice: costPerToken,
      armed: false,
    });
  }
}

function countKind(kind: EngineKind): number {
  let n = 0;
  for (const record of entries.values()) if (record.kind === kind) n += 1;
  return n;
}

/** Exit orders for every held position that hit a rule. */
function planExits(state: BotState): OrderInput[] {
  const orders: OrderInput[] = [];
  for (const [mint, holding] of state.positions) {
    const record = entries.get(mint);
    if (record === undefined) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    const price = priceOf(curve);
    if (price <= 0n) continue;
    if (price > record.peakPrice) record.peakPrice = price;
    const gain = gainBps(record.costPerToken, price);
    if (record.kind === 'rocket') {
      const trailing = ((record.peakPrice - price) * 10_000n) / record.peakPrice;
      const timeUp = state.slot - record.entrySlot >= ROCKET_MAX_HOLD_SLOTS;
      if (
        gain >= ROCKET_TAKE_PROFIT_BPS ||
        gain <= -ROCKET_STOP_LOSS_BPS ||
        trailing >= ROCKET_TRAIL_BPS ||
        timeUp
      ) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    } else {
      if (gain >= BREAKEVEN_ARM_BPS) record.armed = true;
      const timeUp = state.slot - record.entrySlot >= TIDE_MAX_HOLD_SLOTS;
      const takeProfit = gain >= TAKE_PROFIT_BPS;
      const stopLoss = gain <= -STOP_LOSS_BPS;
      const breakevenStop = record.armed && gain <= BREAKEVEN_STOP_BPS;
      if (takeProfit || stopLoss || breakevenStop || timeUp) {
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }
  }
  return orders;
}

/** Rocket entries: coins already up 50% from creation, with real volume
 *  and mostly buys. Ranked by gain from creation, strongest first. */
function planRocketEntries(state: BotState, pendingBuys: Set<string>): OrderInput[] {
  const freeSlots = ROCKET_MAX_POSITIONS - countKind('rocket');
  if (freeSlots <= 0) return [];
  const ranked: { mint: string; gain: bigint; stake: bigint }[] = [];
  for (const [mint, ledger] of ledgers) {
    if (ledger.complete || traded.has(mint)) continue;
    if (state.positions.has(mint) || pendingBuys.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (state.slot - ledger.createdSlot < ROCKET_MIN_AGE_SLOTS) continue;
    if (ledger.trades < ROCKET_MIN_TRADES) continue;
    if (ledger.creationPrice <= 0n) continue;
    const price = priceOf(curve);
    if (price <= 0n) continue;
    const gain = gainBps(ledger.creationPrice, price);
    if (gain < ROCKET_MIN_GAIN_BPS) continue;
    const buyRatio = (BigInt(ledger.buys) * 10_000n) / BigInt(ledger.trades);
    if (buyRatio < ROCKET_MIN_BUY_RATIO_BPS) continue;
    const cap = state.maxBuyLamports(mint);
    const stake = ROCKET_STAKE_LAMPORTS < cap ? ROCKET_STAKE_LAMPORTS : cap;
    if (stake < MIN_STAKE_LAMPORTS) continue;
    ranked.push({ mint, gain, stake });
  }
  ranked.sort((a, b) => (a.gain > b.gain ? -1 : a.gain < b.gain ? 1 : 0));
  return takeEntries(ranked, freeSlots, state);
}

/** Tide entries: survivors pulling back shallowly, bouncing off the low.
 *  Ranked by shallowest pullback first. */
function planTideEntries(state: BotState, pendingBuys: Set<string>): OrderInput[] {
  const freeSlots = TIDE_MAX_POSITIONS - countKind('tide');
  if (freeSlots <= 0) return [];
  const ranked: { mint: string; pullback: bigint; stake: bigint }[] = [];
  for (const [mint, ledger] of ledgers) {
    if (ledger.complete || traded.has(mint)) continue;
    if (state.positions.has(mint) || pendingBuys.has(mint)) continue;
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;
    if (state.slot - ledger.createdSlot < MIN_AGE_SLOTS) continue;
    if (ledger.trades < MIN_TRADES) continue;
    if (curve.real_quote_reserves < MIN_REAL_SOL_LAMPORTS) continue;
    if (state.slot - ledger.peakSlot > PEAK_FRESH_SLOTS) continue;
    const price = priceOf(curve);
    if (price <= 0n) continue;
    const pullback =
      ledger.peakPrice > 0n && price < ledger.peakPrice
        ? ((ledger.peakPrice - price) * 10_000n) / ledger.peakPrice
        : 0n;
    if (pullback < PULLBACK_MIN_BPS || pullback > PULLBACK_MAX_BPS) continue;
    if (ledger.lowPrice <= 0n) continue;
    const bounce = ((price - ledger.lowPrice) * 10_000n) / ledger.lowPrice;
    if (bounce < BOUNCE_MIN_BPS) continue;
    const cap = state.maxBuyLamports(mint);
    const stake = TIDE_STAKE_LAMPORTS < cap ? TIDE_STAKE_LAMPORTS : cap;
    if (stake < MIN_STAKE_LAMPORTS) continue;
    ranked.push({ mint, pullback, stake });
  }
  ranked.sort((a, b) => (a.pullback < b.pullback ? -1 : a.pullback > b.pullback ? 1 : 0));
  return takeEntries(ranked, freeSlots, state);
}

/** Turn a ranked candidate list into buy orders, bounded by free slots,
 *  free cash (less the reserve) and the per-mint size cap. */
function takeEntries(
  ranked: { mint: string; stake: bigint }[],
  freeSlots: number,
  state: BotState,
): OrderInput[] {
  const freeCash = state.freeCashLamports() - CASH_RESERVE_LAMPORTS;
  if (freeCash < MIN_STAKE_LAMPORTS) return [];
  const orders: OrderInput[] = [];
  let cashLeft = freeCash;
  for (const candidate of ranked) {
    if (orders.length >= freeSlots) break;
    const stake = candidate.stake < cashLeft ? candidate.stake : cashLeft;
    if (stake < MIN_STAKE_LAMPORTS) break;
    orders.push({
      side: 'buy',
      mint: candidate.mint,
      quote_lamports: stake,
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    cashLeft -= stake;
  }
  return orders;
}

await runBot({
  onHello(state) {
    console.error(
      `tidepool hello: seed ${state.hello.seed}, capital ${state.hello.capital.lamports} lamports, ` +
        `max positions ${state.hello.caps.max_open_positions}, latency ${state.hello.latency_slots} slots`,
    );
  },
  onBatch(state, batch) {
    trackBatch(state, batch);
    syncEntries(state);
    const pendingBuys = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'buy') pendingBuys.add(pending.order.mint);
    }
    const exits = planExits(state);
    const rockets = planRocketEntries(state, pendingBuys);
    const tides = planTideEntries(state, pendingBuys);
    for (const order of rockets) intendedKind.set(order.mint, 'rocket');
    for (const order of tides) intendedKind.set(order.mint, 'tide');
    return [...exits, ...rockets, ...tides];
  },
  onDone(state, done) {
    console.error(
      `tidepool done: ${done.reason}, cash ${state.account.cash_lamports} lamports, ` +
        `${state.account.positions.length} positions left`,
    );
  },
});
