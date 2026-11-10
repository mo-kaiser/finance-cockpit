import { error } from '@sveltejs/kit';
import { loadLedger } from '$lib/data/ledger';
import type { PageLoad } from './$types';

export const ssr = false;

export interface Fill {
	tradeId: string;
	orderId: string;
	symbol: string;
	side: string;
	tradeSide: string;
	price: string;
	baseVolume: string;
	quoteVolume: string;
	profit: string;
	feeDetail?: { feeCoin: string; totalFee: string }[];
	tradeScope?: string;
	cTime: string;
	posMode?: string;
}

const berlinDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });

export const load: PageLoad = async ({ parent, params }) => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(params.day)) error(404, 'Ungültiges Datum');
	const { supabase } = await parent();
	const day = params.day;

	const d = new Date(`${day}T00:00:00Z`);
	const from = new Date(d.getTime() - 86_400_000).toISOString();
	const to = new Date(d.getTime() + 2 * 86_400_000).toISOString();

	const [ledger, fills] = await Promise.all([
		loadLedger(supabase),
		supabase
			.from('api_records')
			.select('raw, ts')
			.eq('source', 'bitget')
			.eq('endpoint', 'futures_fills_usdt')
			.gte('ts', from)
			.lt('ts', to)
			.order('ts')
	]);

	return {
		day,
		ledger: ledger.ledger,
		fx: ledger.fx,
		fills: ((fills.data ?? []) as { raw: Fill; ts: string }[])
			.filter((f) => berlinDay.format(new Date(f.ts)) === day)
			.map((f) => f.raw),
		fillsError: fills.error?.message ?? null
	};
};
