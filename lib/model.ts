// Value model for the launch radar: one frozen snapshot in, one ranked board out.
//
// The question the board answers: if this protocol's record stayed as it is and it issued a token
// tomorrow, what would that token be worth? The answer is read off the snapshot itself, never off a
// list of names:
//
//   1. COMPARABLES. Every protocol in the snapshot that already trades a token gives one data point,
//      its market cap divided by its TVL (the "mcap / TVL ratio"). Grouped by DefiLlama category, those
//      ratios say what the market pays per dollar of TVL for a lender, a DEX, a bridge and so on.
//   2. SHRINKAGE. A category with few comparables is pulled toward the all-category median, in log
//      space, with weight n / (n + SHRINK_K), toward a cautious prior (the all-category 25th percentile).
//      A category with no live token at all is valued on that prior alone (see ratioFor).
//   3. ADJUSTMENTS, all from the protocol's own row:
//        growth    = 1 + GROWTH_WEIGHT x clamp(change_7d)/100       (TVL momentum over seven days)
//        tenure    = TENURE_FLOOR + TENURE_RANGE x min(age, cap)/cap (days tracked with no token)
//        reach     = 1 + REACH_STEP x min(chains - 1, REACH_CAP)     (more chains, more users to reward)
//   4. IMPLIED  = tvl x ratio x growth x tenure x reach, with a low and a high case from the
//      category's 25th and 75th percentile ratios.
//
// The same function scores every row. Nothing here reads the clock or a random source, so two runs
// write the same bytes.

/** One protocol exactly as the snapshot carries it. */
export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** The tunable constants. The dashboard prints every one of them. */
export const PARAMS = {
  shrinkK: 5,
  ratioMin: 0.01,
  ratioMax: 20,
  growthFloor: -50,
  growthCap: 100,
  growthWeight: 0.4,
  tenureFloor: 0.8,
  tenureRange: 0.4,
  tenureCapDays: 1460,
  reachStep: 0.02,
  reachCap: 5,
  highConfidenceComps: 8,
  mediumConfidenceComps: 3,
} as const;

export const MODEL_VERSION = 'radar-comps-2';

/** Categories whose products wrap, stake or custody a token that lives elsewhere: never ranked. */
const DERIVATIVE_CATEGORIES = new Set(['CEX', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'Canonical Bridge', 'Bridge', 'Anchor BTC']);

const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** An exchange's own product (a wrapped or custodied coin), or a name that says it wraps or stakes another token. */
const EXCHANGE_PRODUCT = /^(binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

const DAY_MS = 86_400_000;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** True when the record names no token at all. */
export function recordsNoToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** True when a pre-token protocol is a real farmable product, not a wrapper, an exchange or a version pool. */
export function isRankable(p: Protocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return false;
  return !VERSION_SUFFIX.test(p.name) && !EXCHANGE_PRODUCT.test(p.name) && !WRAPPED_WORD.test(p.name);
}

/** Whole days from `listedAt` to `asOf`, or null when either date is missing or malformed. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Linear-interpolated quantile of an ascending list (q between 0 and 1). */
export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** What the market pays per dollar of TVL for one category, with the evidence behind it. */
export interface RatioStat {
  category: string;
  comps: number;
  median: number;
  p25: number;
  p75: number;
  weight: number;
  basis: 'category' | 'blended' | 'global';
  examples: string[];
}

export interface CompTable {
  global: RatioStat;
  globalP10: number;
  byCategory: Map<string, RatioStat>;
  compCount: number;
}

interface Comp {
  slug: string;
  name: string;
  category: string;
  ratio: number;
  mcap: number;
}

/** The live-token protocols the ratios are measured on. */
export function liveComps(snapshot: Snapshot): Comp[] {
  const out: Comp[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    if (p.category === 'CEX') continue;
    const ratio = clamp(p.mcap_usd / p.tvl_usd, PARAMS.ratioMin, PARAMS.ratioMax);
    out.push({ slug: p.slug, name: p.name, category: p.category ?? 'Uncategorised', ratio, mcap: p.mcap_usd });
  }
  return out;
}

function statOf(category: string, comps: Comp[]): { median: number; p25: number; p75: number } {
  const sorted = comps.map((c) => c.ratio).sort((a, b) => a - b);
  return { median: quantile(sorted, 0.5), p25: quantile(sorted, 0.25), p75: quantile(sorted, 0.75) };
}

/** Blend two positive numbers in log space: weight w on `a`. */
const logBlend = (a: number, b: number, w: number): number => Math.exp(w * Math.log(a) + (1 - w) * Math.log(b));

/** Build the per-category comparable table from the snapshot's live-token protocols. */
export function buildCompTable(snapshot: Snapshot): CompTable {
  const comps = liveComps(snapshot);
  if (comps.length === 0) throw new SnapshotError('the snapshot has no protocol with a token and a TVL to measure ratios on');
  const g = statOf('all', comps);
  const globalP10 = quantile(comps.map((c) => c.ratio).sort((a, b) => a - b), 0.1);
  // The prior a thinly measured category is pulled toward is cautious: one step below the all-category
  // distribution, so a category the market has barely priced is never valued above what it has shown.
  const prior = { median: g.p25, p25: globalP10, p75: g.median };
  const global: RatioStat = { category: 'All categories', comps: comps.length, ...g, weight: 1, basis: 'global', examples: [] };
  const groups = new Map<string, Comp[]>();
  for (const c of comps) {
    const list = groups.get(c.category);
    if (list === undefined) groups.set(c.category, [c]);
    else list.push(c);
  }
  const byCategory = new Map<string, RatioStat>();
  for (const [category, list] of groups) {
    const s = statOf(category, list);
    const w = list.length / (list.length + PARAMS.shrinkK);
    const examples = [...list].sort((a, b) => b.mcap - a.mcap || (a.slug < b.slug ? -1 : 1)).slice(0, 3).map((c) => c.name);
    byCategory.set(category, {
      category,
      comps: list.length,
      median: logBlend(s.median, prior.median, w),
      p25: logBlend(s.p25, prior.p25, w),
      p75: logBlend(s.p75, prior.p75, w),
      weight: w,
      basis: 'blended',
      examples,
    });
  }
  return { global, globalP10, byCategory, compCount: comps.length };
}

/**
 * The ratio statistics a protocol of `category` is valued with. A category with no live token has no
 * evidence of its own, so it is valued cautiously: the all-category 25th percentile stands in for the
 * median, the 10th for the low case and the all-category median for the high case.
 */
export function ratioFor(table: CompTable, category: string | null): RatioStat {
  const hit = category === null ? undefined : table.byCategory.get(category);
  if (hit !== undefined) return hit;
  const g = table.global;
  return { category: category ?? 'Uncategorised', comps: 0, median: g.p25, p25: table.globalP10, p75: g.median, weight: 0, basis: 'global', examples: [] };
}

export type Confidence = 'high' | 'medium' | 'low';

export interface Valuation {
  implied: number;
  low: number;
  high: number;
  ratio: number;
  growthPct: number;
  growthMult: number;
  tenureMult: number;
  reachMult: number;
  age: number | null;
  confidence: Confidence;
  stat: RatioStat;
}

/** The implied value of one protocol, with its low and high case and every factor that made it. */
export function value(p: Protocol, asOf: string, table: CompTable, neutralAge: number): Valuation {
  const stat = ratioFor(table, p.category);
  const age = ageDays(asOf, p.listed_at);
  const growthPct = clamp(p.change_7d ?? 0, PARAMS.growthFloor, PARAMS.growthCap);
  const growthMult = 1 + (growthPct / 100) * PARAMS.growthWeight;
  const ageUsed = clamp(age ?? neutralAge, 0, PARAMS.tenureCapDays);
  const tenureMult = PARAMS.tenureFloor + (ageUsed / PARAMS.tenureCapDays) * PARAMS.tenureRange;
  const reachMult = 1 + PARAMS.reachStep * clamp(p.chains.length - 1, 0, PARAMS.reachCap);
  const factor = growthMult * tenureMult * reachMult;
  const base = p.tvl_usd * factor;
  const implied = Math.max(1, Math.round(base * stat.median));
  const low = Math.max(1, Math.min(implied, Math.round(base * stat.p25)));
  const high = Math.max(implied, Math.round(base * stat.p75));
  let confidence: Confidence = stat.comps >= PARAMS.highConfidenceComps ? 'high' : stat.comps >= PARAMS.mediumConfidenceComps ? 'medium' : 'low';
  if (age === null && confidence === 'high') confidence = 'medium';
  return { implied, low, high, ratio: stat.median, growthPct, growthMult, tenureMult, reachMult, age, confidence, stat };
}

/** The median tracked age, in days, of the rankable pre-token protocols that report one. */
export function neutralAgeOf(snapshot: Snapshot): number {
  const ages: number[] = [];
  for (const p of snapshot.protocols) {
    if (!isRankable(p)) continue;
    const a = ageDays(snapshot.as_of, p.listed_at);
    if (a !== null) ages.push(a);
  }
  ages.sort((a, b) => a - b);
  return ages.length === 0 ? 365 : Math.round(quantile(ages, 0.5));
}

/** Parse and strictly validate the snapshot's text. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json lacks an as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json lacks a source');
  if (typeof o.floor_usd !== 'number' || !(o.floor_usd > 0)) throw new SnapshotError('snapshot.json lacks a floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json lacks a protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json lacks a watchlist of slugs');
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const protocols: Protocol[] = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    const tvl = num(p.tvl_usd);
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || tvl === null) throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: tvl,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}
