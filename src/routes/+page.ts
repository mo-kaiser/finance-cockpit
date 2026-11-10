import { loadLedger } from '$lib/data/ledger';
import type { LiveData } from '$lib/analysis/portfolio';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = async ({ parent, fetch, depends }) => {
	depends('app:live');
	const { supabase } = await parent();

	const [ledger, live] = await Promise.allSettled([
		loadLedger(supabase),
		fetch('/api/bitget/live').then(async (r) => {
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`);
			return (await r.json()) as LiveData;
		})
	]);

	return {
		ledger: ledger.status === 'fulfilled' ? ledger.value : null,
		ledgerError: ledger.status === 'rejected' ? String((ledger.reason as Error).message) : null,
		live: live.status === 'fulfilled' ? live.value : null,
		liveError: live.status === 'rejected' ? String((live.reason as Error).message) : null
	};
};
