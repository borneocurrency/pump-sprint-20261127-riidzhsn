# pump-sprint-20261127-riidzhsn

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/borneocurrency/pump-sprint-20261127-riidzhsn/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/borneocurrency/pump-sprint-20261127-riidzhsn/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Tidepool is a paper trading bot for pump.fun bonding curves, built for make.fun's "Pump.fun Bot Sprint: Make Bot And Win". It runs two small engines on 10 SOL of paper capital:

- **Rocket** — rides the early pumpers. Coins whose price tripled from creation migrated 9% of the time on the dev window and reached a median peak gain of +659%; flat coins never migrated. The bot buys coins up 200% from creation with real trade volume behind them, lets the winners run under a 25% trailing stop, and cuts losers at -25%.
- **Tide** — catches the brief bounce after a pullback, at the minimum size the guardrails count (0.01 SOL). Within 150 slots of a 6–15% pullback the price reaches +5% in about 72% of cases, but the median coin then bleeds half its value within 2400 slots, so the bot takes a small fast profit (+6%), cuts the loss at -4%, and never holds longer than 300 slots.

Two discipline rules keep the book honest: a coin is entered at most once (re-buying a coin just sold at a loss is how a small negative edge compounds into a large drawdown), and one SOL of cash is always held back for exits and fees. Every decision is a pure function of the harness state and the current batch — no clock, no randomness, no environment — so two runs reproduce byte for byte.

Dev grade (local, process driver, dev window 2–3 Nov 2026): guardrails met, 250 coins traded, 250 round trips, max drawdown 11.4%, net PnL about -0.77 SOL. Honest note: after the harness's 2-slot latency and 2.5% round-trip fees, every entry rule measured on this window is close to breakeven or slightly negative. This bot is built to lose little on a bad window, meet the guardrails, and keep real upside exposure to the rare migrating coins on a better window, rather than to force trades the data does not support.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot /path/to/pump-sprint-20261127-riidzhsn --driver process --worktree
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=v65mxvpt&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
