<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { clearLedgerCache } from '#lib/data/ledger.ts';

	/**
	 * Lädt alle Daten der Seite neu: Buchungen aus der Datenbank (inkl. nächtlichem Abruf),
	 * Live-Bestände und Positionen. Der 5-Minuten-Zwischenspeicher der Buchungen wird dabei geleert.
	 * Voraussetzung: die load-Funktion der Seite ruft depends('app:live') auf.
	 */
	let refreshing = $state(false);

	async function refresh() {
		refreshing = true;
		clearLedgerCache();
		try {
			await invalidate('app:live');
		} finally {
			refreshing = false;
		}
	}
</script>

<button class="ghost" onclick={refresh} disabled={refreshing} title="Buchungen, Bestände und Positionen neu laden">
	{refreshing ? 'Lade …' : 'Aktualisieren'}
</button>
