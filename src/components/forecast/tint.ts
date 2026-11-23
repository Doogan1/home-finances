/** Days whose end-of-day balance is below zero or below the cushion are tinted, and say so to screen readers. */
type Flags = { belowZero: boolean; belowCushion: boolean };

export const tintClass = (flags: Flags) => (flags.belowZero ? "tint-negative" : flags.belowCushion ? "tint-low" : undefined);
export const tintText = (flags: Flags) => (flags.belowZero ? " (below zero)" : flags.belowCushion ? " (below the cushion)" : "");
