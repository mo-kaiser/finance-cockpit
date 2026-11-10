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

	const nav = [
		{ href: '/', label: 'Übersicht' },
		{ href: '/steuer', label: 'Steuer' },
		{ href: '/import', label: 'Import' }
	];
	const showNav = $derived(data.claims?.aal === 'aal2');
</script>

<svelte:head>
	<title>Cockpit</title>
</svelte:head>

<div class="shell">
	<header>
		<a class="brand" href="/">Cockpit</a>
		{#if showNav}
			<nav>
				{#each nav as item (item.href)}
					<a href={item.href} aria-current={page.url.pathname === item.href ? 'page' : undefined}>
						{item.label}
					</a>
				{/each}
			</nav>
			<form method="POST" action="/logout">
				<button class="ghost" type="submit">Abmelden</button>
			</form>
		{/if}
	</header>
	<main>
		{@render children()}
	</main>
</div>
