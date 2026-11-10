import type { Category, LedgerEntry } from './types';

/**
 * Ordnet eine CoinTracking-Buchung (Bitget) einem Steuertopf zu.
 * Grundlage: Inventur aller Type/Group/Comment-Kombinationen im Export (Stand 11/2026).
 * Steuerlich zählt die Art der Buchung, nicht das Konto: Earn-Zinsen bucht Bitget z. B. aufs Spot-Konto.
 */
export function classify(e: LedgerEntry): Category {
	const type = e.type;
	const comment = e.comment ?? '';
	const account = e.exchange.toLowerCase();

	// Ein- und Auszahlungen: extern nur bei echten Wallet-Bewegungen, sonst Umbuchung zwischen Bitget-Konten
	if (type === 'Deposit' || type === 'Withdrawal') {
		const external = ['Deposit', 'Withdrawal', 'Automatic deposit', 'Automatic withdrawal'];
		if (account === 'bitget spot' && external.includes(comment)) {
			return type === 'Deposit' ? 'external_in' : 'external_out';
		}
		return 'transfer';
	}

	if (account === 'bitget futures') {
		if (type.startsWith('Derivatives / Futures')) return 'kap_pnl';
		if (comment === 'Contract Margin Settle Fee') return 'kap_funding';
		if (type === 'Margin Fee') return 'kap_fee';
		if (
			type === 'Other Fee' &&
			['Futures Fee', 'Contract Main Settle Fee', 'Open Long', 'Open Short'].includes(comment)
		) {
			return 'kap_fee';
		}
		return 'kap_other';
	}

	switch (type) {
		case 'Trade':
			return 'spot_trade';
		case 'Staking':
		case 'Reward / Bonus':
		case 'Airdrop':
		case 'Income':
		case 'Other Income':
			return 'earn_income';
		case 'Swap (non taxable)':
			return 'swap_nontaxable';
		case 'Other Income (non taxable)':
			return 'other_in';
		case 'Other Expense':
		case 'Other Fee':
			return 'other_out';
	}
	return 'unknown';
}

export function isKap(c: Category) {
	return c === 'kap_pnl' || c === 'kap_fee' || c === 'kap_funding' || c === 'kap_other';
}
