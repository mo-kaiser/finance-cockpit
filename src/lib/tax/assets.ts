/**
 * CoinTracking hängt bei mehrdeutigen Tickern eine Ziffer an (SOL2 = Solana).
 * Für die Bestandsführung zählt das tatsächliche Asset.
 */
const TICKER_MAP: Record<string, string> = {
	SOL2: 'SOL',
	POL3: 'POL',
	SUI3: 'SUI',
	OP3: 'OP',
	SEI2: 'SEI',
	DOT2: 'DOT',
	APU5: 'APU',
	PEPE4: 'PEPE',
	ZETA2: 'ZETA',
	TONCOIN: 'TON'
};

export function asset(ticker: string): string {
	return TICKER_MAP[ticker] ?? ticker;
}

/** Stablecoins, die 1:1 als US-Dollar bewertet werden (Annahme, im Bericht ausgewiesen). */
export const USD_STABLE = new Set(['USDT', 'USDC', 'USD']);

/** Euro ist Heimatwährung und kein Wirtschaftsgut im Sinne von § 23 EStG. */
export const FIAT_EUR = 'EUR';
