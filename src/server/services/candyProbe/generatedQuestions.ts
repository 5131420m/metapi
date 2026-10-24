/**
 * Parameterized candy-bag questions.
 *
 * The original question is public, so a relay (or a model that has seen it) can special-case
 * it. This module generates structurally identical questions with different cell counts, and
 * — the important part — computes each answer by EXHAUSTIVE ENUMERATION of every possible
 * hand rather than by a closed form someone derived by hand. An earlier version of this file
 * carried a hand-written formula and got an answer wrong, which marks healthy models as
 * degraded; the search space is small enough (~10^5–10^6 compositions) that there is no
 * reason to trust arithmetic over enumeration.
 *
 * A generated question is only used when its optimum is UNIQUE and the instance is not
 * degenerate (see `isUsableInstance`): a question with two optimal splits, or one whose
 * answer is "take everything", measures nothing.
 */

import type { CandyBagQuestion } from './candyBagQuestion.js';
import { CANDY_BAG_SHAPE_LABELS, CANDY_BAG_FLAVOR_LABELS, buildCandyBagPrompt } from './candyBagQuestion.js';

/** capacities[shape][flavor] — shape 0/1, flavors apple/peach/watermelon. */
export type CandyBagCapacities = number[][];

export type CandyBagSolution = {
  /** The minimum number of candies that guarantees the condition, or null if impossible. */
  answer: number | null;
  /** Every (round, star) split that reaches the optimum; more than one means "not unique". */
  optimalSplits: Array<{ round: number; star: number }>;
  /**
   * Largest total that still fails — at least `answer - 1`, and in general NOT equal to it.
   *
   * These are two different optimizations: `answer` is the smallest total of a SAFE split
   * (over splits), while this is the largest total of ANY failing hand (over hands). A failing
   * hand can be bigger than the answer because it comes from an unsafe split — for the
   * reference bag it is 28 (24 round + 4 star, from the unsafe split (24,4)) while the answer
   * is 21 (from the safe split (9,12)). Useful for naming the "worst case + 1" wrong answer;
   * never a substitute for `answer`.
   */
  largestFailingTotal: number;
};

function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.min(max - min, Math.max(0, Math.floor(random() * (max - min + 1))));
}

/**
 * Whether a hand satisfies the goal: apple and peach in DIFFERENT shapes.
 *
 * `counts[shape][flavor]` is how many of each cell the hand holds; either OR-branch counts.
 */
function handSatisfies(counts: number[][]): boolean {
  const roundApple = counts[0]?.[0] ?? 0;
  const roundPeach = counts[0]?.[1] ?? 0;
  const starApple = counts[1]?.[0] ?? 0;
  const starPeach = counts[1]?.[1] ?? 0;
  return (roundApple >= 1 && starPeach >= 1) || (roundPeach >= 1 && starApple >= 1);
}

/**
 * Solve one instance by enumerating every composition of the bag.
 *
 * Enumerates the full 6-cell product once and buckets hands by (roundTotal, starTotal). A
 * split is SAFE only when every composition with that split satisfies the goal — the
 * participant fixes the split in advance and cannot see flavors, so a single bad composition
 * makes the split useless.
 */
export function solveCandyBag(capacities: CandyBagCapacities): CandyBagSolution {
  const counts: number[][] = [[0, 0, 0], [0, 0, 0]];
  /** `round:star` -> whether some composition with that split fails. */
  const splitHasFailure = new Map<string, boolean>();
  let largestFailingTotal = -1;

  const record = (): void => {
    const round = counts[0]!.reduce((sum, value) => sum + value, 0);
    const star = counts[1]!.reduce((sum, value) => sum + value, 0);
    const satisfies = handSatisfies(counts);
    if (!satisfies && round + star > largestFailingTotal) largestFailingTotal = round + star;
    const key = `${round}:${star}`;
    if (!satisfies) splitHasFailure.set(key, true);
    else if (!splitHasFailure.has(key)) splitHasFailure.set(key, false);
  };

  const walk = (shape: number, flavor: number): void => {
    const cap = capacities[shape]?.[flavor] ?? 0;
    for (let take = 0; take <= cap; take += 1) {
      counts[shape]![flavor] = take;
      if (shape === 1 && flavor === 2) record();
      else if (flavor === 2) walk(shape + 1, 0);
      else walk(shape, flavor + 1);
    }
    counts[shape]![flavor] = 0;
  };
  walk(0, 0);

  const optimalSplits: Array<{ round: number; star: number }> = [];
  let answer: number | null = null;
  for (const [key, hasFailure] of splitHasFailure.entries()) {
    if (hasFailure) continue;
    const [round, star] = key.split(':').map(Number) as [number, number];
    const total = round + star;
    if (total <= 0) continue;
    if (answer === null || total < answer) {
      answer = total;
      optimalSplits.length = 0;
      optimalSplits.push({ round, star });
    } else if (total === answer) {
      optimalSplits.push({ round, star });
    }
  }

  optimalSplits.sort((left, right) => left.round - right.round || left.star - right.star);
  return { answer, optimalSplits, largestFailingTotal };
}

/**
 * Non-degeneracy: the question must be answerable and must not be trivial.
 *
 * - every cell holds at least 2 candies, otherwise a flavor is absent from a shape and one
 *   OR-branch is dead on arrival, which makes the question much easier than it looks;
 * - exactly one split reaches the optimum, so "the" answer is really the answer;
 * - the optimum is strictly inside the bag, so "take everything" is never the solution.
 */
function isUsableInstance(capacities: CandyBagCapacities, solution: CandyBagSolution): boolean {
  for (const shape of capacities) {
    for (const cell of shape ?? []) {
      if (!Number.isFinite(cell) || cell < 2) return false;
    }
  }
  if (solution.answer === null) return false;
  if (solution.optimalSplits.length !== 1) return false;
  const bagTotal = capacities.flat().reduce((sum, value) => sum + value, 0);
  return solution.answer > 0 && solution.answer < bagTotal;
}

export function buildCandyBagCapacities(random: () => number): CandyBagCapacities {
  return [
    [randomInt(random, 4, 10), randomInt(random, 4, 10), randomInt(random, 3, 9)],
    [randomInt(random, 3, 9), randomInt(random, 3, 8), randomInt(random, 2, 7)],
  ];
}

/**
 * Draw a fresh instance whose answer is unique and whose optimum is not the whole bag.
 *
 * Re-draws until the instance passes `isUsableInstance`. The loop is bounded because a
 * pathological random source (a test seam) must not spin forever; on giving up it returns
 * null and the caller falls back to the original question rather than shipping a degenerate
 * one.
 */
export function buildUniqueCandyBagInstance(random: () => number, attempts = 40): {
  capacities: CandyBagCapacities;
  solution: CandyBagSolution;
} | null {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const capacities = buildCandyBagCapacities(random);
    const solution = solveCandyBag(capacities);
    if (isUsableInstance(capacities, solution)) return { capacities, solution };
  }
  return null;
}

/** The generated question, or null when no usable instance could be drawn. */
export function generateCandyBagQuestion(random: () => number): CandyBagQuestion | null {
  const drawn = buildUniqueCandyBagInstance(random);
  if (!drawn) return null;
  const answer = drawn.solution.answer;
  if (answer === null) return null;
  const { capacities } = drawn;
  const bagTotal = capacities.flat().reduce((sum, value) => sum + value, 0);
  const prompt = buildCandyBagPrompt({
    capacities,
    shapeLabels: CANDY_BAG_SHAPE_LABELS,
    flavorLabels: CANDY_BAG_FLAVOR_LABELS,
  });
  return {
    id: `generated-candy-${shortHash(prompt)}`,
    prompt,
    expectedLabel: String(answer),
    answer,
    // Three wrong totals a model plausibly lands on. Only `answer - 1` is unsafe under
    // every split; the other two admit safe splits that are simply not the minimum (the
    // "worst case + 1" slip, and "take everything"), which is what makes them convincing
    // near-misses. They only enrich the sample note; the verdict never depends on them.
    wrongAnswers: [...new Set([answer - 1, drawn.solution.largestFailingTotal + 1, bagTotal])]
      .filter((value) => value !== answer && value > 0),
  };
}

/** Stable id suffix so the same prompt always yields the same question id. */
function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
