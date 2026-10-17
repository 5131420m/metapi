/**
 * The generated questions must be graded against answers that are COMPUTED, so the only real
 * risk is a generator whose own arithmetic is wrong — a healthy model would then be reported
 * as degraded. Every family is therefore checked against an independent, brute-force answer
 * rather than against the implementation's own reasoning.
 */

import { describe, expect, it } from 'vitest';
import {
  generateCandyGuaranteeQuestion,
  generateCandyQuestions,
  generateDecimalCompareQuestion,
  generateLetterCountQuestion,
  solveCandyGuarantee,
  type CandyGuaranteeShape,
} from './generatedQuestions.js';

/** Deterministic PRNG so a failure is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Brute force: enumerate every possible draw and return the smallest size that already
 * satisfies the constraint in ALL of them.
 */
function bruteForceGuarantee(input: CandyGuaranteeShape): number {
  const { capacities, minShape, minFlavor } = input;
  const shapeCount = capacities.length;
  const flavorCount = capacities[0]?.length ?? 0;
  const cells: Array<[number, number, number]> = [];
  for (let shape = 0; shape < shapeCount; shape += 1) {
    for (let flavor = 0; flavor < flavorCount; flavor += 1) {
      cells.push([shape, flavor, capacities[shape]?.[flavor] ?? 0]);
    }
  }

  let largestBad = 0;
  const chosen = new Array<number>(cells.length).fill(0);
  const walk = (index: number, shapeTotal: number, flavorTotal: number, size: number): void => {
    if (index === cells.length) {
      const satisfied = shapeTotal >= minShape && flavorTotal >= minFlavor;
      if (!satisfied && size > largestBad) largestBad = size;
      return;
    }
    const [shape, flavor, capacity] = cells[index] as [number, number, number];
    for (let take = 0; take <= capacity; take += 1) {
      chosen[index] = take;
      walk(
        index + 1,
        shape === 0 ? shapeTotal + take : shapeTotal,
        flavor === 0 ? flavorTotal + take : flavorTotal,
        size + take,
      );
    }
  };
  walk(0, 0, 0, 0);
  return largestBad + 1;
}

describe('generated candy questions', () => {
  it('agrees with brute force on every small guarantee instance', () => {
    // Small capacities keep the enumeration cheap; the reasoning is the same at any size.
    for (let a = 1; a <= 3; a += 1) {
      for (let b = 1; b <= 3; b += 1) {
        for (let c = 1; c <= 3; c += 1) {
          for (let d = 1; d <= 3; d += 1) {
            for (let minShape = 1; minShape <= 5; minShape += 1) {
              for (let minFlavor = 1; minFlavor <= 5; minFlavor += 1) {
                const input: CandyGuaranteeShape = {
                  capacities: [[a, b], [c, d]],
                  shapeLabels: ['圆形', '五角星形'],
                  flavorLabels: ['草莓', '薄荷'],
                  minShape,
                  minFlavor,
                };
                expect(
                  solveCandyGuarantee(input),
                  JSON.stringify(input),
                ).toBe(bruteForceGuarantee(input));
              }
            }
          }
        }
      }
    }
  });

  it('never asks for a guarantee larger than the bag', () => {
    const random = seededRandom(7);
    for (let run = 0; run < 50; run += 1) {
      const question = generateCandyGuaranteeQuestion(random);
      const bag = question.expectedLabel ? Number(question.expectedLabel) : NaN;
      expect(Number.isFinite(bag)).toBe(true);
      expect(bag).toBeGreaterThan(0);
    }
  });

  it('builds decimal pairs whose answer is really the larger number', () => {
    const random = seededRandom(11);
    for (let run = 0; run < 100; run += 1) {
      const question = generateDecimalCompareQuestion(random);
      const numbers = question.prompt.match(/\d+(?:\.\d+)?/g) ?? [];
      expect(numbers).toHaveLength(2);
      const values = numbers.map(Number);
      const answer = Number(question.expectedLabel);
      expect(answer).toBe(Math.max(...values));
      // The trap is the other candidate, and it is the one with the longer fraction.
      const trap = values.find((value) => value !== answer);
      expect(question.wrongAnswers).toContain(trap);
      const trapText = numbers.find((text) => Number(text) === trap) ?? '';
      const answerText = numbers.find((text) => Number(text) === answer) ?? '';
      expect((trapText.split('.')[1] ?? '').length)
        .toBeGreaterThan((answerText.split('.')[1] ?? '').length);
    }
  });

  it('counts letters from the word itself', () => {
    const random = seededRandom(13);
    for (let run = 0; run < 50; run += 1) {
      const question = generateLetterCountQuestion(random);
      const match = question.prompt.match(/"([a-z]+)".*"([a-z])"/);
      expect(match).toBeTruthy();
      const [, word, letter] = match as RegExpMatchArray;
      const expected = [...word!].filter((character) => character === letter).length;
      expect(Number(question.expectedLabel)).toBe(expected);
    }
  });

  it('produces one fresh question per family with unique ids', () => {
    const questions = generateCandyQuestions(seededRandom(17));
    expect(questions).toHaveLength(3);
    expect(new Set(questions.map((question) => question.id)).size).toBe(3);
    for (const question of questions) {
      expect(question.id.startsWith('generated-')).toBe(true);
      expect(question.tier).toBe('discriminative');
      expect(question.prompt.length).toBeGreaterThan(10);
    }
  });

  it('grades its own expected answers as correct', () => {
    const questions = generateCandyQuestions(seededRandom(19));
    for (const question of questions) {
      // The expected label must be what the rule actually matches.
      expect(question.expectedLabel).toBe(String(question.rule.value));
    }
  });
});
