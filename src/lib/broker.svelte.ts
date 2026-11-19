import type { LiveData } from '#lib/analysis/portfolio.ts';
import { mergeLive } from '#lib/analysis/portfolio.ts';
import type { Holding, TaxResult } from '#lib/tax/engine.ts';
import { venueOf, type LedgerEntry, type Venue } from '#lib/tax/types.ts';

/**
 * Börsen-Auswahl (Alle / Bitget / KuCoin), gemeinsam für Dashboard, Futures, Spot und Earn.
 * Die Wahl gilt seitenübergreifend und wird im Browser gemerkt.
 */
export type Broker = 'Alle' | 'Bitget' | 'KuCoin';
export const BROKERS: Broker[] = ['Alle', 'Bitget', 'KuCoin'];
const KEY = 'cockpit.broker';

function initial(): Broker {
	try {
		const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
		if (v === 'Alle' || v === 'Bitget' || v === 'KuCoin') return v;
	} catch {
		/* privater Modus o. Ä. */
	}
	return 'Alle';
}

export const brokerState = $state<{ value: Broker }>({ value: initial() });

export function setBroker(b: Broker) {
	brokerState.value = b;
	try {
		localStorage.setItem(KEY, b);
	} catch {
		/* egal */
	}
}

/** Gilt die Börse (venue) für die Auswahl? */
export const brokerHas = (b: Broker, v: Venue) => b === 'Alle' || (b === 'Bitget' ? v === 'bitget' : v === 'kucoin');

/** Buchungen der gewählten Börse */
export const ledgerFor = (b: Broker, ledger: LedgerEntry[]) => (b === 'Alle' ? ledger : ledger.filter((e) => brokerHas(b, venueOf(e))));

/** Live-Bestände der gewählten Börse(n) */
export function liveFor(b: Broker, bitget: LiveData | null | undefined, kucoin: LiveData | null | undefined): LiveData | null {
	if (b === 'Bitget') return bitget ?? null;
	if (b === 'KuCoin') return kucoin ?? null;
	return bitget && kucoin ? mergeLive(bitget, kucoin) : (bitget ?? kucoin ?? null);
}

/** FIFO-Bestände (Einstand) der gewählten Börse */
export function holdingsFor(b: Broker, tax: TaxResult | null | undefined): Holding[] {
	if (!tax) return [];
	return b === 'Bitget' ? tax.holdingsByVenue.bitget : b === 'KuCoin' ? tax.holdingsByVenue.kucoin : tax.holdingsEnd;
}

export const brokerLabel = (b: Broker) => (b === 'Alle' ? 'Bitget und KuCoin' : b);
