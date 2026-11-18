/** Eine Buchung, wie sie die View v_ledger liefert (Beträge als exakte Dezimalstrings). */
export interface LedgerEntry {
	tx_id: string;
	/** Zeitstempel, nur zum Sortieren (gleiches Format innerhalb eines Laufs). */
	ts: string;
	/** Kalendertag in Europe/Berlin, YYYY-MM-DD. */
	day: string;
	type: string;
	buy_amount: string | null;
	buy_cur: string | null;
	sell_amount: string | null;
	sell_cur: string | null;
	fee_amount: string | null;
	fee_cur: string | null;
	exchange: string;
	trade_group: string | null;
	comment: string | null;
	/** Anzahl zusammengefasster Rohzeilen (Zinsen pro Tag und Coin), sonst 1. */
	n: number;
	/** Nur Anfangsbestand (manual_adjustments): bekannte Anschaffungskosten in EUR, null = Tageswert schätzen */
	cost_eur?: string | null;
	/** Blockchain-Transaktion (Ein-/Auszahlungen), soweit bekannt */
	tx_hash?: string | null;
	/** Verknüpfung durch linkTransfers(): Umbuchung zwischen eigenen Konten bzw. Börsen */
	link?: TransferLink;
}

export type Venue = 'bitget' | 'kucoin';

export type TransferLink =
	/** Umbuchung zwischen Konten derselben Börse (CoinTracking führt KuCoin-Umbuchungen als Ein-/Auszahlung) */
	| { kind: 'internal'; peer: string }
	/** Überweisung zwischen zwei Börsen: Bestände wandern mit Kaufdatum und Einstand */
	| { kind: 'cross'; peer: string; role: 'out' | 'in'; from: Venue; to: Venue };

/** Börse einer Buchung (Konto-Bezeichnung wie CoinTracking: „Bitget Spot“, „Kucoin Funding“ …) */
export const venueOf = (e: Pick<LedgerEntry, 'exchange'>): Venue => (e.exchange.toLowerCase().startsWith('kucoin') ? 'kucoin' : 'bitget');

export const VENUE_LABEL: Record<Venue, string> = { bitget: 'Bitget', kucoin: 'KuCoin' };

/** Buchungsart für Anfangsbestände aus manual_adjustments */
export const OPENING_TYPE = 'Opening Balance';

export type Category =
	| 'kap_pnl'
	| 'kap_fee'
	| 'kap_funding'
	| 'kap_other'
	| 'spot_trade'
	| 'earn_income'
	| 'swap_nontaxable'
	| 'other_in'
	| 'other_out'
	| 'external_in'
	| 'external_out'
	| 'transfer'
	| 'opening_in'
	| 'unknown';

export const CATEGORY_LABEL: Record<Category, string> = {
	kap_pnl: 'Termingeschäft: Gewinn/Verlust',
	kap_fee: 'Termingeschäft: Gebühr',
	kap_funding: 'Termingeschäft: Funding',
	kap_other: 'Termingeschäft: Sonstiges',
	spot_trade: 'Spot-Trade',
	earn_income: 'Earn / Zinsen / Boni',
	swap_nontaxable: 'Token-Migration',
	other_in: 'Sonstiger Zugang',
	other_out: 'Sonstiger Abgang',
	external_in: 'Einzahlung von außen',
	external_out: 'Auszahlung nach außen',
	transfer: 'Interne Umbuchung',
	opening_in: 'Anfangsbestand (nachgetragen)',
	unknown: 'Nicht zugeordnet'
};
