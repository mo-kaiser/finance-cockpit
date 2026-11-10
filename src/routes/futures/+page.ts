import { loadLedger } from '$lib/data/ledger';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = async ({ parent }) => {
	const { supabase } = await parent();
	try {
		const d = await loadLedger(supabase);
		return { ledger: d.ledger, fx: d.fx, loadError: null };
	} catch (e) {
		return { ledger: [], fx: [], loadError: (e as Error).message };
	}
};
