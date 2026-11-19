import { loadLedger } from '#lib/data/ledger.ts';
import type { LiveData } from '#lib/analysis/portfolio.ts';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = async ({ parent, fetch, depends }) => {
	depends('app:live');
	const { supabase } = await parent();

	// Live-Positionen von Bitget: nicht abwarten, damit Kalender und Statistik sofort erscheinen
	const live: Promise<{ data: LiveData | null; error: string | null }> = fetch('/api/bitget/live')
		.then(async (r) => {
			if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? `HTTP ${r.status}`);
			return { data: (await r.json()) as LiveData, error: null };
		})
		.catch((e: unknown) => ({ data: null, error: (e as Error).message }));

	try {
		const d = await loadLedger(supabase);
		return { ledger: d.ledger, fx: d.fx, loadError: null, live };
	} catch (e) {
		return { ledger: [], fx: [], loadError: (e as Error).message, live };
	}
};
