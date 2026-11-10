import { clearLedgerCache, loadLedger } from '$lib/data/ledger';
import type { PageLoad } from './$types';

// Berechnung läuft im Browser
export const ssr = false;

export const load: PageLoad = async ({ parent, depends }) => {
	depends('app:steuer');
	const { supabase } = await parent();
	try {
		const d = await loadLedger(supabase);
		return { ledger: d.ledger, fx: d.fx, sources: d.sources, loadError: null };
	} catch (e) {
		clearLedgerCache();
		return {
			ledger: [],
			fx: [],
			sources: { cointracking: 0, api: 0, apiLast: null as string | null },
			loadError: (e as Error).message
		};
	}
};
