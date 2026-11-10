import { mapApiLedger, type ApiLedgerRow } from '$lib/tax/bitget-api';
import type { FxRow } from '$lib/tax/fx';
import type { LedgerEntry } from '$lib/tax/types';
import type { PageLoad } from './$types';

// Berechnung läuft im Browser: keine 15.000 Zeilen durchs Server-Rendering schicken
export const ssr = false;

const PAGE = 1000;

export const load: PageLoad = async ({ parent, depends }) => {
	depends('app:steuer');
	const { supabase } = await parent();

	const loadLedger = async () => {
		const all: LedgerEntry[] = [];
		for (let from = 0; ; from += PAGE) {
			const { data, error } = await supabase
				.from('v_ledger')
				.select('*')
				.order('ts')
				.order('tx_id')
				.range(from, from + PAGE - 1);
			if (error) throw new Error(error.message);
			all.push(...(data as LedgerEntry[]));
			if (data.length < PAGE) return all;
		}
	};

	const loadApi = async () => {
		const all: ApiLedgerRow[] = [];
		for (let from = 0; ; from += PAGE) {
			const { data, error } = await supabase
				.from('v_api_ledger')
				.select('*')
				.order('ts')
				.order('tx_id')
				.range(from, from + PAGE - 1);
			if (error) throw new Error(`Bitget-API-Daten: ${error.message}`);
			all.push(...(data as ApiLedgerRow[]));
			if (data.length < PAGE) return all;
		}
	};

	const loadFx = async () => {
		const all: FxRow[] = [];
		for (let from = 0; ; from += PAGE) {
			const { data, error } = await supabase
				.from('fx_rates')
				.select('rate_date, rate')
				.eq('pair', 'EURUSD')
				.eq('source', 'ECB')
				.order('rate_date')
				.range(from, from + PAGE - 1);
			if (error) throw new Error(error.message);
			all.push(...(data as FxRow[]));
			if (data.length < PAGE) return all;
		}
	};

	try {
		const [ct, api, fx] = await Promise.all([loadLedger(), loadApi(), loadFx()]);
		const apiEntries = mapApiLedger(api);
		return {
			ledger: [...ct, ...apiEntries],
			fx,
			sources: { cointracking: ct.length, api: apiEntries.length, apiLast: api.length ? api[api.length - 1]!.ts : null },
			loadError: null
		};
	} catch (e) {
		return {
			ledger: [] as LedgerEntry[],
			fx: [] as FxRow[],
			sources: { cointracking: 0, api: 0, apiLast: null as string | null },
			loadError: (e as Error).message
		};
	}
};
