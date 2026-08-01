/** Converts a worst-case paid-model token reservation into micro-dollars. */
export function paidReservationMicroUsd(
  reservation: { input: number; output: number },
  pricing: {
    promptNanoUsdPerToken: number;
    completionNanoUsdPerToken: number;
  },
) {
  return Math.ceil(
    (reservation.input * pricing.promptNanoUsdPerToken +
      reservation.output * pricing.completionNanoUsdPerToken) /
      1_000,
  );
}
