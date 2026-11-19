<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Bereich einer Auswertungsseite.
	 * now = true: „Jetzt“ – live, unabhängig vom Zeitraum, farbig abgesetzt, mit Zeitstempel.
	 * Sonst „Auswertung“: Zeitraum-Schalter gehören in tools, damit klar ist, wofür sie gelten.
	 */
	let {
		title,
		now = false,
		at = null,
		tools,
		children
	}: { title: string; now?: boolean; at?: string | null; tools?: Snippet; children: Snippet } = $props();
</script>

<section class="zone" class:zone-now={now}>
	<div class="zone-head">
		<div class="zone-title">
			{#if now}<span class="live-dot" aria-hidden="true"></span>{/if}
			{title}
			{#if now}<span class="stamp small">{at ? `live · Stand ${new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : 'lade …'}</span>{/if}
		</div>
		{#if tools}<div class="zone-tools">{@render tools()}</div>{/if}
	</div>
	{@render children()}
</section>
