import { loadLedger } from '$lib/data/ledger';
import type { LiveData } from '$lib/analysis/portfolio';
import type { SyncRun } from '$lib/monitor/health';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = async ({ parent, fetch, depends }) => {
	depends('app:live');
	const { supabase } = await parent();

	const [ledger, live, runs] = await Promise.allSettled([
		loadLedger(supabase),
		fetch('/api/bitget/live').then(async (r) => {
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`);
			return (await r.json()) as LiveData;
		}),
		supabase
			.from('imports')
			.select('id, status, note, created_at, finished_at')
			.eq('source', 'bitget_api')
			.order('created_at', { ascending: false })
			.limit(30)
			.then(({ data, error }) => {
				if (error) throw new Error(error.message);
				return (data ?? []) as SyncRun[];
			})
	]);

	return {
		ledger: ledger.status === 'fulfilled' ? ledger.value : null,
		ledgerError: ledger.status === 'rejected' ? String((ledger.reason as Error).message) : null,
		live: live.status === 'fulfilled' ? live.value : null,
		liveError: live.status === 'rejected' ? String((live.reason as Error).message) : null,
		syncRuns: runs.status === 'fulfilled' ? runs.value : null
	};
};
