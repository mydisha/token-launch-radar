# token-launch-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/mydisha/token-launch-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/mydisha/token-launch-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it finds protocols that record no token, says what a token would be worth if the protocol's record stayed as it is, and gives a farm plan with costs and times for each.

The value comes from the snapshot's own figures, with no list of names. Every protocol that already trades a token gives a market-cap-to-TVL ratio; ratios are grouped by DefiLlama category, shrunk toward a cautious prior when a category has few comparables, then adjusted by seven-day TVL growth, time tracked with no token and chain reach. Each row carries a low and a high case. Categories nobody has priced are valued below the market's median and marked low confidence.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input path/to/snapshot.json
node --test tests/radar.test.ts
```

`main.ts` writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output folder. Open `out/dashboard/index.html` to read the board. The run is deterministic and needs only Node 22.18 or later.

## Layout

- `lib/model.ts`: comparables, shrinkage, the implied value and its low and high case
- `lib/farm.ts`: category playbooks, gas by chain, capital by TVL, hold window by age
- `lib/board.ts`: the ranked board, the gate checks and the dashboard's data
- `dashboard/`: the page (sortable table, filters, detail view, value model, live-token comparables)

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
