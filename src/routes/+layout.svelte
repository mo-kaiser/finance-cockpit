<script lang="ts">
	import '../app.css';
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';

	let { data, children } = $props();

	onMount(() => {
		const { data: sub } = data.supabase.auth.onAuthStateChange(() => {
			invalidate('supabase:auth');
		});
		return () => sub.subscription.unsubscribe();
	});

	// Icon-Pfade (24er Raster, Strich)
	const nav = [
		{ href: '/', label: 'Dashboard', icon: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 9h8V3h-8z' },
		{ href: '/futures', label: 'Futures', icon: 'M3 17l6-6 4 4 8-8M15 7h6v6' },
		{ href: '/spot', label: 'Spot', icon: 'M12 3v18M17 7.5c0-1.9-2.2-3.5-5-3.5S7 5.6 7 7.5 9.2 11 12 11s5 1.6 5 3.5-2.2 3.5-5 3.5-5-1.6-5-3.5' },
		{ href: '/earn', label: 'Earn', icon: 'M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8M12 8a4 4 0 100 8 4 4 0 000-8z' },
		{ href: '/steuer', label: 'Steuer', icon: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6' },
		{ href: '/import', label: 'Import', icon: 'M12 3v12M7 10l5 5 5-5M4 21h16' },
		{ href: '/system', label: 'System', icon: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z' }
	];
	const showNav = $derived(data.claims?.aal === 'aal2');
	const active = (href: string) => (href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href));
</script>

<svelte:head>
	<title>Cockpit</title>
</svelte:head>

{#if showNav}
	<div class="app">
		<aside class="side">
			<a class="brand" href="/">
				<svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M8 22l5-6 4 3 7-9" fill="none" stroke="var(--accent-ink)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /></svg>
				<span>Cockpit</span>
			</a>
			<nav>
				{#each nav as item (item.href)}
					<a href={item.href} aria-current={active(item.href) ? 'page' : undefined}>
						<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d={item.icon} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
						<span>{item.label}</span>
					</a>
				{/each}
			</nav>
			<form method="POST" action="/logout" class="logout">
				<button class="ghost" type="submit">Abmelden</button>
			</form>
		</aside>
		<main class="content">
			{@render children()}
		</main>
	</div>
{:else}
	<main class="solo">
		{@render children()}
	</main>
{/if}

<style>
	.app {
		display: grid;
		grid-template-columns: 220px 1fr;
		min-height: 100vh;
	}
	.side {
		position: sticky;
		top: 0;
		height: 100vh;
		display: flex;
		flex-direction: column;
		gap: 24px;
		padding: 20px 14px;
		background: var(--side);
		color: var(--side-ink);
		border-right: 1px solid var(--border);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 8px;
		font-weight: 700;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		font-size: 0.85rem;
		color: var(--side-ink);
		text-decoration: none;
	}
	nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: 1;
	}
	nav a {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 9px 10px;
		border-radius: 8px;
		color: var(--side-muted);
		text-decoration: none;
		font-size: 0.92rem;
	}
	nav a:hover {
		background: var(--side-hover);
		color: var(--side-ink);
	}
	nav a[aria-current='page'] {
		background: var(--side-active);
		color: var(--side-ink);
		font-weight: 600;
	}
	.logout button {
		width: 100%;
		color: var(--side-muted);
		border-color: var(--side-hover);
	}
	.content {
		min-width: 0;
		padding: 28px 32px 64px;
	}
	.solo {
		padding: 16px;
	}
	@media (max-width: 860px) {
		.app {
			grid-template-columns: 1fr;
		}
		.side {
			position: sticky;
			height: auto;
			flex-direction: row;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			z-index: 10;
			overflow-x: auto;
		}
		.brand span,
		nav a span,
		.logout {
			display: none;
		}
		nav {
			flex-direction: row;
		}
		.content {
			padding: 20px 16px 48px;
		}
	}
</style>
