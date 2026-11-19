// Run with: node --test tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardIssue, buildRadar } from '../lib/board.ts';
import { capitalFor, familyOf, holdDaysFor, planFor, stepString } from '../lib/farm.ts';
import { buildCompTable, isRankable, parseSnapshot, quantile, ratioFor, SnapshotError, value, type Protocol, type Snapshot } from '../lib/model.ts';
import { imageSize } from '../lib/outcheck.ts';

function proto(over: Partial<Protocol> & { slug: string }): Protocol {
  return {
    name: over.slug.toUpperCase(),
    category: 'Lending',
    chains: ['Ethereum'],
    tvl_usd: 10_000_000,
    change_7d: 0,
    mcap_usd: null,
    listed_at: '2025-01-01',
    gecko_id: null,
    symbol: null,
    ...over,
  };
}

/** 12 live lenders at a 0.2 ratio, 2 live DEXs at 1.0, and 130 pre-token protocols, 45 of them on the watchlist. */
function fixture(): Snapshot {
  const protocols: Protocol[] = [];
  for (let i = 0; i < 12; i++) protocols.push(proto({ slug: `live-lend-${i}`, tvl_usd: 100_000_000, mcap_usd: 20_000_000, gecko_id: `g${i}`, symbol: `L${i}` }));
  for (let i = 0; i < 2; i++) protocols.push(proto({ slug: `live-dex-${i}`, category: 'Dexs', tvl_usd: 100_000_000, mcap_usd: 100_000_000, gecko_id: `d${i}`, symbol: `D${i}` }));
  const watchlist: string[] = [];
  for (let i = 0; i < 130; i++) {
    const slug = `pre-${String(i).padStart(3, '0')}`;
    protocols.push(proto({ slug, tvl_usd: 5_000_000 + i * 1_000_000, change_7d: (i % 11) - 5, category: i % 3 === 0 ? 'Dexs' : i % 3 === 1 ? 'Lending' : 'Odd Category' }));
    if (i < 45) watchlist.push(slug);
  }
  protocols.sort((a, b) => (a.slug < b.slug ? -1 : 1));
  return { as_of: '2026-11-14', source: 'test', floor_usd: 50_000_000, protocols, watchlist: watchlist.sort() };
}

test('quantile interpolates and handles single values', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([7], 0.9), 7);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test('isRankable keeps real pre-token products and drops wrappers, exchanges and version pools', () => {
  assert.equal(isRankable(proto({ slug: 'a' })), true);
  assert.equal(isRankable(proto({ slug: 'b', mcap_usd: 5 })), false);
  assert.equal(isRankable(proto({ slug: 'c', symbol: 'X' })), false);
  assert.equal(isRankable(proto({ slug: 'd', category: 'CEX' })), false);
  assert.equal(isRankable(proto({ slug: 'e', category: 'Liquid Staking' })), false);
  assert.equal(isRankable(proto({ slug: 'f', category: 'Bridge' })), false);
  assert.equal(isRankable(proto({ slug: 'g', name: 'Foo V2' })), false);
  assert.equal(isRankable(proto({ slug: 'h', name: 'Binance Staked ETH' })), false);
  assert.equal(isRankable(proto({ slug: 'i', name: 'Wrapped Thing' })), false);
  assert.equal(isRankable(proto({ slug: 'j', name: 'Coinbase Bridge' })), false);
  assert.equal(isRankable(proto({ slug: 'k', name: 'Foo Staking Pool' })), false);
  assert.equal(isRankable(proto({ slug: 'l', name: 'Binancelike' })), true);
});

test('the category ratio is measured on live tokens and shrunk toward a cautious prior', () => {
  const table = buildCompTable(fixture());
  const lend = ratioFor(table, 'Lending');
  const dex = ratioFor(table, 'Dexs');
  assert.equal(lend.comps, 12);
  assert.equal(dex.comps, 2);
  assert.ok(lend.median > 0.1 && lend.median < 0.25, `lending median ${lend.median}`);
  // two comparables carry little weight, so a DEX is pulled well below its raw ratio of 1.0
  assert.ok(dex.median < 0.6, `dex median ${dex.median}`);
  assert.ok(dex.weight < lend.weight);
  const odd = ratioFor(table, 'Odd Category');
  assert.equal(odd.comps, 0);
  assert.equal(odd.basis, 'global');
  assert.ok(odd.p25 <= odd.median && odd.median <= odd.p75);
});

test('value rises with TVL and growth, and brackets the estimate with a low and a high case', () => {
  const snap = fixture();
  const table = buildCompTable(snap);
  const small = value(proto({ slug: 's', tvl_usd: 10_000_000 }), snap.as_of, table, 365);
  const big = value(proto({ slug: 'b', tvl_usd: 20_000_000 }), snap.as_of, table, 365);
  assert.ok(Math.abs(big.implied / small.implied - 2) < 0.001);
  const up = value(proto({ slug: 'u', change_7d: 80 }), snap.as_of, table, 365);
  const down = value(proto({ slug: 'd', change_7d: -80 }), snap.as_of, table, 365);
  assert.ok(up.implied > small.implied && small.implied > down.implied);
  assert.equal(down.growthPct, -50, 'growth is clamped');
  for (const v of [small, big, up, down]) assert.ok(v.low <= v.implied && v.implied <= v.high);
  const unknownAge = value(proto({ slug: 'n', listed_at: null }), snap.as_of, table, 365);
  assert.equal(unknownAge.age, null);
  assert.ok(unknownAge.confidence !== 'high', 'an unknown age lowers confidence');
});

test('the board covers the watchlist, ranks by value and passes the gate checks', () => {
  const snap = fixture();
  const { rows } = buildRadar(snap);
  assert.equal(boardIssue(rows, snap), null);
  for (const slug of snap.watchlist) assert.ok(rows.some((r) => r.slug === slug));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i]!.implied_value_usd <= rows[i - 1]!.implied_value_usd);
  assert.deepEqual(rows.map((r) => r.rank), rows.map((_, i) => i + 1));
  assert.ok(rows.every((r) => !r.slug.startsWith('live-')), 'live-token protocols are never ranked');
});

test('boardIssue refuses a missing watchlist slug, a short board and a flat board', () => {
  const snap = fixture();
  const { rows } = buildRadar(snap);
  assert.match(boardIssue(rows.filter((r) => r.slug !== snap.watchlist[0]), snap) ?? '', /misses 1 watchlist/);
  assert.match(boardIssue(rows.slice(0, 50), snap) ?? '', /100 to 4000/);
  const flat = rows.map((r) => ({ ...r, implied_value_usd: 1000, implied_low_usd: 1000, implied_high_usd: 1000 }));
  assert.match(boardIssue(flat, snap) ?? '', /same implied value/);
  const bad = rows.map((r, i) => (i === 3 ? { ...r, farm_steps: ['too short'] } : r));
  assert.match(boardIssue(bad, snap) ?? '', /farm step|farm steps/);
});

test('two builds of the same snapshot are identical', () => {
  const a = JSON.stringify(buildRadar(fixture()));
  const b = JSON.stringify(buildRadar(fixture()));
  assert.equal(a, b);
});

test('every farm step is 20 to 600 characters and names its cost and time', () => {
  const snap = fixture();
  const edge: Protocol[] = [
    proto({ slug: 'x1', chains: [], category: null }),
    proto({ slug: 'x2', chains: ['Bitcoin'], category: 'Bridge', listed_at: null }),
    proto({ slug: 'x3', chains: ['Ethereum', 'Solana', 'Base', 'Arbitrum', 'Optimism', 'Polygon', 'Monad'], category: 'Derivatives', change_7d: 120 }),
    proto({ slug: 'x4', category: 'RWA', change_7d: -40, tvl_usd: 9_000_000_000, name: 'A very long protocol name '.repeat(8) }),
    proto({ slug: 'x5', category: 'Staking Pool', change_7d: null }),
  ];
  for (const p of edge) {
    const plan = planFor(p, p.listed_at === null ? null : 400, p.change_7d ?? 0);
    assert.ok(plan.steps.length >= 3 && plan.steps.length <= 12);
    for (const s of plan.steps) {
      const text = stepString(s);
      assert.ok(text.length >= 20 && text.length <= 600, `${p.slug}: ${text.length}`);
      assert.match(text, /Cost: .+ Time: /);
    }
    assert.ok(plan.cost_usd >= 0 && plan.hours > 0);
  }
  assert.ok(snap.protocols.length > 0);
});

test('farm helpers scale as documented', () => {
  assert.equal(capitalFor(10_000_000), 50);
  assert.equal(capitalFor(60_000_000), 100);
  assert.equal(capitalFor(2_000_000_000), 300);
  assert.ok(holdDaysFor(30) > holdDaysFor(500));
  assert.equal(holdDaysFor(null), 45);
  assert.equal(familyOf('Lending'), 'lend');
  assert.equal(familyOf('Risk Curators'), 'lend');
  assert.equal(familyOf('Dexs'), 'dex');
  assert.equal(familyOf(null), 'generic');
  assert.equal(planFor(proto({ slug: 'z', chains: ['Ethereum', 'Base'] }), 200, 0).chain, 'Base', 'the cheapest chain is used');
});

test('parseSnapshot rejects malformed input and accepts the sealed shape', () => {
  assert.throws(() => parseSnapshot('not json'), SnapshotError);
  assert.throws(() => parseSnapshot('[]'), SnapshotError);
  assert.throws(() => parseSnapshot(JSON.stringify({ as_of: '2026-1-1', source: 's', floor_usd: 1, protocols: [], watchlist: [] })), /as_of/);
  assert.throws(() => parseSnapshot(JSON.stringify({ as_of: '2026-11-14', source: 's', floor_usd: 1, protocols: [{ slug: 'a' }], watchlist: [] })), /lacks a slug/);
  const ok = parseSnapshot(JSON.stringify(fixture()));
  assert.equal(ok.protocols.length, 144);
  assert.throws(() => buildCompTable({ ...ok, protocols: ok.protocols.filter((p) => p.mcap_usd === null) }), /no protocol with a token/);
});

test('imageSize reads PNG and JPEG headers and refuses other bytes', () => {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(1440, 16);
  png.writeUInt32BE(900, 20);
  assert.deepEqual(imageSize(png), { w: 1440, h: 900 });
  assert.equal(imageSize(Buffer.from('GIF89a......................')), null);
});
