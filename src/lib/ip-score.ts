/**
 * Reputation thresholds live here so the readout color and the readout state
 * cannot drift apart.
 *
 * Colors resolve through the `--data-*` ink tokens rather than the `--good` /
 * `--warning` / `--danger` fills: those fills drop below AA contrast when used
 * as text, especially the amber band on a light background.
 */
export type ScoreState = "good" | "warn" | "bad" | "none";

const SCORE_INK: Record<ScoreState, string> = {
  good: "var(--data-good)",
  warn: "var(--data-warn)",
  bad: "var(--data-bad)",
  none: "var(--muted-foreground)",
};

export function ipScoreState(score: number | null | undefined): ScoreState {
  if (score == null || !Number.isFinite(score) || score < 0 || score > 100)
    return "none";
  return score >= 75 ? "good" : score >= 45 ? "warn" : "bad";
}

export function ipScoreColor(score: number | null | undefined): string {
  return SCORE_INK[ipScoreState(score)];
}
