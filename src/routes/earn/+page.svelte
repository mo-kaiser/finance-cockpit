<script lang="ts">
	import Decimal from 'decimal.js';
	import BarChart from '$lib/components/BarChart.svelte';
	import { EARN_KIND_LABEL, earnEvents, realizedApr, summarizeEarn, type EarnKind } from '$lib/analysis/earn';
	import { buildPortfolio } from '$lib/analysis/portfolio';
	import { MONTHS, money, pct, qty, type Cur } from '$lib/format';
	import { FxTable } from '$lib/tax/fx';

	let { data } = $props();

	const today = new Date().toISOString().slice(0, 10);
	const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

	let period = $state<string>('30');
	let cur = $state<Cur>('EUR');

	const fx = $derived(new FxTable(data.ledger?.fx ?? []));
	const eurPerUsdt = $derived.by(() => {
		const r = fx.last ? fx.rateFor(fx.last) : null;
		return r ? new Decimal(1).div(r.rate) : null;
	});
	const conv = (usdt: Decimal | null) => (usdt === null ? null : cur === 'USDT' ? usdt : eurPerUsdt ? usdt.mul(eurPerUsdt) : null);
	const fmt = (usdt: Decimal | null, sign = false) => money(conv(usdt), cur, { sign });

	const events = $derived(data.ledger ? earnEvents(data.ledger.ledger) : []);
	const years = $derived([...new Set(events.map((e) => e.day.slice(0, 4)))].sort().reverse());

	// heutige Kurse (USDT je Coin)
	const prices = $derived.by(() => {
		const out: Record<string, Decimal> = {};
		if (data.live?.tickers.ok) for (const [c, p] of Object.entries(data.live.tickers.data)) out[c] = new Decimal(p);
		return out;
	});

	const range = $derived.by((): [string, string, number] => {
		if (period === '30') return [daysAgo(29), today, 30];
		if (period === 'gesamt') {
			const first = events[0]?.day ?? today;
			return [first, today, Math.max(1, Math.round((Date.parse(today) - Date.parse(first)) / 86_400_000) + 1)];
		}
		const end = period === today.slice(0, 4) ? today : `${period}-12-31`;
		return [`${period}-01-01`, end, Math.round((Date.parse(end) - Date.parse(`${period}-01-01`)) / 86_400_000) + 1];
	});
	const s = $derived(summarizeEarn(events, range[0], range[1], prices));
	const last30 = $derived(summarizeEarn(events, daysAgo(29), today, prices));
	const last30ByCoin = $derived(new Map(last30.byCoin.map((c) => [c.coin, c])));

	// aktuelle Earn-Bestände (live) und APY laut Bitget
	const holdings = $derived(data.live ? buildPortfolio(data.live, eurPerUsdt, [], new Set(['earn'] as const)) : null);
	const holdingByCoin = $derived(new Map((holdings?.rows ?? []).map((r) => [r.coin, r])));
	const apyByCoin = $derived.by(() => {
		const m = new Map<string, string>();
		const live = data.live;
		if (!live) return m;
		for (const sec of [live.earnFlex, live.earnFixed]) if (sec.ok) for (const e of sec.data) if (e.apy && !m.has(e.coin)) m.set(e.coin, e.apy);
		if (live.elite?.ok) for (const e of live.elite.data) if (e.apr && !m.has(e.coin)) m.set(e.coin, e.apr);
		return m;
	});

	// Coins: Erträge im Zeitraum, ergänzt um gehaltene Coins ohne Erträge
	const coins = $derived.by(() => {
		const list = s.byCoin.map((c) => c.coin);
		for (const r of holdings?.rows ?? []) if (!list.includes(r.coin) && (r.valueUsdt?.gte(1) ?? false)) list.push(r.coin);
		return list;
	});

	const perDay = $derived(s.totalUsdt.div(range[2]));
	const realized30Total = $derived(
		holdings && !holdings.totalUsdt.isZero() ? last30.totalUsdt.div(holdings.totalUsdt).mul(365).div(30).toNumber() : null
	);
	const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]!.slice(0, 3)} ${m.slice(2, 4)}`;
	const fmtAxis = (v: number) => (cur === 'EUR' ? `${v.toLocaleString('de-DE', { maximumFractionDigits: 0 })} €` : v.toLocaleString('de-DE', { maximumFractionDigits: 0 }));
	const KINDS: EarnKind[] = ['zinsen', 'airdrop', 'bonus'];
</script>

<div class="page-head">
	<h1>Earn</h1>
	<div class="toolbar">
		<div class="seg" role="group" aria-label="Zeitraum">
			<button aria-pressed={period === '30'} onclick={() => (period = '30')}>30 Tage</button>
			{#each years as y (y)}<button aria-pressed={period === y} onclick={() => (period = y)}>{y}</button>{/each}
			<button aria-pressed={period === 'gesamt'} onclick={() => (period = 'gesamt')}>Gesamt</button>
		</div>
		<div class="seg" role="group" aria-label="Währung">
			<button aria-pressed={cur === 'EUR'} onclick={() => (cur = 'EUR')}>EUR</button>
			<button aria-pressed={cur === 'USDT'} onclick={() => (cur = 'USDT')}>USDT</button>
		</div>
	</div>
</div>

{#if data.ledgerError}<p class="error">{data.ledgerError}</p>{/if}
{#if data.liveError}<p class="error small">Bitget nicht erreichbar: {data.liveError}</p>{/if}

<div class="kpis">
	<div class="kpi">
		<div class="label">Erträge im Zeitraum</div>
		<div class="value gain">{fmt(s.totalUsdt, true)}</div>
		<div class="sub">{s.bookings.toLocaleString('de-DE')} Gutschriften · zum heutigen Kurs</div>
	</div>
	<div class="kpi">
		<div class="label">Ø pro Tag</div>
		<div class="value">{fmt(perDay)}</div>
		<div class="sub">≈ {fmt(perDay.mul(30))} im Monat</div>
	</div>
	<div class="kpi">
		<div class="label">Earn-Bestand jetzt</div>
		<div class="value">{fmt(holdings?.totalUsdt ?? null)}</div>
		<div class="sub">{holdings?.rows.length ?? 0} Positionen</div>
	</div>
	<div class="kpi">
		<div class="label">Rendite der letzten 30 Tage</div>
		<div class="value">{pct(realized30Total)}</div>
		<div class="sub">p. a., Erträge ÷ heutiger Bestand</div>
	</div>
</div>

{#if s.byMonth.length > 1}
	<section class="card" style="margin-top:16px">
		<div class="card-title">Erträge je Monat (zum heutigen Kurs)</div>
		<BarChart labels={s.byMonth.map((m) => monthLabel(m.month))} values={s.byMonth.map((m) => conv(m.valueUsdt)?.toNumber() ?? 0)} format={fmtAxis} />
	</section>
{/if}

<section class="card" style="margin-top:16px">
	<div class="card-title">Coins</div>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>Coin</th>
					<th class="num">Erträge (Menge)</th>
					<th class="num">Wert heute</th>
					<th class="num">Anteil</th>
					<th class="num">Gutschriften</th>
					<th class="num">Earn-Bestand</th>
					<th class="num">Rendite 30 T. p. a.</th>
					<th class="num">APY laut Bitget</th>
				</tr>
			</thead>
			<tbody>
				{#each coins as coin (coin)}
					{@const c = s.byCoin.find((x) => x.coin === coin)}
					{@const h = holdingByCoin.get(coin)}
					{@const l30 = last30ByCoin.get(coin)}
					{@const apr = h && l30 ? realizedApr(l30.qty, h.qty, 30) : null}
					{@const apy = apyByCoin.get(coin)}
					<tr>
						<td><strong>{coin}</strong></td>
						<td class="num">{c ? qty(c.qty, 6) : '–'}</td>
						<td class="num gain">{c ? fmt(c.valueUsdt) : '–'}</td>
						<td class="num muted">{c?.valueUsdt && !s.totalUsdt.isZero() ? pct(c.valueUsdt.div(s.totalUsdt).toNumber()) : ''}</td>
						<td class="num muted">{c ? c.bookings.toLocaleString('de-DE') : ''}</td>
						<td class="num">{h ? qty(h.qty, 6) : ''}</td>
						<td class="num">{pct(apr, 2)}</td>
						<td class="num muted">{apy ? `${Number(apy).toLocaleString('de-DE', { maximumFractionDigits: 2 })} %` : ''}</td>
					</tr>
				{:else}
					<tr><td colspan="8" class="muted">Keine Erträge im Zeitraum.</td></tr>
				{/each}
			</tbody>
		</table>
	</div>
	{#if s.unpricedCoins.length}<p class="small muted">Ohne aktuellen Kurs (nicht im Wert enthalten): {s.unpricedCoins.join(', ')}</p>{/if}
</section>

<div class="grid-2" style="margin-top:16px">
	<section class="card">
		<div class="card-title">Nach Art</div>
		<table>
			<tbody>
				{#each KINDS as k (k)}
					<tr>
						<td>{EARN_KIND_LABEL[k]}</td>
						<td class="num">{fmt(s.byKind[k])}</td>
						<td class="num muted">{!s.totalUsdt.isZero() ? pct(s.byKind[k].div(s.totalUsdt).toNumber(), 0) : ''}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</section>

	<section class="card">
		<div class="card-title">So sind die Zahlen zu lesen</div>
		<ul class="small muted">
			<li>Erträge sind alle Earn-Gutschriften (Zinsen, Staking, Airdrops, Boni) aus CoinTracking und dem täglichen Bitget-Abruf.</li>
			<li>Bewertet wird mit dem <strong>heutigen</strong> Kurs. Der Wert am Tag des Zuflusses – maßgeblich für die Steuer – folgt mit den Tageskursen.</li>
			<li>Die Rendite der letzten 30 Tage teilt die Erträge durch den heutigen Bestand; wurde im Zeitraum viel ein- oder ausgezahlt, ist sie nur eine Näherung.</li>
		</ul>
	</section>
</div>
