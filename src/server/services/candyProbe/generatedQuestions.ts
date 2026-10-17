/**
 * Seed-parameterized candy questions.
 *
 * The static bank is small and public: a relay that saw it once could special-case its
 * answers. These generators derive a *fresh* question from the run's random source, so the
 * numbers, the words and the constraint combination differ between runs while the grading
 * rule stays exact — the expected answer is computed here, never guessed.
 *
 * Every answer below is derived from the same arithmetic the question asks for, so there is
 * no second opinion to disagree with:
 *
 * - decimal comparison: JS numeric comparison of the two candidates;
 * - letter counting: the count taken from the string itself;
 * - candy guarantee: the worst-case (bad) draw computed exactly, then +1. Verified against a
 *   brute-force enumeration in `generatedQuestions.test.ts`.
 */

import type { CandyQuestion } from './questionBank.js';

/** Deterministic seed → 8 hex chars, so a generated question id is stable per generator run. */
function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function pickOne<T>(items: readonly T[], random: () => number): T {
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
  return items[index] as T;
}

function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.min(max - min, Math.max(0, Math.floor(random() * (max - min + 1))));
}

/**
 * Two decimals that LOOK like the longer one is bigger.
 *
 * The classic `9.11 > 9.9` trap, built so it always holds: the SMALLER value always carries
 * the two-digit fraction, so a model that compares the digits after the point lexically
 * picks it.
 */
export function generateDecimalCompareQuestion(random: () => number): CandyQuestion {
  const whole = randomInt(random, 1, 19);
  // 2..9, so a two-digit fraction strictly below `tenths / 10` exists.
  const tenths = randomInt(random, 2, 9);
  let twoDigitFraction = randomInt(random, 10, tenths * 10 - 1);
  // `9.10` renders as `9.1`, which would break the premise; nudge off the round tens.
  if (twoDigitFraction % 10 === 0) twoDigitFraction += 1;

  const trap = Number(`${whole}.${twoDigitFraction}`);
  const answer = Number(`${whole}.${tenths}`);
  // Present them in a random order so the position itself is not a hint.
  const [first, second] = random() < 0.5 ? [trap, answer] : [answer, trap];

  return {
    id: `generated-compare-${shortHash(`${first}:${second}`)}`,
    tier: 'discriminative',
    prompt: `${first} 和 ${second} 哪个更大？只回答更大的那个数字。`,
    expectedLabel: String(answer),
    rule: { kind: 'firstNumber', value: answer },
    wrongAnswers: [trap],
  };
}

const LETTER_WORDS: readonly { text: string; letter: string }[] = [
  { text: 'strawberry', letter: 'r' },
  { text: 'banana', letter: 'a' },
  { text: 'mississippi', letter: 's' },
  { text: 'indivisibility', letter: 'i' },
  { text: 'counterrevolutionaries', letter: 'r' },
  { text: 'abracadabra', letter: 'a' },
  { text: 'refrigerator', letter: 'r' },
  { text: 'encyclopedia', letter: 'e' },
];

/** Letter counting, with the answer taken from the string. */
export function generateLetterCountQuestion(random: () => number): CandyQuestion {
  const entry = pickOne(LETTER_WORDS, random);
  const count = [...entry.text].filter((character) => character === entry.letter).length;
  return {
    id: `generated-letters-${shortHash(`${entry.text}${entry.letter}`)}`,
    tier: 'discriminative',
    prompt: `单词 "${entry.text}" 里有几个字母 "${entry.letter}"？只回答这个数字。`,
    expectedLabel: String(count),
    rule: { kind: 'firstNumber', value: count },
  };
}

export type CandyGuaranteeShape = {
  /** Capacities per (shape, flavor) cell. */
  capacities: number[][];
  shapeLabels: [string, string];
  flavorLabels: [string, string];
  /** Ask for at least this many of shape 0. */
  minShape: number;
  /** Ask for at least this many of flavor 0. */
  minFlavor: number;
};

/**
 * The smallest number of draws that GUARANTEES the constraint.
 *
 * A draw can miss the constraint only by falling inside one of two boxes: "fewer than
 * `minShape` of shape 0" or "fewer than `minFlavor` of flavor 0". Both boxes are closed
 * under taking subsets, so the largest bad draw is the larger of the two box maxima, and the
 * guarantee is that plus one.
 *
 * Exported because the generator and its test must agree by construction: the test
 * brute-forces the same instance and compares.
 */
export function solveCandyGuarantee(input: CandyGuaranteeShape): number {
  const { capacities, minShape, minFlavor } = input;

  const cellAt = (shape: number, flavor: number): number => capacities[shape]?.[flavor] ?? 0;
  const totalOf = (predicate: (shape: number, flavor: number) => boolean): number => {
    let sum = 0;
    for (let shape = 0; shape < capacities.length; shape += 1) {
      for (let flavor = 0; flavor < (capacities[shape]?.length ?? 0); flavor += 1) {
        if (predicate(shape, flavor)) sum += cellAt(shape, flavor);
      }
    }
    return sum;
  };

  /** Largest draw that stays inside the box `constrained(cell) === true` stays under bound`. */
  const boxMax = (
    constrained: (shape: number, flavor: number) => boolean,
    bound: number,
  ): number => {
    const free = totalOf((shape, flavor) => !constrained(shape, flavor));
    const limited = totalOf(constrained);
    return free + Math.min(Math.max(0, bound), limited);
  };

  const worstShapeDraw = boxMax((shape) => shape === 0, minShape - 1);
  const worstFlavorDraw = boxMax((_shape, flavor) => flavor === 0, minFlavor - 1);
  return Math.max(worstShapeDraw, worstFlavorDraw) + 1;
}

/** Build the prompt text for a guarantee instance. */
function buildGuaranteePrompt(input: CandyGuaranteeShape): string {
  const [shapeA, shapeB] = input.shapeLabels;
  const [flavorA, flavorB] = input.flavorLabels;
  const cells: string[] = [];
  for (let shape = 0; shape < input.capacities.length; shape += 1) {
    for (let flavor = 0; flavor < (input.capacities[shape]?.length ?? 0); flavor += 1) {
      cells.push(
        `${shape === 0 ? shapeA : shapeB}${flavor === 0 ? flavorA : flavorB} ${input.capacities[shape]?.[flavor] ?? 0} 颗`,
      );
    }
  }
  return [
    `袋子里有糖果，两种口味（${flavorA}、${flavorB}）、两种形状（${shapeA}、${shapeB}）。`,
    `已知：${cells.join('、')}。`,
    `闭眼随机取，最少要取多少颗，才能保证一定拿到至少 ${input.minShape} 颗 ${shapeA}、`,
    `且至少 ${input.minFlavor} 颗 ${flavorA}？只回答这个数字。`,
  ].join('');
}

/** A fresh candy-guarantee question whose answer is computed, not hardcoded. */
export function generateCandyGuaranteeQuestion(random: () => number): CandyQuestion {
  const input: CandyGuaranteeShape = {
    capacities: [
      [randomInt(random, 5, 11), randomInt(random, 4, 10)],
      [randomInt(random, 4, 10), randomInt(random, 3, 8)],
    ],
    shapeLabels: ['圆形', '五角星形'],
    flavorLabels: ['草莓', '薄荷'],
    minShape: randomInt(random, 6, 12),
    minFlavor: randomInt(random, 4, 9),
  };
  const answer = solveCandyGuarantee(input);
  const prompt = buildGuaranteePrompt(input);
  // The obvious wrong answers: giving up on one constraint, or counting the two worst cases
  // as if they could not overlap.
  const naiveShape = input.capacities[1]!.reduce((sum, value) => sum + value, 0) + input.minShape;
  const naiveFlavor = input.capacities[0]!.reduce((sum, value) => sum + value, 0)
    + input.capacities[1]!.reduce((sum, value) => sum + value, 0);
  const wrongAnswers = [...new Set([answer - 1, answer + 1, naiveShape, naiveFlavor])]
    .filter((value) => value > 0 && value !== answer);
  return {
    id: `generated-guarantee-${shortHash(prompt)}`,
    tier: 'discriminative',
    prompt,
    expectedLabel: String(answer),
    // Reasoning answers put the conclusion last.
    rule: { kind: 'lastNumber', value: answer },
    wrongAnswers,
  };
}

/**
 * A fresh batch of generated questions for one probe run: one per family, so the battery is
 * never the same twice while its size stays predictable.
 */
export function generateCandyQuestions(random: () => number): CandyQuestion[] {
  return [
    generateDecimalCompareQuestion(random),
    generateLetterCountQuestion(random),
    generateCandyGuaranteeQuestion(random),
  ];
}
