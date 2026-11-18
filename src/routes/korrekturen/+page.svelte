<script lang="ts">
	import Decimal from 'decimal.js';
	import { invalidate } from '$app/navigation';
	import { onChainStaked, reconcile } from '$lib/analysis/reconcile';
	import { clearLedgerCache, berlinDay } from '$lib/data/ledger';
	import { money, qty } from '$lib/format';
	import { USD_STABLE } from '$lib/tax/assets';
	import { computeTax } from '$lib/tax/engine';
	import { FxTable } from '$lib/tax/fx';
	import { PriceTable } from '$lib/tax/prices';
	import { OPENING_TYPE } from '$lib/tax/types';

	let { data } = $props();

	const fx = $derived(new FxTable(data.ledger?.fx ?? []));
	const priceTable = $derived(new PriceTable(data.ledger?.prices ?? []));
	const tax = $derived(data.ledger && fx.size ? computeTax(data.ledger.ledger, fx, 'all', priceTable) : null);
	const rows = $derived(
		tax && data.live && data.ledger ? reconcile(data.live, tax.holdingsEnd, onChainStaked(data.ledger.ledger, data.live)) : []
	);
	const openings = $derived(data.ledger?.openings ?? []);

	/** Erster Tag der Historie (ohne nachgetragene Anfangsbestände) = Standard-Kaufdatum */
	const historyStart = $derived.by(() => {
		let min = '';
		for (const e of data.ledger?.ledger ?? []) if (e.type !== OPENING_TYPE && (!min || e.day < min)) min = e.day;
		return min || '2023-01-01';
	});

	// Formular
	let coin = $state('');
	let amount = $state('');
	let date = $state('');
	let cost = $state('');
	let note = $state('');
	let busy = $state(false);
	let msg = $state('');
	let err = $state('');

	function take(r: { coin: string; gap: Decimal }) {
		coin = r.coin;
		amount = r.gap.toString();
		date = '';
		cost = '';
		note = 'Bestand vor Beginn der Historie (Abgleich mit Bitget)';
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
		let a: Decimal, k: Decimal | null;
		try {
			// Eingabe mit Komma oder Punkt als Dezimaltrennzeichen
			a = new Decimal(amount.includes(',') ? num(amount) : amount.trim());
			k = cost.trim() ? new Decimal(cost.includes(',') ? num(cost) : cost.trim()) : null;
		} catch {
			err = 'Menge oder Kosten sind keine gültige Zahl.';
			return;
		}
		if (!/^[A-Z0-9]{1,20}$/.test(c)) return void (err = 'Bitte einen Coin wie BGB oder ETH angeben.');
		if (a.lte(0)) return void (err = 'Die Menge muss größer als 0 sein.');
		if (k && k.lt(0)) return void (err = 'Kosten dürfen nicht negativ sein.');
		const day = date || historyStart;
		busy = true;
		const { error } = await data.supabase.from('manual_adjustments').insert({
			// Mittag UTC liegt sicher auf demselben Berliner Kalendertag
			ts: new Date(`${day}T12:00:00Z`).toISOString(),
			venue: 'bitget',
			asset: c,
			amount: a.toString(),
			cost_eur: k ? k.toString() : null,
			kind: 'opening_balance',
			note: [note.trim() || 'Anfangsbestand', date ? '' : '(Kaufdatum unbekannt)', k ? '' : '(Kosten = Tageswert, geschätzt)']
				.filter(Boolean)
				.join(' ')
		});
		if (error) {
			busy = false;
			err = `Speichern fehlgeschlagen: ${error.message}`;
			return;
		}
		// Ohne Kosten wird der Tageswert gebraucht: Kurse ab dem Kaufdatum sicherstellen
		if (!k && !USD_STABLE.has(c)) {
			msg = `${c}: lade Tageskurse ab ${day} …`;
			await fetch('/api/prices/sync', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ coin: c, from: day })
			}).catch(() => null);
		}
		msg = `Anfangsbestand ${qty(a)} ${c} gespeichert.`;
		coin = amount = date = cost = note = '';
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
	der Historie ({dateDe(historyStart)}) bei Bitget hattest. Sie fließen in Dashboard und Steuer ein wie ein Kauf.
</p>

{#if data.ledgerError}<p class="error">{data.ledgerError}</p>{/if}

<section class="card">
	<div class="card-title">Abgleich: Bitget gegen Buchungen</div>
	{#if data.liveError}
		<p class="error small">Bitget-Bestände nicht geladen: {data.liveError}</p>
	{:else if !tax || !data.live}
		<p class="muted small">Lade …</p>
	{:else if !rows.length}
		<p class="ok">Alle Bestände (ab 1 USDT) sind durch die Buchungen erklärt.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr><th>Coin</th><th class="num">bei Bitget</th><th class="num">aus Buchungen</th><th class="num">Differenz</th><th class="num">Wert (USDT)</th><th>Einschätzung</th><th></th></tr>
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
								{#if r.gap.lt(0)}Buchungen zeigen mehr als Bitget – evtl. fehlt ein Abgang
								{:else if r.onChain}Im On-Chain-Staking: noch nicht ausgezahlte Erträge – <strong>nicht</strong> nachtragen, sie werden bei der Auszahlung gebucht
								{:else}Kauf vor Beginn der Historie?{/if}
							</td>
							<td>
								{#if r.gap.gt(0) && !r.onChain}<button class="ghost" onclick={() => take(r)}>Übernehmen</button>{/if}
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

<section class="card" id="form" style="margin-top:16px">
	<div class="card-title">Anfangsbestand nachtragen</div>
	<form onsubmit={save}>
		<div class="grid-2">
			<div>
				<label for="coin">Coin</label>
				<input id="coin" bind:value={coin} placeholder="z. B. BGB" autocomplete="off" />
			</div>
			<div>
				<label for="amount">Menge</label>
				<input id="amount" bind:value={amount} inputmode="decimal" placeholder="z. B. 193,8" />
			</div>
			<div>
				<label for="date">Kaufdatum (optional)</label>
				<input id="date" type="date" bind:value={date} max={historyStart} />
				<p class="small muted" style="margin:4px 0 0">Leer = {dateDe(historyStart)} (Beginn der Historie)</p>
			</div>
			<div>
				<label for="cost">Kosten in EUR (optional)</label>
				<input id="cost" bind:value={cost} inputmode="decimal" placeholder="leer = Tageswert, geschätzt" />
			</div>
		</div>
		<label for="note">Notiz</label>
		<input id="note" bind:value={note} placeholder="z. B. vor 08/2023 gekauft" />
		<p style="margin-top:12px"><button type="submit" disabled={busy || !coin || !amount}>{busy ? 'Speichere …' : 'Speichern'}</button></p>
	</form>
	{#if msg}<p class="ok small">{msg}</p>{/if}
	{#if err}<p class="error small">{err}</p>{/if}
	<p class="small muted">
		Ohne Kosten setzt das Cockpit den Bitget-Tagesschlusskurs am Kaufdatum an und markiert den Einstand als geschätzt. Für
		die Haltefrist zählt das Kaufdatum – ohne Angabe der Beginn der Historie; Verkäufe daraus sind damit in aller Regel
		steuerfrei (über ein Jahr).
	</p>
</section>

{#if openings.length}
	<section class="card" style="margin-top:16px">
		<div class="card-title">Eingetragene Anfangsbestände</div>
		<div class="table-wrap">
			<table>
				<thead><tr><th>Coin</th><th class="num">Menge</th><th>Kaufdatum</th><th class="num">Kosten</th><th>Notiz</th><th></th></tr></thead>
				<tbody>
					{#each openings as o (o.id)}
						<tr>
							<td><strong>{o.asset}</strong></td>
							<td class="num">{qty(new Decimal(o.amount), 8)}</td>
							<td>{dateDe(berlinDay(o.ts))}</td>
							<td class="num">{o.cost_eur ? money(new Decimal(o.cost_eur), 'EUR') : 'Tageswert'}</td>
							<td class="small">{o.note}</td>
							<td><button class="ghost" onclick={() => remove(o.id, `${o.asset}-Anfangsbestand`)}>Löschen</button></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
{/if}
