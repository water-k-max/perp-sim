/**
 *  The random-entry verdict ladder, kept out of the view so its extremes are testable.
 *
 *  `pValue` is the add-one-corrected share of null totals **at or above** the recorded total
 *  (see edge.ts), so it is one-sided and both ends mean something: a small p is evidence the
 *  entries beat random timing, and p at its ceiling means every random-entry path did better
 *  than the record. The old three-band copy labelled that ceiling "consistent with luck",
 *  which is the opposite of what it shows.
 */

export type EdgeVerdictBand = "skill" | "weak" | "luck" | "anti-skill";

export type EdgeVerdict = { band: EdgeVerdictBand; label: string; note: string };

/** Bands, not thresholds to hide: alpha 0.05, a weak band to 0.2, the anti-skill tail from 0.95. */
export const EDGE_ALPHA = 0.05;
export const EDGE_WEAK = 0.2;
export const EDGE_ANTI_SKILL = 0.95;

/** The smallest p this test can report, and the gap between adjacent reachable values. */
export function pValueResolution(paths: number): { floor: number; step: number } {
  if (!Number.isInteger(paths) || paths <= 0) throw new Error("paths must be a positive integer");
  const step = 1 / (paths + 1);
  return { floor: step, step };
}

export function edgeVerdict(pValue: number, paths: number): EdgeVerdict {
  if (!Number.isFinite(pValue) || pValue < 0 || pValue > 1) throw new Error("p-value must be in [0, 1]");
  const { floor } = pValueResolution(paths);
  if (pValue < EDGE_ALPHA) {
    return {
      band: "skill",
      label: "UNLIKELY TO BE LUCK",
      note: `Fewer than 5% of the ${paths} random-entry paths reached the recorded total. That says the entries were better timed than chance on this history — a reason to look closer, not proof of skill.`,
    };
  }
  if (pValue < EDGE_WEAK) {
    return {
      band: "weak",
      label: "WEAK SEPARATION",
      note: `${(pValue * 100).toFixed(1)}% of random-entry paths reached the recorded total: separated from chance, not enough to quote.`,
    };
  }
  if (pValue < EDGE_ANTI_SKILL) {
    return {
      band: "luck",
      label: "CONSISTENT WITH LUCK",
      note: "The recorded total is ordinary under uninformed timing on this history. That is not proof the entries were bad, and not proof they were good.",
    };
  }
  const worst = pValue >= 1 - floor / 2;
  return {
    band: "anti-skill",
    label: "ENTRIES WORSE THAN RANDOM",
    note: worst
      ? `Every one of the ${paths} random-entry paths came out at or above the recorded total. Random timing beat these entries outright — the p-value's ceiling, not its floor.`
      : `${(pValue * 100).toFixed(1)}% of random-entry paths beat the recorded total: the record sits in the bad tail of uninformed timing, which is evidence against the entries, not an absence of evidence.`,
  };
}
