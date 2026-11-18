<script lang="ts">
	import { navigating } from '$app/state';

	/**
	 * Ladeanzeige bei Seitenwechseln: dünner Balken oben und ein Hinweis unten rechts.
	 * Erst nach 300 ms sichtbar (kein Flackern bei schnellen Wechseln); nach 10 s „dauert länger als üblich“.
	 * Die Animation läuft per CSS-Transform weiter, auch wenn der Browser gerade rechnet.
	 */
	let visible = $state(false);
	let seconds = $state(0);

	$effect(() => {
		if (!navigating.to) {
			visible = false;
			seconds = 0;
			return;
		}
		const started = Date.now();
		const show = setTimeout(() => (visible = true), 300);
		const tick = setInterval(() => (seconds = Math.floor((Date.now() - started) / 1000)), 1000);
		return () => {
			clearTimeout(show);
			clearInterval(tick);
		};
	});
</script>

{#if visible}
	<div class="bar" aria-hidden="true"><span></span></div>
	<div class="pill" role="status" aria-live="polite">
		<span class="spin" aria-hidden="true"></span>
		{#if seconds >= 10}
			Dauert länger als üblich ({seconds} s) – Bitget oder die Datenbank antworten langsam, die Seite arbeitet noch.
		{:else}
			Lade Daten …
		{/if}
	</div>
{/if}

<style>
	.bar {
		position: fixed;
		inset: 0 0 auto 0;
		height: 3px;
		overflow: hidden;
		z-index: 100;
		background: var(--accent-soft);
	}
	.bar span {
		position: absolute;
		inset: 0;
		width: 40%;
		background: var(--accent);
		animation: slide 1.1s ease-in-out infinite;
	}
	@keyframes slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(250%);
		}
	}
	.pill {
		position: fixed;
		right: 16px;
		bottom: 16px;
		max-width: min(420px, calc(100vw - 32px));
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border-radius: 14px;
		background: var(--surface);
		border: 1px solid var(--border);
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
		font-size: 0.875rem;
		color: var(--text);
		z-index: 100;
	}
	.spin {
		width: 14px;
		height: 14px;
		flex: none;
		border-radius: 50%;
		border: 2px solid var(--accent-soft);
		border-top-color: var(--accent);
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bar span,
		.spin {
			animation-duration: 3s;
		}
	}
</style>
