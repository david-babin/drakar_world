// The market index as the world's climate.
export const CLIMATE_SPAN = 1.5;          // climate = clamp(daily change % / CLIMATE_SPAN, -1, 1)
export const REGIME_THRESHOLD = 0.25;     // beyond ±this, a season of plenty or of scarcity
export const regimeOf = c => (c > REGIME_THRESHOLD ? 'plenty' : c < -REGIME_THRESHOLD ? 'scarcity' : 'ordinary');
export const climateOf = change => Math.max(-1, Math.min(1, change / CLIMATE_SPAN));
