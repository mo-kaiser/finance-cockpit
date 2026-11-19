<script lang="ts">
	import Decimal from 'decimal.js';
	import { invalidate } from '$app/navigation';
	import { onChainStaked, reconcile } from '#lib/analysis/reconcile.ts';
	import { clearLedgerCache, berlinDay } from '#lib/data/ledger.ts';
	import { money, qty } from '#lib/format.ts';
	import { asset, USD_STABLE } from '#lib/tax/assets.ts';
	import { computeTax } from '#lib/tax/engine.ts';
	import { FxTable } from '#lib/tax/fx.ts';
	import { PriceTable } from '#lib/tax/prices.ts';

	let { data } = $props();

	const fx = $derived(new FxTable(data.ledger?.fx ?? []));
	const priceTable = $derived(new PriceTable(data.ledger?.prices ?? []));
	const tax = $derived(data.ledger && fx.size ? computeTax(data.ledger.ledger, fx, 'all', priceTable) : null);
	// Abgleich je Börse (FIFO wird je Börse geführt)
	type V = 'bitget' | 'kucoin';
	const venues = $derived<V[]>(data.kucoin ? ['bitget', 'kucoin'] : ['bitget']);
	let view = $state<V>('bitget');
	const liveV = $derived(view === 'kucoin' ? data.kucoin : data.live);
	const rows = $derived(
		tax && liveV && data.ledger
			? reconcile(
					liveV,
					tax.holdingsByVenue[view],
					view === 'bitget' ? onChainStaked(data.ledger.ledger, data.live ?? undefined) : new Set(),
					1,
					// Coins ohne Live-Kurs (nicht mehr gehalten): Wert über den letzten Tageskurs
					(coin) => {
						const r = priceTable.range(coin);
						return r ? (priceTable.closeFor(coin, r.last)?.close ?? null) : null;
					}
				)
			: []
	);

	/** Verkäufe/Abgänge ohne Kauf in den Daten (Fehlbestand) – meist Bestände von vor Beginn der Historie */
	const shortfalls = $derived.by(() => {
		if (!tax) return [];
		const m = new Map<string, { venue: V; coin: string; qty: Decimal; first: string; n: number }>();
		const add = (venue: V, coin: string, q: Decimal, day: string) => {
			const k = `${venue}|${coin}`;
			const r = m.get(k) ?? { venue, coin, qty: new Decimal(0), first: day, n: 0 };
			r.qty = r.qty.add(q);
			if (day < r.first) r.first = day;
			r.n++;
			m.set(k, r);
		};
		for (const d of tax.disposals) for (const p of d.portions) if (p.acquiredDay === null) add(d.venue as V, d.asset, p.qty, d.day);
		for (const w of tax.warnings) if (w.kind === 'consume_shortfall' && w.asset && w.qty) add((w.venue ?? 'bitget') as V, w.asset, w.qty, w.day);
		// Steuerlich relevant ab 2026; Stablecoins (Futures-Verluste am Anfang der Historie) und Kleinstbeträge ausblenden
		return [...m.values()]
			.filter((f) => showOldShortfalls || f.first >= '2026-01-01')
			.filter((f) => !USD_STABLE.has(f.coin))
			.filter((f) => {
				const v = priceTable.valueUsdt(f.coin, f.qty, f.first);
				return v === null || v.gte(1);
			})
			.sort((a, b) => a.first.localeCompare(b.first));
	});
	let showOldShortfalls = $state(false);
	const VNAME: Record<V, string> = { bitget: 'Bitget', kucoin: 'KuCoin' };
	const openings = $derived(data.ledger?.openings ?? []);

	/** Erster Tag der Historie (ohne nachgetragene Anfangsbestände) = Standard-Kaufdatum */
	const historyStart = $derived.by(() => {
		let min = '';
		for (const e of data.ledger?.ledger ?? []) if (!e.tx_id.startsWith('manual:') && (!min || e.day < min)) min = e.day;
		return min || '2023-01-01';
	});

	/** Letzter Buchungstag je Börse und Coin (ohne Nachträge): frühestes Datum für Ausbuchung/Umstellung */
	const lastDay = $derived.by(() => {
		const m = new Map<string, string>();
		for (const e of data.ledger?.ledger ?? []) {
			if (e.tx_id.startsWith('manual:')) continue;
			const v = e.exchange.toLowerCase().startsWith('kucoin') ? 'kucoin' : 'bitget';
			for (const c of [e.buy_cur, e.sell_cur]) {
				if (!c) continue;
				const k = `${v}|${asset(c)}`;
				if (e.day > (m.get(k) ?? '')) m.set(k, e.day);
			}
		}
		return m;
	});
	const lastOf = (v: V, c: string) => lastDay.get(`${v}|${c.trim().toUpperCase()}`) ?? '';

	// Formular: Anfangsbestand, Ausbuchung oder Token-Umstellung
	type Mode = 'opening_balance' | 'write_off' | 'token_swap';
	const MODE_LABEL: Record<Mode, string> = { opening_balance: 'Anfangsbestand', write_off: 'Ausbuchung', token_swap: 'Token-Umstellung' };
	let mode = $state<Mode>('opening_balance');
	let toCoin = $state('');
	let toAmount = $state('');
	const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
	let venue = $state<V>('bitget');
	let coin = $state('');
	let amount = $state('');
	let date = $state('');
	let cost = $state('');
	let note = $state('');
	let busy = $state(false);
	let msg = $state('');
	let err = $state('');

	function take(r: { coin: string; gap: Decimal }, v: V = view, m: Mode = 'opening_balance') {
		mode = m;
		venue = v;
		coin = r.coin;
		amount = r.gap.abs().toString();
		date = m === 'opening_balance' ? '' : lastOf(v, r.coin);
		cost = '';
		toCoin = toAmount = '';
		note = m === 'opening_balance' ? `Bestand vor Beginn der Historie (Abgleich mit ${VNAME[v]})` : '';
		msg = '';
		err = '';
		document.getElementById('form')?.scrollIntoView({ behavior: 'smooth' });
	}

	const num = (s: string) => s.trim().replace(/\./g, '').replace(',', '.');

	async function save(e: SubmitEvent) {
		e.preventDefault();
		err = '';
		msg = '';
		const c = coin.trim().toUpperCase();
		const tc = toCoin.trim().toUpperCase();
		const dec = (s: string) => new Decimal(s.includes(',') ? num(s) : s.trim());
		let a: Decimal, k: Decimal | null, ta: Decimal | null;
		try {
			// Eingabe mit Komma oder Punkt als Dezimaltrennzeichen
			a = dec(amount);
			k = mode === 'opening_balance' && cost.trim() ? dec(cost) : null;
			ta = mode === 'token_swap' ? dec(toAmount || '0') : null;
		} catch {
			err = 'Menge oder Kosten sind keine gültige Zahl.';
			return;
		}
		if (!/^[A-Z0-9]{1,20}$/.test(c)) return void (err = 'Bitte einen Coin wie BGB oder ETH angeben.');
		if (a.lte(0)) return void (err = 'Die Menge muss größer als 0 sein.');
		if (k && k.lt(0)) return void (err = 'Kosten dürfen nicht negativ sein.');
		if (mode !== 'opening_balance' && !date) return void (err = 'Bitte das Datum angeben (ungefähr reicht).');
		const last = lastOf(venue, c);
		if (mode !== 'opening_balance' && last && date < last)
			return void (err = `${c} hat bei ${VNAME[venue]} noch Buchungen bis ${dateDe(last)}. Das Datum muss an oder nach diesem Tag liegen, sonst bleibt ein Rest stehen.`);
		if (mode === 'token_swap') {
			if (!/^[A-Z0-9]{1,20}$/.test(tc) || tc === c) return void (err = 'Bitte den neuen Coin angeben, z. B. S.');
			if (!ta || ta.lte(0)) return void (err = 'Bitte die Menge des neuen Coins angeben.');
		}
		const day = date || historyStart;
		busy = true;
		const defaultNote =
			mode === 'write_off' ? 'Ausbuchung (Delisting)' : mode === 'token_swap' ? `Token-Umstellung ${c} → ${tc}` : 'Anfangsbestand';
		const { error } = await data.supabase.from('manual_adjustments').insert({
			// Anfangsbestand: Mittag UTC (sicher derselbe Berliner Tag). Ausbuchung/Umstellung: Tagesende
			// (21:59 UTC = 22:59/23:59 Berlin), damit alle Buchungen dieses Tages vorher verarbeitet sind.
			ts: new Date(`${day}T${mode === 'opening_balance' ? '12:00' : '21:59'}:00Z`).toISOString(),
			venue,
			asset: c,
			amount: a.toString(),
			cost_eur: k ? k.toString() : null,
			kind: mode,
			...(mode === 'token_swap' ? { to_asset: tc, to_amount: ta!.toString() } : {}),
			note:
				mode === 'opening_balance'
					? [note.trim() || defaultNote, date ? '' : '(Kaufdatum unbekannt)', k ? '' : '(Kosten = Tageswert, geschätzt)'].filter(Boolean).join(' ')
					: note.trim() || defaultNote
		});
		if (error) {
			busy = false;
			err = `Speichern fehlgeschlagen: ${error.message}`;
			return;
		}
		// Ohne Kosten wird der Tageswert gebraucht: Kurse ab dem Kaufdatum sicherstellen
		if (mode === 'opening_balance' && !k && !USD_STABLE.has(c)) {
			msg = `${c}: lade Tageskurse ab ${day} …`;
			await fetch('/api/prices/sync', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ coin: c, from: day })
			}).catch(() => null);
		}
		msg =
			mode === 'token_swap'
				? `Token-Umstellung ${qty(a)} ${c} → ${qty(ta!)} ${tc} (${VNAME[venue]}) gespeichert.`
				: `${MODE_LABEL[mode]} ${qty(a)} ${c} (${VNAME[venue]}) gespeichert.`;
		coin = amount = date = cost = note = toCoin = toAmount = '';
		clearLedgerCache();
		await invalidate('app:korrekturen');
		busy = false;
	}

	async function remove(id: string, label: string) {
		err = '';
		msg = '';
		const { error } = await data.supabase.from('manual_adjustments').delete().eq('id', id);
		if (error) return void (err = `Löschen fehlgeschlagen: ${error.message}`);
		msg = `${label} gelöscht.`;
		clearLedgerCache();
		await invalidate('app:korrekturen');
	}

	const dateDe = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('de-DE');
</script>

<h1>Korrekturen</h1>
<p class="muted">
	Nachträge für das, was in den Buchungen fehlt. Zuerst der <strong>Anfangsbestand</strong>: Coins, die du schon vor Beginn
	der Historie ({dateDe(historyStart)}) bei einer Börse hattest. Sie fließen in Dashboard und Steuer ein wie ein Kauf.
</p>

{#if data.ledgerError}<p class="error">{data.ledgerError}</p>{/if}

<section class="card">
	<div class="head-row">
		<div class="card-title">Abgleich: {VNAME[view]} gegen Buchungen</div>
		{#if venues.length > 1}
			<div class="seg" role="group" aria-label="Börse">
				{#each venues as v (v)}<button aria-pressed={view === v} onclick={() => (view = v)}>{VNAME[v]}</button>{/each}
			</div>
		{/if}
	</div>
	{#if view === 'bitget' && data.liveError}
		<p class="error small">Bitget-Bestände nicht geladen: {data.liveError}</p>
	{:else if view === 'kucoin' && data.kucoinError}
		<p class="error small">KuCoin-Bestände nicht geladen: {data.kucoinError}</p>
	{:else if !tax || !liveV}
		<p class="muted small">Lade …</p>
	{:else if !rows.length}
		<p class="ok">Alle {VNAME[view]}-Bestände (ab 1 USDT) sind durch die Buchungen erklärt.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Coin</th><th class="num">bei {VNAME[view]}</th><th class="num">aus Buchungen</th><th class="num">Differenz</th><th class="num">Wert (USDT)</th><th>Einschätzung</th><th></th></tr>
				</thead>
				<tbody>
					{#each rows as r (r.coin)}
						<tr>
							<td><strong>{r.coin}</strong></td>
							<td class="num">{qty(r.live, 6)}</td>
							<td class="num">{qty(r.booked, 6)}</td>
							<td class="num {r.gap.gt(0) ? 'gain' : 'loss'}">{r.gap.gt(0) ? '+' : ''}{qty(r.gap, 6)}</td>
							<td class="num">{r.gapUsdt ? money(r.gapUsdt.abs(), 'USDT') : '–'}</td>
							<td class="small">
								{#if r.gap.lt(0)}Buchungen zeigen mehr als {VNAME[view]} – evtl. fehlt ein Abgang (z. B. Token-Umstellung, Delisting)
								{:else if r.onChain}Im On-Chain-Staking: noch nicht ausgezahlte Erträge – <strong>nicht</strong> nachtragen, sie werden bei der Auszahlung gebucht
								{:else}Kauf vor Beginn der Historie?{/if}
							</td>
							<td>
								{#if r.gap.gt(0) && !r.onChain}<button class="ghost" onclick={() => take(r)}>Übernehmen</button>
								{:else if r.gap.lt(0)}<button class="ghost" onclick={() => take(r, view, 'write_off')}>Abgang eintragen</button>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="small muted">
			„Aus Buchungen“ ist der Bestand laut Historie einschließlich bereits nachgetragener Anfangsbestände. Kleine Abweichungen
			unter 1 USDT sind ausgeblendet.
		</p>
	{/if}
</section>

{#if shortfalls.length || showOldShortfalls}
	<section class="card" style="margin-top:16px">
		<div class="head-row">
			<div class="card-title">Verkauft, aber nicht gekauft</div>
			<label class="small"><input type="checkbox" bind:checked={showOldShortfalls} /> auch vor 2026</label>
		</div>
		<p class="small muted">
			Abgänge, für die es in den Buchungen keinen Kauf gibt – meist Bestände von vor Beginn der Historie. Ohne Nachtrag ist
			der Gewinn unbekannt (Status „Fehlbestand“ auf der Steuer-Seite). Mit Anfangsbestand gilt der Beginn der Historie als
			Kaufdatum; liegt der Kauf über ein Jahr vor dem Verkauf, ist er steuerfrei.
		</p>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Börse</th><th>Coin</th><th class="num">Menge ohne Kauf</th><th>erster Abgang</th><th></th></tr></thead>
				<tbody>
					{#each shortfalls as f (f.venue + f.coin)}
						<tr>
							<td>{VNAME[f.venue]}</td>
							<td><strong>{f.coin}</strong></td>
							<td class="num">{qty(f.qty, 8)}</td>
							<td class="small">{dateDe(f.first)}</td>
							<td><button class="ghost" onclick={() => take({ coin: f.coin, gap: f.qty }, f.venue)}>Nachtragen</button></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}

<section class="card" id="form" style="margin-top:16px">
	<div class="head-row">
		<div class="card-title">Nachtragen</div>
		<div class="seg" role="group" aria-label="Art">
			{#each Object.keys(MODE_LABEL) as Mode[] as m (m)}<button type="button" aria-pressed={mode === m} onclick={() => (mode = m)}>{MODE_LABEL[m]}</button>{/each}
		</div>
	</div>
	<p class="small muted" style="margin-top:4px">
		{#if mode === 'opening_balance'}Coins, die du vor Beginn der Historie gekauft hast. Zählen wie ein Kauf.
		{:else if mode === 'write_off'}Bestand, der ohne Erlös verschwunden ist, z. B. ein delisteter Token. Wird ohne Gewinn oder Verlust ausgebucht.
		{:else}Umstellung eines Tokens auf einen neuen, z. B. FTM → S. Kein Verkauf: Kaufdatum und Einstand gehen auf den neuen Coin über.{/if}
	</p>
	<form onsubmit={save}>
		<div class="grid-2">
			{#if venues.length > 1}
				<div>
					<label for="venue">Börse</label>
					<select id="venue" bind:value={venue}>
						{#each venues as v (v)}<option value={v}>{VNAME[v]}</option>{/each}
					</select>
				</div>
				<div></div>
			{/if}
			<div>
				<label for="coin">{mode === 'token_swap' ? 'Alter Coin' : 'Coin'}</label>
				<input id="coin" bind:value={coin} placeholder={mode === 'token_swap' ? 'z. B. FTM' : 'z. B. BGB'} autocomplete="off" />
			</div>
			<div>
				<label for="amount">Menge</label>
				<input id="amount" bind:value={amount} inputmode="decimal" placeholder="z. B. 193,8" />
			</div>
			{#if mode === 'token_swap'}
				<div>
					<label for="tocoin">Neuer Coin</label>
					<input id="tocoin" bind:value={toCoin} placeholder="z. B. S" autocomplete="off" />
				</div>
				<div>
					<label for="toamount">Menge neu</label>
					<input id="toamount" bind:value={toAmount} inputmode="decimal" placeholder="bei 1 : 1 dieselbe Menge" />
				</div>
			{/if}
			{#if mode === 'opening_balance'}
				<div>
					<label for="date">Kaufdatum (optional)</label>
					<input id="date" type="date" bind:value={date} max={historyStart} />
					<p class="small muted" style="margin:4px 0 0">Leer = {dateDe(historyStart)} (Beginn der Historie)</p>
				</div>
				<div>
					<label for="cost">Kosten in EUR (optional)</label>
					<input id="cost" bind:value={cost} inputmode="decimal" placeholder="leer = Tageswert, geschätzt" />
				</div>
			{:else}
				<div>
					<label for="date">Datum</label>
					<input id="date" type="date" bind:value={date} max={today} />
					<p class="small muted" style="margin:4px 0 0">
						{#if coin && lastOf(venue, coin)}Letzte {coin.trim().toUpperCase()}-Buchung bei {VNAME[venue]}: {dateDe(lastOf(venue, coin))} – frühestens dieser Tag{:else}Ungefähr reicht; nach der letzten Buchung des Coins{/if}
					</p>
				</div>
			{/if}
		</div>
		<label for="note">Notiz</label>
		<input id="note" bind:value={note} placeholder="z. B. vor 08/2023 gekauft" />
		<p style="margin-top:12px"><button type="submit" disabled={busy || !coin || !amount || (mode !== 'opening_balance' && !date)}>{busy ? 'Speichere …' : 'Speichern'}</button></p>
	</form>
	{#if msg}<p class="ok small">{msg}</p>{/if}
	{#if err}<p class="error small">{err}</p>{/if}
	{#if mode === 'opening_balance'}<p class="small muted">
		Ohne Kosten setzt das Cockpit den Bitget-Tagesschlusskurs am Kaufdatum an und markiert den Einstand als geschätzt. Für
		die Haltefrist zählt das Kaufdatum – ohne Angabe der Beginn der Historie; Verkäufe daraus sind damit in aller Regel
		steuerfrei (über ein Jahr).
	</p>{/if}
</section>

{#if openings.length}
	<section class="card" style="margin-top:16px">
		<div class="card-title">Eingetragene Nachträge</div>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Art</th><th>Börse</th><th>Coin</th><th class="num">Menge</th><th>Datum</th><th class="num">Kosten</th><th>Notiz</th><th></th></tr></thead>
				<tbody>
					{#each openings as o (o.id)}
						{@const k = o.kind ?? 'opening_balance'}
						<tr>
							<td class="small">{MODE_LABEL[k]}</td>
							<td>{VNAME[(o.venue as V) ?? 'bitget'] ?? o.venue}</td>
							<td><strong>{o.asset}</strong>{#if k === 'token_swap'} → <strong>{o.to_asset}</strong>{/if}</td>
							<td class="num">{qty(new Decimal(o.amount), 8)}{#if k === 'token_swap' && o.to_amount} → {qty(new Decimal(o.to_amount), 8)}{/if}</td>
							<td>{dateDe(berlinDay(o.ts))}</td>
							<td class="num">{k !== 'opening_balance' ? '–' : o.cost_eur ? money(new Decimal(o.cost_eur), 'EUR') : 'Tageswert'}</td>
							<td class="small">{o.note}</td>
							<td><button class="ghost" onclick={() => remove(o.id, `${MODE_LABEL[k]} ${o.asset}`)}>Löschen</button></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
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
	.head-row .seg {
		flex-wrap: wrap;
		max-width: 100%;
	}
</style>
