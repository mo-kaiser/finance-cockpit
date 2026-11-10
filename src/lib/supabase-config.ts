// Öffentliche Supabase-Verbindungsdaten. Beide Werte landen ohnehin im Browser und sind
// nicht geheim; der Schutz der Daten liegt in Login, 2FA und RLS. Bewusst im Code statt
// als Vercel-Variable, damit Builds nicht von deren Konfiguration abhängen.
// Geheime Werte (Secret Key, Bitget) gehören weiterhin ausschließlich in Vercel.
export const SUPABASE_URL = 'https://rzfannwemelhncjmvjzn.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_MxaWAkhJ-WucnAVFgAsL7A_2aWB-Cxf';
