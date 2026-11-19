import { loadLedger } from '#lib/data/ledger.ts';
import type { LiveData } from '#lib/analysis/portfolio.ts';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = async ({ parent, fetch, depends }) => {
	depends('app:korrekturen');
	const { supabase } = await parent();
	const [ledger, live, kucoin] = await Promise.allSettled([
		loadLedger(supabase),
		fetch('/api/bitget/live').then(async (r) => {
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`);
			return (await r.json()) as LiveData;
		}),
		fetch('/api/kucoin/live').then(async (r) => {
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`);
			const body = (await r.json()) as LiveData & { configured: boolean };
			return body.configured ? body : null;
		})
	]);
	return {
		ledger: ledger.status === 'fulfilled' ? ledger.value : null,
		ledgerError: ledger.status === 'rejected' ? String((ledger.reason as Error).message) : null,
		live: live.status === 'fulfilled' ? live.value : null,
		liveError: live.status === 'rejected' ? String((live.reason as Error).message) : null,
		kucoin: kucoin.status === 'fulfilled' ? kucoin.value : null,
		kucoinError: kucoin.status === 'rejected' ? String((kucoin.reason as Error).message) : null
	};
};
