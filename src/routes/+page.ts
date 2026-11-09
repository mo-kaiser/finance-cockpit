import type { PageLoad } from './$types';

export interface OverviewRow {
	venue: string;
	exchange: string;
	year: number;
	type: string;
	n: number;
	first_ts: string;
	last_ts: string;
}

export const load: PageLoad = async ({ parent }) => {
	const { supabase } = await parent();
	const [overview, imports] = await Promise.all([
		supabase.from('v_ct_overview').select('*').limit(5000),
		supabase
			.from('imports')
			.select('id, source, file_name, row_count, status, created_at, finished_at')
			.order('created_at', { ascending: false })
			.limit(20)
	]);
	return {
		overview: (overview.data ?? []) as OverviewRow[],
		imports: imports.data ?? [],
		loadError: overview.error?.message ?? imports.error?.message ?? null
	};
};
