'use strict';
// Launch radar dashboard. Reads window.RADAR (data.js, written by main.ts from the same board as board.json).
// View state lives in the address hash, so any view can be linked and reproduced:
//   #view=radar|method|live  q  cat  chain  tvl  watch  conf  sort  dir  p (a protocol slug)  n (rows shown)
(function () {
  const D = window.RADAR;
  const app = document.getElementById('app');
  if (!D || !Array.isArray(D.rows)) return;

  // ---------- helpers ----------
  function el(tag, props, ...kids) {
    const node = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
  function money(n) {
    if (n === null || n === undefined) return 'n/a';
    const a = Math.abs(n);
    const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    for (const [size, tag] of units) {
      if (a >= size) {
        const v = n / size;
        return '$' + (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)) + tag;
      }
    }
    return '$' + Math.round(n);
  }
  const pct = (n) => (n === null || n === undefined ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');
  const mult = (n) => '×' + n.toFixed(3);
  const days = (n) => (n === null ? 'unknown' : n >= 730 ? (n / 365).toFixed(1) + ' y' : n + ' d');
  const growthClass = (n) => (n === null ? 'muted' : n > 0.05 ? 'up' : n < -0.05 ? 'down' : 'muted');

  // ---------- state in the hash ----------
  const DEFAULTS = { view: 'radar', q: '', cat: '', chain: '', tvl: 0, watch: 0, conf: '', sort: 'implied', dir: 'desc', p: '', n: 25 };
  let S = Object.assign({}, DEFAULTS);
  function readHash() {
    const next = Object.assign({}, DEFAULTS);
    for (const part of location.hash.slice(1).split('&')) {
      const at = part.indexOf('=');
      if (at < 1) continue;
      const k = decodeURIComponent(part.slice(0, at));
      const v = decodeURIComponent(part.slice(at + 1));
      if (k in DEFAULTS) next[k] = typeof DEFAULTS[k] === 'number' ? Number(v) || 0 : v;
    }
    S = next;
  }
  function writeHash() {
    const parts = [];
    for (const k in DEFAULTS) if (S[k] !== DEFAULTS[k]) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(S[k]));
    history.replaceState(null, '', parts.length ? '#' + parts.join('&') : location.pathname + location.search);
  }
  function set(patch) {
    Object.assign(S, patch);
    writeHash();
    render();
  }

  // ---------- data ----------
  const rows = D.rows;
  const bySlug = new Map(rows.map((r) => [r.slug, r]));
  const catStat = new Map(D.categories.map((c) => [c.category, c]));
  const categories = [...new Set(rows.map((r) => r.category || 'Uncategorised'))].sort();
  const chains = [...new Set(rows.flatMap((r) => r.chains))].sort();
  const maxLog = Math.log(rows[0].implied_high_usd);
  const minLog = Math.log(Math.max(1, rows[rows.length - 1].implied_low_usd));
  const barWidth = (v) => Math.max(2, (100 * (Math.log(Math.max(1, v)) - minLog)) / (maxLog - minLog || 1));

  const SORTS = {
    implied: (r) => r.implied_value_usd,
    tvl: (r) => r.tvl_usd,
    growth: (r) => (r.change_7d === null ? -Infinity : r.change_7d),
    age: (r) => (r.age_days === null ? -1 : r.age_days),
    cost: (r) => r.farm.cost_usd,
    name: (r) => r.name.toLowerCase(),
  };

  function visible() {
    const q = S.q.trim().toLowerCase();
    const out = rows.filter(
      (r) =>
        (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q) || (r.category || '').toLowerCase().includes(q)) &&
        (!S.cat || (r.category || 'Uncategorised') === S.cat) &&
        (!S.chain || r.chains.includes(S.chain)) &&
        r.tvl_usd >= S.tvl &&
        (!S.watch || r.on_watchlist) &&
        (!S.conf || r.confidence === S.conf),
    );
    const key = SORTS[S.sort] || SORTS.implied;
    const sign = S.dir === 'asc' ? 1 : -1;
    out.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return (x < y ? -1 : x > y ? 1 : 0) * sign || a.rank - b.rank;
    });
    return out;
  }

  // ---------- chrome: tabs, stats, footer ----------
  function chrome() {
    const tabs = document.getElementById('tabs');
    tabs.replaceChildren(
      ...[['radar', 'Radar'], ['method', 'Value model'], ['live', 'Token already trades']].map(([id, label]) =>
        el('button', { class: 'tab', type: 'button', 'aria-current': S.view === id ? 'page' : null, onclick: () => set({ view: id }), text: label }),
      ),
    );
    const c = D.counts;
    const stat = (b, s) => el('div', { class: 'stat' }, el('b', { text: b }), el('span', { text: s }));
    document.getElementById('stats').replaceChildren(
      stat(String(c.board), 'protocols ranked (no token recorded)'),
      stat(String(c.watchlist), 'on the watchlist, all covered'),
      stat(String(c.early), 'earlier finds below or beside the floor'),
      stat(String(c.live), 'live-token comparables set the prices'),
      stat(D.as_of, 'snapshot date'),
    );
    document.getElementById('foot').textContent =
      'Model ' + D.version + '. An implied value is this dashboard’s own claim from the snapshot’s figures. It does not say a token will be issued, or when, and it is not advice. Gas and capital figures are estimates.';
  }

  // ---------- radar view ----------
  function select(label, id, values, current, onchange, all) {
    const s = el('select', { id, onchange: (e) => onchange(e.target.value) }, el('option', { value: '', text: all }), ...values.map((v) => el('option', { value: v, text: v })));
    s.value = current;
    return el('label', { class: 'field', for: id }, label, s);
  }

  function controls(count) {
    const search = el('input', { id: 'f-q', type: 'search', placeholder: 'Name, slug or category', value: S.q, oninput: (e) => { S.q = e.target.value; S.n = DEFAULTS.n; writeHash(); renderList(); } });
    const tvl = el(
      'select',
      { id: 'f-tvl', onchange: (e) => set({ tvl: Number(e.target.value), n: DEFAULTS.n }) },
      ...[[0, 'Any TVL'], [5e6, '$5M+'], [25e6, '$25M+'], [50e6, '$50M+'], [250e6, '$250M+'], [1e9, '$1B+']].map(([v, t]) => el('option', { value: v, text: t })),
    );
    tvl.value = String(S.tvl);
    const conf = el('select', { id: 'f-conf', onchange: (e) => set({ conf: e.target.value, n: DEFAULTS.n }) }, el('option', { value: '', text: 'Any' }), ...['high', 'medium', 'low'].map((v) => el('option', { value: v, text: v })));
    conf.value = S.conf;
    return el(
      'div',
      { class: 'controls', role: 'search' },
      el('label', { class: 'field', for: 'f-q' }, 'Search', search),
      select('Category', 'f-cat', categories, S.cat, (v) => set({ cat: v, n: DEFAULTS.n }), 'All categories'),
      select('Chain', 'f-chain', chains, S.chain, (v) => set({ chain: v, n: DEFAULTS.n }), 'All chains'),
      el('label', { class: 'field', for: 'f-tvl' }, 'TVL', tvl),
      el('label', { class: 'field', for: 'f-conf' }, 'Confidence', conf),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: S.watch ? true : null, onchange: (e) => set({ watch: e.target.checked ? 1 : 0, n: DEFAULTS.n }) }), 'Watchlist only'),
      el('button', { class: 'btn', type: 'button', onclick: () => set({ q: '', cat: '', chain: '', tvl: 0, watch: 0, conf: '', n: DEFAULTS.n }), text: 'Clear' }),
      el('span', { class: 'count', id: 'count', 'aria-live': 'polite', text: count + ' shown' }),
    );
  }

  function th(label, key, cls) {
    const active = S.sort === key;
    return el(
      'th',
      { scope: 'col', class: cls || '', 'aria-sort': active ? (S.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
      el('button', { type: 'button', onclick: () => set({ sort: key, dir: active && S.dir === 'desc' ? 'asc' : key === 'name' ? 'asc' : 'desc' }), text: label }),
    );
  }

  function valueCell(r) {
    return el(
      'td',
      { class: 'value' },
      el('b', { text: money(r.implied_value_usd) }),
      el('small', { text: money(r.implied_low_usd) + ' to ' + money(r.implied_high_usd) }),
      el('div', { class: 'track', 'aria-hidden': 'true' }, el('i', { class: 'hi', style: 'width:' + barWidth(r.implied_high_usd) + '%' }), el('i', { class: 'mid', style: 'width:' + barWidth(r.implied_value_usd) + '%' })),
    );
  }

  function tableRow(r) {
    const open = () => set({ p: r.slug });
    return el(
      'tr',
      { 'aria-selected': S.p === r.slug ? 'true' : 'false', onclick: open },
      el('td', { class: 'rank num', text: r.rank }),
      el(
        'td',
        {},
        el('button', { class: 'name', type: 'button', onclick: (e) => { e.stopPropagation(); open(); }, text: r.name }),
        el('div', { class: 'meta' }, el('span', { class: 'chip', text: r.category || 'Uncategorised' }), r.on_watchlist ? el('span', { class: 'chip watch', text: 'watchlist' }) : null, el('span', { class: 'chip ' + r.confidence, title: r.confidence + ' confidence: ' + r.model.comps + ' comparable' + (r.model.comps === 1 ? '' : 's'), text: 'conf ' + r.confidence })),
      ),
      el('td', { class: 'num', text: money(r.tvl_usd) }),
      el('td', { class: 'num hide-s ' + growthClass(r.change_7d), text: pct(r.change_7d) }),
      el('td', { class: 'num hide-s', text: days(r.age_days) }),
      valueCell(r),
      el('td', { class: 'num hide-s' }, el('div', { text: '~' + money(r.farm.cost_usd) }), el('div', { class: 'muted', text: r.farm.hours + ' h' })),
    );
  }

  function listCard(list) {
    const shown = list.slice(0, S.n);
    const body = shown.length
      ? el('div', { class: 'scroll' }, el('table', {}, el('caption', { text: 'Ranked by implied token value. Select a row for its value build-up and farm plan.' }), el('thead', {}, el('tr', {}, th('#', 'implied', 'num'), th('Protocol', 'name'), th('TVL', 'tvl', 'num'), th('7d TVL', 'growth', 'num hide-s'), th('Tracked', 'age', 'num hide-s'), th('Implied value (low to high)', 'implied'), th('Farm cost', 'cost', 'num hide-s'))), el('tbody', {}, shown.map(tableRow))))
      : el('p', { class: 'empty', text: 'No protocol matches these filters. Clear them to see the whole board.' });
    const more = list.length > shown.length ? el('div', { class: 'more' }, el('button', { class: 'btn', type: 'button', onclick: () => set({ n: S.n + 50 }), text: 'Show 50 more (' + (list.length - shown.length) + ' left)' })) : null;
    return [body, more];
  }

  function renderList() {
    const list = visible();
    const holder = document.getElementById('list');
    if (holder) holder.replaceChildren(...listCard(list).filter(Boolean));
    const count = document.getElementById('count');
    if (count) count.textContent = list.length + ' of ' + rows.length + ' shown';
  }

  // ---------- detail view ----------
  function buildUp(r) {
    const stat = catStat.get(r.category || 'Uncategorised');
    const g = r.model;
    const r1 = r.tvl_usd * g.mcap_to_tvl;
    const r2 = r1 * g.growth_multiplier;
    const r3 = r2 * g.tenure_multiplier;
    const line = (a, b, c, total) => el('tr', { class: total ? 'total' : '' }, el('td', { text: a }), el('td', { text: b }), el('td', { class: 'num', text: c }));
    return el(
      'table',
      { class: 'build' },
      el('caption', { text: 'How the implied value is built, factor by factor' }),
      el('tbody', {}, line('TVL in the snapshot', money(r.tvl_usd), money(r.tvl_usd)),
        line('× market cap per $ of TVL', g.mcap_to_tvl.toFixed(3) + ' (' + (stat ? stat.comps + ' ' + stat.category + ' comps, ' + stat.basis : 'no comps, cautious global 25th pct') + ')', money(r1)),
        line('× TVL momentum', mult(g.growth_multiplier) + ' (' + pct(g.growth_pct) + ' in 7d)', money(r2)),
        line('× time with no token', mult(g.tenure_multiplier) + ' (' + days(r.age_days) + ')', money(r3)),
        line('× chain reach', mult(g.reach_multiplier) + ' (' + r.chains.length + (r.chains.length === 1 ? ' chain)' : ' chains)'), money(r3 * g.reach_multiplier)),
        line('= Implied value', 'range ' + money(r.implied_low_usd) + ' to ' + money(r.implied_high_usd), money(r.implied_value_usd), true)),
    );
  }

  function detail() {
    const r = bySlug.get(S.p);
    if (!r) {
      return el('aside', { class: 'card detail pad', 'aria-label': 'Protocol detail' },
        el('h2', { text: 'Pick a protocol' }),
        el('p', { class: 'note', text: 'Each row opens a detail view: the value build-up, the comparables behind it, and a farm plan with what every step costs and how long it takes.' }),
        el('div', { class: 'section' }, el('h3', { text: 'Reading the board' }),
          el('p', { class: 'note', text: 'Rank 1 has the highest implied token value. The bar shows the estimate against the low and high cases, which come from the 25th and 75th percentile market-cap-to-TVL ratios of live tokens in the same category. Confidence is high with 8 or more comparables, medium with 3 or more.' })));
    }
    const stat = catStat.get(r.category || 'Uncategorised');
    const f = r.farm;
    return el(
      'aside',
      { class: 'card detail', 'aria-label': 'Detail for ' + r.name },
      el('header', {},
        el('div', { class: 'meta' }, el('span', { class: 'chip', text: '#' + r.rank }), el('span', { class: 'chip', text: r.category || 'Uncategorised' }), r.on_watchlist ? el('span', { class: 'chip watch', text: 'watchlist' }) : el('span', { class: 'chip', text: 'beyond the watchlist' }), el('span', { class: 'chip ' + r.confidence, text: r.confidence + ' confidence' })),
        el('h2', { text: r.name }),
        el('div', { class: 'big', text: money(r.implied_value_usd) }),
        el('div', { class: 'range', text: 'implied token value, range ' + money(r.implied_low_usd) + ' to ' + money(r.implied_high_usd) + '. DefiLlama records no token for this protocol.' })),
      el('div', { class: 'section' }, buildUp(r),
        stat && stat.examples.length ? el('p', { class: 'note', text: 'Comparables with a token in this category include ' + stat.examples.join(', ') + '.' }) : el('p', { class: 'note', text: 'No live token shares this category, so it is valued cautiously: the all-category 25th percentile ratio stands in for the median, and the range is wider.' })),
      el('div', { class: 'section' }, el('h3', { text: 'Protocol record' }),
        el('div', { class: 'facts' },
          fact(money(r.tvl_usd), 'TVL'), fact(pct(r.change_7d), '7 day TVL change'), fact(days(r.age_days), 'tracked'),
          fact(r.chains.slice(0, 3).join(', ') + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : ''), 'chains'), fact(r.listed_at || 'unknown', 'listed'), fact(r.slug, 'slug'))),
      el('div', { class: 'section' }, el('h3', { text: 'Farm plan' }),
        el('div', { class: 'facts' }, fact('$' + f.capital_usd, 'capital at work'), fact('~' + money(f.cost_usd), 'gas and carry'), fact(f.hold_days + ' days', 'hold, ' + f.hours + ' h work')),
        el('ol', { class: 'plan' }, r.steps.map(([text, cost, time]) => el('li', {}, el('div', {}, el('div', { text }), el('div', { class: 'cost' }, el('b', { text: 'Cost ' }), cost, ' · ', el('b', { text: 'Time ' }), time)))))),
    );
  }
  const fact = (b, s) => el('div', { class: 'fact' }, el('b', { text: b }), el('span', { text: s }));

  function radarView() {
    const list = visible();
    app.replaceChildren(
      el('div', { class: 'layout' }, el('section', { class: 'card', 'aria-label': 'Ranked board' }, controls(list.length), el('div', { id: 'list' }, ...listCard(list).filter(Boolean))), detail()),
    );
    const count = document.getElementById('count');
    if (count) count.textContent = list.length + ' of ' + rows.length + ' shown';
  }

  // ---------- value model view ----------
  function methodView() {
    const P = D.params;
    const param = (k, v, why) => el('tr', {}, el('td', { text: k }), el('td', { class: 'num', text: v }), el('td', { class: 'muted', text: why }));
    const ratioRows = D.categories.map((c) => el('tr', {}, el('td', { text: c.category }), el('td', { class: 'num', text: c.comps }), el('td', { class: 'num', text: c.median.toFixed(2) }), el('td', { class: 'num', text: c.p25.toFixed(2) + ' to ' + c.p75.toFixed(2) }), el('td', { class: 'num', text: Math.round(c.weight * 100) + '%' }), el('td', { class: 'muted', text: c.examples.join(', ') })));
    app.replaceChildren(
      el('div', { class: 'method' },
        el('section', { class: 'card pad' }, el('h2', { text: 'How the implied value is made' }),
          el('p', { class: 'note', text: 'The question is what a token would be worth if the protocol’s record stayed as it is. The answer comes from the snapshot itself. No protocol is named in the code.' }),
          el('pre', { class: 'formula', text: 'ratio(category) = median(mcap / tvl) of live tokens, shrunk toward the all-category median\nweight = n / (n + ' + P.shrinkK + ')    n = live tokens in the category\ngrowth = 1 + ' + P.growthWeight + ' × clamp(change_7d, ' + P.growthFloor + ', ' + P.growthCap + ') / 100\ntenure = ' + P.tenureFloor + ' + ' + P.tenureRange + ' × min(days tracked, ' + P.tenureCapDays + ') / ' + P.tenureCapDays + '   (unknown: ' + D.neutral_age_days + ' days, the cohort median)\nreach = 1 + ' + P.reachStep + ' × min(chains − 1, ' + P.reachCap + ')\nimplied = TVL × ratio × growth × tenure × reach     low and high use the 25th and 75th percentile ratio' }),
          el('p', { class: 'note', text: 'Pre-token means DefiLlama records no market cap, no CoinGecko id and no symbol. Exchanges, liquid staking, restaking, canonical bridges and versioned pools are left off the board because they wrap or custody a token that lives elsewhere. The 40 watchlist slugs are always on it.' })),
        el('div', { class: 'two' },
          el('section', { class: 'card pad' }, el('h3', { text: 'Constants' }), el('div', { class: 'scroll' }, el('table', { class: 'build' }, el('tbody', {},
            param('shrink K', P.shrinkK, 'comparables needed for a category to count as much as the global median'),
            param('growth weight', P.growthWeight, 'share of the 7 day TVL change passed to value'),
            param('tenure floor and range', P.tenureFloor + ' + ' + P.tenureRange, 'a protocol that has run longer without a token has more users to reward'),
            param('reach step', P.reachStep, 'added per extra chain, up to ' + P.reachCap),
            param('confidence', P.highConfidenceComps + ' / ' + P.mediumConfidenceComps, 'comparables for high and medium'))))),
          el('section', { class: 'card pad' }, el('h3', { text: 'Why the farm plans differ' }),
            el('p', { class: 'note', text: 'A plan follows the category’s playbook (lender, DEX, perp venue, vault, real-world assets, bridge, staking). Capital scales with TVL, gas comes from the cheapest chain the protocol runs on, the hold window is longer for younger protocols, and the weekly TVL change decides whether to move early or size down.' }))),
        el('section', { class: 'card pad' }, el('h3', { text: 'What the market pays per dollar of TVL, by category' }),
          el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Category' }), el('th', { class: 'num', text: 'Live tokens' }), el('th', { class: 'num', text: 'Median ratio' }), el('th', { class: 'num', text: '25th to 75th' }), el('th', { class: 'num', text: 'Own weight' }), el('th', { text: 'Largest' }))), el('tbody', {}, ratioRows))))),
    );
  }

  // ---------- already trading ----------
  function liveView() {
    const body = D.live.map((r) => el('tr', {}, el('td', { text: r.name }), el('td', { class: 'muted', text: r.category || 'Uncategorised' }), el('td', { class: 'num', text: money(r.tvl_usd) }), el('td', { class: 'num', text: money(r.mcap_usd) }), el('td', { class: 'num', text: r.ratio.toFixed(2) }), el('td', { class: 'num ' + growthClass(r.change_7d), text: pct(r.change_7d) })));
    app.replaceChildren(
      el('section', { class: 'card pad' }, el('h2', { text: 'Token already trades' }),
        el('p', { class: 'note', text: 'These protocols record a token, so the market sets their value and the radar does not rank them. They are the comparables: ' + D.counts.live + ' live tokens with a TVL give the market cap per dollar of TVL used on the board. The 40 largest by market cap are shown.' }),
        el('div', { class: 'scroll' }, el('table', {}, el('thead', {}, el('tr', {}, el('th', { text: 'Protocol' }), el('th', { text: 'Category' }), el('th', { class: 'num', text: 'TVL' }), el('th', { class: 'num', text: 'Market cap' }), el('th', { class: 'num', text: 'Cap / TVL' }), el('th', { class: 'num', text: '7d TVL' }))), el('tbody', {}, body)))),
    );
  }

  function render() {
    chrome();
    if (S.view === 'method') methodView();
    else if (S.view === 'live') liveView();
    else radarView();
  }

  window.addEventListener('hashchange', () => { readHash(); render(); });
  readHash();
  render();
})();
