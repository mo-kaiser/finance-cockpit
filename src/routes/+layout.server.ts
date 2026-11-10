import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
	return {
		claims: await locals.getClaims(),
		cookies: cookies.getAll()
	};
};
