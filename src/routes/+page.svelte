<script lang="ts">
	import Decimal from 'decimal.js';
	import { invalidate } from '$app/navigation';
	import { futuresEvents, futuresStats, inRange } from '$lib/analysis/futures';
	import { buildPortfolio, type Account } from '$lib/analysis/portfolio';
	import { money, pct, qty, tone } from '$lib/format';
	import { computeTax } from '$lib/tax/engine';
	import { FxTable } from '$lib/tax/fx';
	import { PriceTable } from '$lib/tax/prices';
	import { ago, assessSync, berlin } from '$lib/monitor/health';
	import { buildMovements, shortAddr, type Bucket } from '$lib/analysis/transfers';

	let { data } = $props();

	// Bisher ein Broker; die Auswahl ist für weitere vorbereitet
	const brokers = ['Bitget'];
	let broker = $state('Bitget');

	const ACCOUNTS: { key: Account | 'all'; label: string }[] = [
		{ key: 'all', label: 'Alle Konten' },
		{ key: 'spot', label: 'Spot' },
		{ key: 'earn', label: 'Earn' },
		{ key: 'futures', label: 'Futures' }
	];
	let account = $state<Account | 'all'>('all');
	let hideDust = $state(true);
	let refreshing = $state(false);

	const fx = $derived(new FxTable(data.ledger?.fx ?? []));
	const eurPerUsdt = $derived.by(() => {
		const r = fx.last ? fx.rateFor(fx.last) : null;
		return r ? new Decimal(1).div(r.rate) : null;
	});

	// Einstand aus der FIFO-Rechnung über die gesamte Historie
	const priceTable = $derived(new PriceTable(data.ledger?.prices ?? []));
	const tax = $derived(data.ledger && fx.size ? computeTax(data.ledger.ledger, fx, 'all', priceTable) : null);

	const portfolio = $derived(
		data.live
			? buildPortfolio(
					data.live,
					eurPerUsdt,
					tax?.holdingsEnd ?? [],
					new Set(account === 'all' ? (['spot', 'earn', 'futures'] as Account[]) : [account])
				)
			: null
	);
	const rows = $derived(portfolio ? portfolio.rows.filter((r) => !hideDust || (r.valueUsdt?.gte(1) ?? true)) : []);
	const hidden = $derived(portfolio ? portfolio.rows.length - rows.length : 0);

	const unrealized = $derived.by(() => {
		if (!portfolio) return null;
		let sum = new Decimal(0);
		let covered = new Decimal(0);
		for (const r of portfolio.rows) {
			if (r.unrealizedEur && r.coin !== 'USDT') {
				sum = sum.add(r.unrealizedEur);
				covered = covered.add(r.valueUsdt ?? 0);
			}
		}
		return { sum, covered };
	});

	const positions = $derived(data.live?.positions.ok ? data.live.positions.data : []);
	const posUnrealized = $derived(positions.reduce((s, p) => s.add(p.unrealizedPL || 0), new Decimal(0)));

	// Futures-Ergebnis laufender Monat und laufendes Jahr
	const fut = $derived.by(() => {
		if (!data.ledger) return null;
		const ev = futuresEvents(data.ledger.ledger, fx);
		const now = new Date().toISOString().slice(0, 10);
		return {
			month: futuresStats(inRange(ev, now.slice(0, 7) + '-01', now), 'USDT'),
			year: futuresStats(inRange(ev, now.slice(0, 4) + '-01-01', now), 'USDT')
		};
	});

	// Abgleich: Kontosummen laut Bitget vs. was das Cockpit je Konto erfasst
	const ACCOUNT_LABEL: Record<string, string> = {
		spot: 'Spot',
		futures: 'Futures',
		earn: 'Earn',
		funding: 'Funding',
		bots: 'Bots',
		margin: 'Margin',
		crossed_margin: 'Cross Margin',
		isolated_margin: 'Isolated Margin',
		copy_trading: 'Copy-Trading',
		otc: 'OTC',
		p2p: 'P2P'
	};
	const reconcile = $derived.by(() => {
		if (!data.live?.accounts.ok) return null;
		const ours = (acc: Account) => buildPortfolio(data.live!, eurPerUsdt, [], new Set([acc])).totalUsdt;
		const known: Record<string, Decimal> = { spot: ours('spot'), futures: ours('futures'), earn: ours('earn') };
		const rows = data.live.accounts.data
			.map((a) => {
				const bitget = new Decimal(a.usdtBalance || 0);
				const cockpit = known[a.accountType] ?? null;
				return { type: a.accountType, label: ACCOUNT_LABEL[a.accountType] ?? a.accountType, bitget, cockpit, diff: bitget.sub(cockpit ?? 0) };
			})
			.filter((r) => !r.bitget.isZero() || (r.cockpit && !r.cockpit.isZero()));
		const gap = rows.reduce((s, r) => s.add(r.diff.abs()), new Decimal(0));
		return { rows, gap };
	});

	const errors = $derived(
		data.live
			? (
					[
						['Spot', data.live.spot],
						['Earn flexibel', data.live.earnFlex],
						['Earn fest', data.live.earnFixed],
						['Earn-Konto', data.live.earnAccount ?? { ok: true as const, data: [] }],
						['On-Chain-Earn', data.live.elite ?? { ok: true as const, data: [] }],
						['Futures-Konto', data.live.futures],
						['Positionen', data.live.positions],
						['Kurse', data.live.tickers]
					] as const
				).flatMap(([label, s]) => (s.ok ? [] : [`${label}: ${s.error}`]))
			: []
	);

	async function refresh() {
		refreshing = true;
		await invalidate('app:live');
		refreshing = false;
	}

	const D = (s: string) => new Decimal(s || 0);

	const sync = $derived(data.syncRuns ? assessSync(data.syncRuns) : null);

	// Ein- und Auszahlungen / Umbuchungen
	const FILTERS: { key: Bucket | 'all'; label: string }[] = [
		{ key: 'external', label: 'Ein-/Auszahlungen' },
		{ key: 'internal', label: 'Umbuchungen' },
		{ key: 'earn', label: 'Earn' },
		{ key: 'all', label: 'Alle' }
	];
	let moveFilter = $state<Bucket | 'all'>('external');
	let moveLimit = $state(15);
	const movements = $derived(data.ledger ? buildMovements(data.ledger.ledger, data.wallet) : []);
	const movesShown = $derived(moveFilter === 'all' ? movements : movements.filter((m) => m.bucket === moveFilter));
	const pending = $derived(movements.filter((m) => m.status === 'pending'));
	const eurIn = $derived(movements.reduce((s, m) => (m.eur && m.direction === 'in' ? s.add(m.eur) : s), new Decimal(0)));
	const eurOut = $derived(movements.reduce((s, m) => (m.eur && m.direction === 'out' ? s.add(m.eur) : s), new Decimal(0)));
	const DIR = { in: 'Eingang', out: 'Ausgang', move: 'Umbuchung' } as const;
	const STATUS_LABEL = { success: 'erledigt', pending: 'ausstehend', failed: 'fehlgeschlagen' } as const;
</script>

<div class="page-head">
	<h1>Dashboard</h1>
	<div class="toolbar">
		<select bind:value={broker} aria-label="Broker">
			{#each brokers as b (b)}<option>{b}</option>{/each}
		</select>
		<div class="seg" role="group" aria-label="Konto">
			{#each ACCOUNTS as a (a.key)}
				<button aria-pressed={account === a.key} onclick={() => (account = a.key)}>{a.label}</button>
			{/each}
		</div>
		<button class="ghost" onclick={refresh} disabled={refreshing}>{refreshing ? 'Lade …' : 'Aktualisieren'}</button>
	</div>
</div>

{#if sync}
	<p class="sync sync-{sync.level}" title={sync.problems.join('\n')}>
		<span class="dot" aria-hidden="true"></span>
		Täglicher Abruf: zuletzt erfolgreich {berlin(sync.lastSuccess)} ({ago(sync.lastSuccess)})
		{#if sync.level !== 'ok'}· <a href="/system">{sync.problems[0]}</a>{/if}
	</p>
{/if}
{#if data.liveError}<p class="error">Bitget nicht erreichbar: {data.liveError}</p>{/if}
{#if data.ledgerError}<p class="error">{data.ledgerError}</p>{/if}
{#each errors as e (e)}<p class="error small">{e}</p>{/each}

{#if portfolio}
	<div class="kpis">
		<div class="kpi">
			<div class="label">Gesamtwert {account === 'all' ? '' : `· ${ACCOUNTS.find((a) => a.key === account)?.label}`}</div>
			<div class="value">{money(portfolio.totalEur, 'EUR')}</div>
			<div class="sub">{money(portfolio.totalUsdt, 'USDT')}</div>
		</div>
		<div class="kpi">
			<div class="label">Unrealisiert (Coins)</div>
			<div class="value {tone(unrealized?.sum)}">{money(unrealized?.sum ?? null, 'EUR', { sign: true })}</div>
			<div class="sub">für {money(unrealized?.covered ?? null, 'USDT', { digits: 0 })} mit bekanntem Einstand</div>
		</div>
		<div class="kpi">
			<div class="label">Offene Positionen</div>
			<div class="value {tone(posUnrealized)}">{money(posUnrealized, 'USDT', { sign: true })}</div>
			<div class="sub">{positions.length} {positions.length === 1 ? 'Position' : 'Positionen'}</div>
		</div>
		{#if fut}
			<div class="kpi">
				<div class="label">Futures netto · Monat / Jahr</div>
				<div class="value {tone(fut.month.total.net)}">{money(fut.month.total.net, 'USDT', { sign: true })}</div>
				<div class="sub {tone(fut.year.total.net)}">Jahr {money(fut.year.total.net, 'USDT', { sign: true })} · {fut.year.total.trades} Trades</div>
			</div>
		{/if}
	</div>

	<section class="card" style="margin-top:16px">
		<div class="head-row">
			<div class="card-title">Bestände</div>
			<label class="check"><input type="checkbox" bind:checked={hideDust} /> Kleinstbeträge unter 1 USDT ausblenden{hidden ? ` (${hidden})` : ''}</label>
		</div>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Coin</th>
						<th class="num">Menge</th>
						{#if account === 'all'}<th class="num">Spot</th><th class="num">Earn</th><th class="num">Futures</th>{/if}
						<th class="num">Kurs (USDT)</th>
						<th class="num">Wert (EUR)</th>
						<th class="num">Anteil</th>
						<th class="num">Einstand (EUR)</th>
						<th class="num">Unrealisiert</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as r (r.coin)}
						<tr>
							<td><strong>{r.coin}</strong></td>
							<td class="num">{qty(r.qty, 6)}</td>
							{#if account === 'all'}
								<td class="num muted">{r.byAccount.spot.isZero() ? '' : qty(r.byAccount.spot, 6)}</td>
								<td class="num muted">{r.byAccount.earn.isZero() ? '' : qty(r.byAccount.earn, 6)}</td>
								<td class="num muted">{r.byAccount.futures.isZero() ? '' : qty(r.byAccount.futures, 2)}</td>
							{/if}
							<td class="num">{r.price ? qty(r.price, r.price.lt(1) ? 6 : 2) : '–'}</td>
							<td class="num"><strong>{money(r.valueEur, 'EUR')}</strong></td>
							<td class="num muted">{pct(r.share)}</td>
							<td class="num" title={r.costNote ?? ''}>{r.costEur ? money(r.costEur, 'EUR') : '–'}</td>
							<td class="num {tone(r.unrealizedEur)}" title={r.costNote ?? ''}>
								{#if r.unrealizedEur}{money(r.unrealizedEur, 'EUR', { sign: true })}{:else}<span class="note">{r.costNote ? (r.costNote.includes('ohne bekannte') ? 'Einstand teils unbekannt' : r.costNote.startsWith('Historie') ? 'Bestand ≠ Historie' : r.costNote) : '–'}</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if portfolio.unpriced.length}<p class="small muted">Ohne Kurs: {portfolio.unpriced.join(', ')}</p>{/if}
		<p class="small muted">
			Kurse und Bestände live von Bitget ({data.live ? new Date(data.live.at).toLocaleTimeString('de-DE') : ''}). Euro über den letzten EZB-Kurs. Einstand nach FIFO aus der Buchungshistorie – nur angezeigt, wenn die Historie den Bestand vollständig erklärt.
		</p>
	</section>

	{#if reconcile && reconcile.rows.length}
		<section class="card" style="margin-top:16px">
			<div class="card-title">Abgleich mit den Kontosummen von Bitget</div>
			<div class="table-wrap">
				<table>
					<thead><tr><th>Bitget-Konto</th><th class="num">laut Bitget (USDT)</th><th class="num">im Cockpit (USDT)</th><th class="num">Differenz</th></tr></thead>
					<tbody>
						{#each reconcile.rows as r (r.type)}
							{@const off = r.diff.abs().gt(Decimal.max(1, r.bitget.abs().mul('0.01')))}
							<tr>
								<td>{r.label} <span class="muted small">({r.type})</span></td>
								<td class="num">{qty(r.bitget, 2)}</td>
								<td class="num">{r.cockpit ? qty(r.cockpit, 2) : '–'}</td>
								<td class="num {off ? 'loss' : 'muted'}">{off ? qty(r.diff, 2) : 'passt'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="small muted">
				Bitget liefert je Kontotyp einen Gesamtwert. Eine Differenz zeigt, dass ein Teil des Vermögens in einem Bereich liegt, dessen Einzelbestände das Cockpit noch nicht abfragt.
			</p>
		</section>
	{/if}

	{#if positions.length}
		<section class="card" style="margin-top:16px">
			<div class="card-title">Offene Futures-Positionen</div>
			<div class="table-wrap">
				<table>
					<thead><tr><th>Symbol</th><th>Seite</th><th class="num">Größe</th><th class="num">Einstieg</th><th class="num">Mark</th><th class="num">Hebel</th><th class="num">Margin</th><th class="num">Liquidation</th><th class="num">Unrealisiert</th></tr></thead>
					<tbody>
						{#each positions as p (p.symbol + p.holdSide)}
							<tr>
								<td><strong>{p.symbol}</strong></td>
								<td class={p.holdSide === 'long' ? 'gain' : 'loss'}>{p.holdSide === 'long' ? 'Long' : 'Short'}</td>
								<td class="num">{qty(D(p.total), 6)}</td>
								<td class="num">{qty(D(p.openPriceAvg), 6)}</td>
								<td class="num">{qty(D(p.markPrice), 6)}</td>
								<td class="num">{p.leverage}×</td>
								<td class="num">{qty(D(p.marginSize), 2)}</td>
								<td class="num muted">{p.liquidationPrice ? qty(D(p.liquidationPrice), 4) : '–'}</td>
								<td class="num {tone(D(p.unrealizedPL))}">{money(D(p.unrealizedPL), 'USDT', { sign: true })}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
{:else if !data.liveError}
	<p class="muted">Lade Bestände …</p>
{/if}

{#if data.ledger}
	<section class="card" style="margin-top:16px">
		<div class="head-row">
			<div class="card-title">Ein- und Auszahlungen</div>
			<div class="seg" role="group" aria-label="Art der Bewegung">
				{#each FILTERS as f (f.key)}
					<button aria-pressed={moveFilter === f.key} onclick={() => ((moveFilter = f.key), (moveLimit = 15))}>{f.label}</button>
				{/each}
			</div>
		</div>
		{#if (moveFilter === 'external' || moveFilter === 'all') && !eurIn.isZero()}
			<p class="small">
				Euro vom Bankkonto eingezahlt: <strong>{money(eurIn, 'EUR')}</strong>{#if !eurOut.isZero()} · ausgezahlt: <strong>{money(eurOut, 'EUR')}</strong>{/if}
			</p>
		{/if}
		{#if pending.length}
			<p class="small loss">{pending.length} {pending.length === 1 ? 'Bewegung ist' : 'Bewegungen sind'} noch ausstehend.</p>
		{/if}
		{#if data.walletError}<p class="error small">Ein-/Auszahlungsdaten: {data.walletError}</p>{/if}
		{#if movesShown.length}
			<div class="table-wrap">
				<table>
					<thead>
						<tr><th>Zeit</th><th>Art</th><th class="num">Menge</th><th>Coin</th><th>Von → Nach</th><th>Netzwerk</th><th>Adresse / Tx</th><th>Status</th></tr>
					</thead>
					<tbody>
						{#each movesShown.slice(0, moveLimit) as m (m.key)}
							<tr>
								<td class="small nowrap">{berlin(m.ts)}</td>
								<td class={m.direction === 'in' ? 'gain' : m.direction === 'out' ? 'loss' : 'muted'}>{DIR[m.direction]}</td>
								<td class="num">
									{m.direction === 'out' ? '−' : m.direction === 'in' ? '+' : ''}{qty(m.amount, 8)}
									{#if m.eur}<div class="note">{m.direction === 'in' ? 'für' : 'gegen'} {money(m.eur, 'EUR')}</div>{/if}
									{#if m.fee}<div class="note">Gebühr {qty(m.fee, 8)}</div>{/if}
								</td>
								<td><strong>{m.coin}</strong></td>
								<td class="nowrap">{m.from} → {m.to}</td>
								<td class="small">{m.eur ? 'SEPA' : m.viaBitget ? 'Bitget-intern' : (m.chain ?? '')}</td>
								<td class="small mono">
									{#if m.address}<span title={m.address}>{shortAddr(m.address)}</span>{/if}
									{#if m.txHash}<div class="note" title={m.txHash}>Tx {shortAddr(m.txHash)}</div>{/if}
								</td>
								<td class="small {m.status === 'failed' ? 'loss' : m.status === 'pending' ? 'warn' : 'muted'}">{m.status ? STATUS_LABEL[m.status] : ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if movesShown.length > moveLimit}
				<p><button class="ghost" onclick={() => (moveLimit += 25)}>Weitere anzeigen ({movesShown.length - moveLimit})</button></p>
			{/if}
		{:else}
			<p class="muted small">Keine Bewegungen in dieser Auswahl.</p>
		{/if}
		<p class="small muted">
			Aus den Kontobuchungen (CoinTracking-Import und täglicher Bitget-Abruf); Netzwerk, Adresse und Status aus Bitgets
			Ein-/Auszahlungsdaten (rund ein Jahr zurück). Euro-Einzahlungen bucht Bitget direkt als Kauf von USDT/USDC; gezeigt wird der gekaufte Betrag mit dem Euro-Betrag darunter. Umbuchungen zwischen Bitget-Konten sind zu einer Zeile zusammengefasst; „?“
			heißt, die Gegenbuchung ist nicht bekannt. Bitget kennt nur die Adresse, nicht die absendende Börse.
		</p>
	</section>
{/if}

<style>
	.head-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 12px;
		flex-wrap: wrap;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 0;
	}
	.check input {
		width: auto;
	}
	.sync {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		font-size: 0.85rem;
		color: var(--muted);
		margin: -4px 0 12px;
	}
	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--gain);
		flex: none;
	}
	.sync-warn .dot,
	.sync-error .dot {
		background: var(--loss);
	}
	.sync-error {
		color: var(--loss);
	}
	.head-row .seg {
		flex-wrap: wrap;
		max-width: 100%;
	}
	.nowrap {
		white-space: nowrap;
	}
	.mono {
		font-family: var(--mono);
	}
	.warn {
		color: var(--loss);
		font-weight: 600;
	}
	.note {
		font-family: var(--font);
		font-size: 0.8rem;
		color: var(--muted);
	}
</style>
