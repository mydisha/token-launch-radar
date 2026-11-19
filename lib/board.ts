// The board: every watchlist protocol plus every other rankable pre-token protocol, valued and ranked.

import { planFor, stepString, type Plan } from './farm.ts';
import {
  PARAMS,
  MODEL_VERSION,
  buildCompTable,
  isRankable,
  liveComps,
  neutralAgeOf,
  recordsNoToken,
  value,
  type CompTable,
  type Confidence,
  type Protocol,
  type RatioStat,
  type Snapshot,
} from './model.ts';

/** One row of board.json. The gate reads slug, name, rank, implied_value_usd and farm_steps; the rest is the model's evidence. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  confidence: Confidence;
  model: {
    version: string;
    mcap_to_tvl: number;
    comps: number;
    growth_pct: number;
    growth_multiplier: number;
    tenure_multiplier: number;
    reach_multiplier: number;
  };
  farm: {
    chain: string;
    capital_usd: number;
    cost_usd: number;
    hours: number;
    hold_days: number;
  };
  farm_steps: string[];
}

/** A protocol that already trades a token: shown at the market's own value, never ranked by the model. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  change_7d: number | null;
}

/** What the dashboard reads: the board, its plans in structured form, the comparables and the constants. */
export interface RadarData {
  version: string;
  as_of: string;
  source: string;
  floor_usd: number;
  params: typeof PARAMS;
  neutral_age_days: number;
  counts: { protocols: number; watchlist: number; board: number; early: number; live: number };
  rows: Array<
    Omit<BoardRow, 'farm_steps'> & {
      steps: Array<[string, string, string]>;
    }
  >;
  categories: Array<RatioStat>;
  global: RatioStat;
  live: LiveRow[];
}

const byImpliedThenSlug = (a: { implied: number; p: Protocol }, b: { implied: number; p: Protocol }): number =>
  b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0);

/** The rows the board ranks, in rank order. */
export function buildBoard(snapshot: Snapshot, table: CompTable): { rows: BoardRow[]; plans: Plan[] } {
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, Protocol>();
  for (const p of snapshot.protocols) if (watch.has(p.slug) || isRankable(p)) chosen.set(p.slug, p);
  const neutral = neutralAgeOf(snapshot);
  const scored = [...chosen.values()].map((p) => ({ p, v: value(p, snapshot.as_of, table, neutral), implied: 0 }));
  for (const s of scored) s.implied = s.v.implied;
  scored.sort(byImpliedThenSlug);
  const plans: Plan[] = [];
  const rows = scored.map((s, i): BoardRow => {
    const plan = planFor(s.p, s.v.age, s.v.growthPct);
    plans.push(plan);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: s.v.age,
      token_status: 'pre-token',
      on_watchlist: watch.has(s.p.slug),
      implied_value_usd: s.v.implied,
      implied_low_usd: s.v.low,
      implied_high_usd: s.v.high,
      confidence: s.v.confidence,
      model: {
        version: MODEL_VERSION,
        mcap_to_tvl: round(s.v.ratio, 4),
        comps: s.v.stat.comps,
        growth_pct: round(s.v.growthPct, 4),
        growth_multiplier: round(s.v.growthMult, 4),
        tenure_multiplier: round(s.v.tenureMult, 4),
        reach_multiplier: round(s.v.reachMult, 4),
      },
      farm: { chain: plan.chain, capital_usd: plan.capital_usd, cost_usd: plan.cost_usd, hours: plan.hours, hold_days: plan.hold_days },
      farm_steps: plan.steps.map(stepString),
    };
  });
  return { rows, plans };
}

const round = (n: number, places: number): number => {
  const k = 10 ** places;
  return Math.round(n * k) / k;
};

/** The first reason the gate would refuse this board, or null when it passes every row. */
export function boardIssue(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `the board has ${rows.length} rows, the gate takes 100 to 4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of rows) {
    if (!known.has(r.slug)) return `${r.slug} is not a protocol of the snapshot`;
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
    if (r.name.length === 0) return `${r.slug} has no name`;
  }
  const missing = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < rows.length; i++) if (rows[i]!.rank !== i + 1) return `rank ${rows[i]!.rank} sits at position ${i + 1}`;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.implied_value_usd > rows[i - 1]!.implied_value_usd) return `row ${i + 1} is worth more than row ${i}`;
  }
  if (rows[0]!.implied_value_usd === rows[rows.length - 1]!.implied_value_usd) return 'every row has the same implied value';
  for (const r of rows) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has an implied value the gate refuses`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (r.implied_low_usd > r.implied_value_usd || r.implied_high_usd < r.implied_value_usd) return `${r.slug}'s range does not hold its estimate`;
  }
  return null;
}

/** The live-token protocols, by market cap: the board never mixes them in. */
function liveRows(snapshot: Snapshot, limit: number): LiveRow[] {
  const comps = new Map(liveComps(snapshot).map((c) => [c.slug, c.ratio]));
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p) && p.mcap_usd !== null && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || (a.slug < b.slug ? -1 : 1))
    .slice(0, limit)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd ?? 0,
      ratio: round(comps.get(p.slug) ?? 0, 4),
      change_7d: p.change_7d,
    }));
}

/** The single object the dashboard loads. */
export function buildRadar(snapshot: Snapshot): { rows: BoardRow[]; radar: RadarData } {
  const table = buildCompTable(snapshot);
  const { rows, plans } = buildBoard(snapshot, table);
  const watch = new Set(snapshot.watchlist);
  const live = liveRows(snapshot, 40);
  const radar: RadarData = {
    version: MODEL_VERSION,
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    params: PARAMS,
    neutral_age_days: neutralAgeOf(snapshot),
    counts: {
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
      board: rows.length,
      early: rows.filter((r) => !watch.has(r.slug)).length,
      live: table.compCount,
    },
    rows: rows.map((r, i) => {
      const { farm_steps: _unused, ...rest } = r;
      return { ...rest, steps: plans[i]!.steps.map((s): [string, string, string] => [s.text, s.cost, s.time]) };
    }),
    categories: [...table.byCategory.values()].sort((a, b) => b.comps - a.comps || (a.category < b.category ? -1 : 1)),
    global: table.global,
    live,
  };
  return { rows, radar };
}

/** The dashboard's data file: one assignment, no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
