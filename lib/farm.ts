// Farm plans: how a reader positions in a protocol that records no token yet.
//
// A plan is derived from the protocol's own row (category, chains, TVL, seven-day TVL change, tracked
// age), never from a list of names. Every step carries the action, what it costs and how long it takes.
// Costs are estimates in US dollars: gas by chain from the table below, capital by the protocol's size.

import type { Protocol } from './model.ts';

export interface Step {
  text: string;
  cost: string;
  time: string;
}

export interface Plan {
  steps: Step[];
  capital_usd: number;
  gas_usd: number;
  carry_usd: number;
  cost_usd: number;
  hours: number;
  hold_days: number;
  chain: string;
}

/** Typical cost of one swap or deposit transaction by chain, in whole cents of a dollar. */
const GAS_CENTS: Record<string, number> = {
  Ethereum: 600,
  Arbitrum: 15,
  Base: 5,
  Optimism: 8,
  Polygon: 3,
  BSC: 15,
  Avalanche: 10,
  Solana: 2,
  Sui: 2,
  Tron: 100,
  Monad: 2,
  'Hyperliquid L1': 1,
  Plasma: 1,
  Ripple: 1,
  Bitcoin: 300,
};
const DEFAULT_GAS_CENTS = 100;

/** The chain the plan uses: the cheapest one the protocol runs on, Ethereum when nothing else is known. */
export function planChain(p: Protocol): string {
  const usable = p.chains.filter((c) => c !== 'Bitcoin' && c !== 'Ripple' && c !== 'Binance');
  const pool = usable.length > 0 ? usable : p.chains;
  if (pool.length === 0) return 'Ethereum';
  return [...pool].sort((a, b) => gasCents(a) - gasCents(b) || (a < b ? -1 : 1))[0]!;
}

export const gasCents = (chain: string): number => GAS_CENTS[chain] ?? DEFAULT_GAS_CENTS;

/** Capital for one position, from the protocol's TVL: larger protocols take a larger sybil-safe stake. */
export function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 300;
  if (tvl >= 250_000_000) return 200;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 50_000_000) return 100;
  return 50;
}

/** Days to hold: a younger protocol has had fewer snapshots, so the window is longer. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 120) return 75;
  if (age < 365) return 60;
  return 45;
}

type Family = 'lend' | 'dex' | 'perp' | 'vault' | 'rwa' | 'bridge' | 'stake' | 'generic';

/** The playbook a category follows. */
export function familyOf(category: string | null): Family {
  const c = (category ?? '').toLowerCase();
  if (/lend|cdp|borrow|curator|allocator|money market/.test(c)) return 'lend';
  if (/dex|liquidity manager|amm|launchpad/.test(c)) return 'dex';
  if (/deriv|perp|option|prediction/.test(c)) return 'perp';
  if (/yield|farm|basis|vault|index|aggregator/.test(c)) return 'vault';
  if (/rwa|treasury|real world/.test(c)) return 'rwa';
  if (/bridge/.test(c)) return 'bridge';
  if (/stak|restak|chain|node/.test(c)) return 'stake';
  return 'generic';
}

const usd = (n: number): string => (n >= 10 ? `$${Math.round(n)}` : `$${n.toFixed(2).replace(/\.?0+$/, '')}`);
const gasUsd = (cents: number, txs: number): string => usd((cents * txs) / 100);

/** One step, kept inside the gate's 20 to 600 characters once cost and time are appended. */
function step(text: string, cost: string, time: string): Step {
  return { text, cost, time };
}

/** The plan for one protocol. */
export function planFor(p: Protocol, age: number | null, growthPct: number): Plan {
  const chain = planChain(p);
  const cents = gasCents(chain);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const family = familyOf(p.category);
  const name = p.name;
  const weeks = Math.ceil(hold / 7);
  const weekly = family === 'perp' ? 3 : 2;
  const setupTxs = 4;
  const gasTotalCents = cents * (setupTxs + weeks * weekly + 2);
  const gas = gasTotalCents / 100;
  const carry = Math.round(capital * 0.05 * (hold / 365) * 100) / 100;

  const core = coreAction(family, name, chain, capital, cents);
  const repeat = repeatAction(family, name, weekly, cents);
  const steps: Step[] = [
    step(
      `Make a fresh wallet used only for ${name}, fund it with ${usd(capital)} plus gas on ${chain}, and keep the seed phrase offline. One wallet per protocol keeps the activity readable to the team.`,
      `${gasUsd(cents, 1)} to move funds in`,
      '10 minutes',
    ),
    core,
    repeat,
    step(
      `Add a second kind of action in week two or three, so the wallet shows more than one habit: ${secondAction(family, name)}`,
      `${gasUsd(cents, 2)} of gas`,
      '15 minutes',
    ),
    step(
      `Hold the position for ${hold} days (${weeks} weeks) so it lands in several snapshots. ${tenureNote(age)}`,
      `about ${usd(carry)} of opportunity cost on ${usd(capital)} at 5% a year`,
      `${hold} days, 5 minutes a week`,
    ),
    step(growthNote(growthPct, name), 'free to read, no transaction', '10 minutes'),
    step(
      `Check ${name}'s own site and docs once a week for a points page, a season announcement or a snapshot date, and read the official account only. Ignore every direct message and every link that offers an early claim.`,
      'free; never pay to claim',
      '10 minutes a week',
    ),
    step(
      `Keep a log of the wallet, dates and each transaction hash, then withdraw the position when the window ends or the protocol announces a token, whichever comes first. Move the funds out before connecting the wallet to any claim page.`,
      `${gasUsd(cents, 2)} of gas to exit`,
      '15 minutes',
    ),
  ];
  const hours = Math.round((10 + 10 + weeks * 0.2 * 60 + 15 + 15 + 10 + weeks * 10 + 15) / 6) / 10;
  return {
    steps,
    capital_usd: capital,
    gas_usd: Math.round(gas * 100) / 100,
    carry_usd: carry,
    cost_usd: Math.round((gas + carry) * 100) / 100,
    hours,
    hold_days: hold,
    chain,
  };
}

function coreAction(family: Family, name: string, chain: string, capital: number, cents: number): Step {
  const amt = usd(capital);
  const gas = `${gasUsd(cents, 3)} of gas, ${amt} of capital that stays yours`;
  switch (family) {
    case 'lend':
      return step(`Supply ${amt} of a stablecoin to ${name} on ${chain} as collateral, borrow about 30% of it against the position, then repay part of the loan. A deposit plus a borrow plus a repay is the usage a lender rewards.`, gas, '20 minutes');
    case 'dex':
      return step(`Swap ${usd(capital / 2)} of a stablecoin for the pair's other asset on ${name} (${chain}), then add both sides as liquidity in the main pool and keep the receipt token. Volume and liquidity are the two counts a DEX rewards.`, gas, '20 minutes');
    case 'perp':
      return step(`Deposit ${amt} of USDC as margin on ${name} (${chain}), open one small long at 2x or less, close it, and leave the rest as margin. Keep size low: a perp venue rewards activity, and you only risk the margin.`, gas, '25 minutes');
    case 'vault':
      return step(`Deposit ${amt} of the vault's base asset into ${name} on ${chain} and keep the share token in the same wallet. Check the vault's strategy page first and skip any vault that cannot be withdrawn on demand.`, gas, '15 minutes');
    case 'rwa':
      return step(`Complete ${name}'s onboarding if it asks for one, mint ${amt} of its yield-bearing asset on ${chain} and hold it. Real-world-asset products often reward holders by balance and time, so the position size matters less than the dates.`, gas, '30 minutes, longer if identity checks apply');
    case 'bridge':
      return step(`Bridge ${amt} of USDC into ${chain} through ${name}, use the bridged funds once in an app on that chain, then bridge a small part back. Bridges tend to count routes used and volume moved.`, `${gasUsd(cents, 3)} of gas plus the bridge fee, about 0.1% of ${amt}`, '25 minutes');
    case 'stake':
      return step(`Stake ${amt} of the supported asset through ${name} on ${chain} and keep the receipt in the wallet. Check the unbonding period first, since it sets how fast you can leave.`, gas, '15 minutes');
    default:
      return step(`Deposit ${amt} of USDC into ${name} on ${chain}, make one of the protocol's main actions with it and keep the position open. Read its docs first and use the action it names as its core product.`, gas, '20 minutes');
  }
}

function repeatAction(family: Family, name: string, perWeek: number, cents: number): Step {
  const text: Record<Family, string> = {
    lend: `Each week, top up or repay a small amount on ${name} (a few dollars) and claim any incentive, ${perWeek} transactions in all. Regular small activity beats one large deposit.`,
    dex: `Each week, make ${perWeek} small swaps through ${name} and re-balance the liquidity position once. Steady volume across weeks is what a DEX counts.`,
    perp: `Each week, open and close ${perWeek} small trades on ${name} at 2x leverage or less, on a different day each time. Spread the days instead of batching.`,
    vault: `Each week, check the vault's yield on ${name}, compound once if it pays rewards, and add a few dollars when you can. Do ${perWeek} transactions a week at most.`,
    rwa: `Each month, verify the position on ${name}, claim any yield it distributes and keep the balance unchanged. A small top-up on the same day each month is enough.`,
    bridge: `Each week, route one small transfer through ${name}'s bridge in each direction, ${perWeek} transactions a week. Use more than one route if it offers them.`,
    stake: `Each week, claim and restake rewards on ${name} if it supports it, ${perWeek} transactions a week, and vote if the protocol has governance.`,
    generic: `Each week, repeat one of ${name}'s main actions with a small amount, ${perWeek} transactions a week. Vary the day so the history looks like a person's.`,
  };
  return step(text[family], `${gasUsd(cents, perWeek)} a week`, '10 minutes a week');
}

function secondAction(family: Family, name: string): string {
  switch (family) {
    case 'lend':
      return `use the supplied asset in a second market on ${name}, or vote in its governance.`;
    case 'dex':
      return `use a second pool on ${name}, or set a limit order if it has one.`;
    case 'perp':
      return `place a different order type on ${name}, or deposit into its liquidity vault.`;
    case 'vault':
      return `move half the position to a second vault on ${name}, so the wallet shows a choice and not a single deposit.`;
    case 'rwa':
      return `redeem a very small amount on ${name} and mint it again, which tests the exit path.`;
    case 'bridge':
      return `use a second route or token on ${name}.`;
    case 'stake':
      return `use a second validator or pool on ${name}.`;
    default:
      return `try a second product on ${name}, or join its governance forum.`;
  }
}

function tenureNote(age: number | null): string {
  if (age === null) return 'The snapshot gives no listing date, so the plan assumes a mid-aged protocol.';
  if (age < 120) return `It is only ${age} days old, so early users weigh the most and the window runs longer.`;
  if (age < 365) return `It has run ${age} days with no token, so a team still has time to announce one.`;
  return `It has run ${age} days with no token, so expect a crowded farm and rewards weighted to long-time users.`;
}

function growthNote(growthPct: number, name: string): string {
  const g = Math.round(growthPct * 10) / 10;
  if (g >= 15) return `${name}'s TVL rose ${g}% in seven days, which often means an incentive push is live. Move early and watch whether the TVL holds. A fall back means the push is ending.`;
  if (g <= -10) return `${name}'s TVL fell ${Math.abs(g)}% in seven days. Confirm there is no exploit or depeg in the news first, and size the position at half the amount above until it steadies.`;
  return `${name}'s TVL moved ${g}% in seven days, a steady week. Track the TVL on the aggregator once a week: a jump of 15% or more is the sign to add capital.`;
}

/** A step as the single string the board carries: action, cost, time. */
export function stepString(s: Step): string {
  let out = `${s.text} Cost: ${s.cost}. Time: ${s.time}.`;
  if (out.length > 600) out = `${out.slice(0, 596)}...`;
  return out;
}
