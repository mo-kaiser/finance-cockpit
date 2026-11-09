import type { SupabaseClient } from '@supabase/supabase-js';

export interface AuthClaims {
	sub: string;
	email?: string;
	aal: 'aal1' | 'aal2';
}

declare global {
	namespace App {
		interface Locals {
			supabase: SupabaseClient;
			/** Verifizierte JWT-Claims oder null, wenn nicht eingeloggt. */
			getClaims: () => Promise<AuthClaims | null>;
		}
		interface PageData {
			claims: AuthClaims | null;
		}
	}
}

export {};
