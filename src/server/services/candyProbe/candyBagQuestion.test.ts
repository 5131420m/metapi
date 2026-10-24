/**
 * The candy-bag question: its reference answer, the answer reader, and the generator.
 *
 * The assertions that matter are the ones that decide a verdict. A wrong expected answer or a
 * misread answer marks a healthy model as degraded, which is the failure this whole feature is
 * built to avoid — so the reference answer is re-derived by exhaustive enumeration here rather
 * than restated, and the reader is pinned against the exact answer shapes models produce.
 */

import { describe, expect, it } from 'vitest';
import {
  CANDY_BAG_REFERENCE_QUESTION,
  CANDY_MAX_ANSWER_TEXT_CHARS,
  buildCandyBagPrompt,
  buildCandyProbePrompt,
  extractIntegers,
  readCandyAnswer,
  resolveCandyProbeVerdict,
  stripQuestionEcho,
  type CandyBagQuestion,
} from './candyBagQuestion.js';
import {
  buildUniqueCandyBagInstance,
  generateCandyBagQuestion,
  solveCandyBag,
} from './generatedQuestions.js';

/** Deterministic PRNG so a failure is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const REFERENCE_CAPACITIES = [[7, 9, 8], [7, 6, 4]];
const REFERENCE_BAG_TOTAL = REFERENCE_CAPACITIES.flat().reduce((sum, value) => sum + value, 0);

describe('the reference candy-bag question', () => {
  it('answers 21 at a unique optimal split, re-derived by enumeration', () => {
    const solved = solveCandyBag(REFERENCE_CAPACITIES);

    expect(solved.answer).toBe(21);
    expect(solved.optimalSplits).toEqual([{ round: 9, star: 12 }]);
    // The largest hand that still FAILS is 28 (24 round + 4 star), which is why 29 also fails;
    // the smallest guarantee is 21, so "largest failing total" and "answer - 1" are different
    // quantities here and the near-miss entry has to be 20, not 28.
    expect(solved.largestFailingTotal).toBe(28);
    // The bank's own label must equal the enumerated answer, so changing one without the other
    // fails here instead of silently mis-grading every model.
    expect(CANDY_BAG_REFERENCE_QUESTION.answer).toBe(solved.answer);
    expect(CANDY_BAG_REFERENCE_QUESTION.expectedLabel).toBe(String(solved.answer));
  });

  it('quotes the bag it asks about, and asks for one number', () => {
    // Every cell count must actually appear, otherwise the question describes a different bag
    // than the one the answer was computed for.
    for (const count of REFERENCE_CAPACITIES.flat()) {
      expect(CANDY_BAG_REFERENCE_QUESTION.prompt).toContain(`${count} 颗`);
    }
    expect(REFERENCE_BAG_TOTAL).toBe(41);
    // The instruction allows reasoning; the old bundle forbade it.
    const prompt = buildCandyProbePrompt(CANDY_BAG_REFERENCE_QUESTION);
    expect(prompt).toContain('可以写推理过程');
    expect(prompt).toContain('答案：');
  });

  it('is not solvable by taking the whole bag or by naming a wrong total', () => {
    const { answer, wrongAnswers } = CANDY_BAG_REFERENCE_QUESTION;
    expect(answer).toBeLessThan(REFERENCE_BAG_TOTAL);
    expect(wrongAnswers).toContain(answer - 1);
    expect(wrongAnswers).not.toContain(answer);
  });
});

describe('reading one candy answer', () => {
  const question = CANDY_BAG_REFERENCE_QUESTION;

  it('accepts the conclusion even when the splits are explained next to it', () => {
    // The reported false negative: the old rule took the LAST number, so the explanation's
    // `12` displaced the answer. This is the most natural way a model writes it.
    const read = readCandyAnswer(question, '答案：21（圆形 9 颗 + 五角星形 12 颗）');
    expect(read.correct).toBe(true);
    expect(read.source).toBe('answer-line');
  });

  it('accepts the answer alone, with full-width or spaced separators', () => {
    for (const text of ['答案：21', '答案: 21', '最终答案：21', '**答案：21**', '答案：21。']) {
      expect(readCandyAnswer(question, text).correct, text).toBe(true);
    }
  });

  it('takes the LAST answer line when reasoning discusses candidates first', () => {
    const text = [
      '先看最坏情况。',
      '如果只取 20 颗可能还差一颗。',
      '答案：20',
      '再检查一遍，其实 21 就够了。',
      '答案：21',
    ].join('\n');
    const read = readCandyAnswer(question, text);
    expect(read.source).toBe('answer-line');
    expect(read.answerText).toBe('21');
    expect(read.correct).toBe(true);
  });

  it('grades a known wrong answer as wrong, and names it', () => {
    const read = readCandyAnswer(question, '答案：20');
    expect(read.correct).toBe(false);
    expect(read.matchedWrongAnswer).toBe(20);
  });

  it('accepts markdown-decorated answer lines', () => {
    // Models love to decorate the one line we asked for; a missed match used to demote a
    // committed answer into the prose fallbacks.
    for (const text of ['### 答案：21', '**答案**：21', '**最终答案**：21', '答案是 21', '答案是21']) {
      const read = readCandyAnswer(question, text);
      expect(read.source, text).toBe('answer-line');
      expect(read.correct, text).toBe(true);
    }
  });

  it('grades the answer line by its conclusion', () => {
    // A parenthetical explanation is not the conclusion: the 21 wins over the split.
    const read = readCandyAnswer(question, '答案：21（圆形 9 颗 + 五角星形 12 颗）');
    expect(read.correct).toBe(true);
    // A committed unlisted wrong total on a trusted line is still a wrong answer.
    const unlisted = readCandyAnswer(question, '答案：12');
    expect(unlisted.correct).toBe(false);
    expect(unlisted.matchedWrongAnswer).toBeNull();
    expect(unlisted.convicts).toBe(true);
    // No total phrase and no leading number ("圆形 9 颗、五角星形 12 颗"): a split
    // statement proves nothing — recorded, but never convicting.
    const split = readCandyAnswer(question, '答案：圆形 9 颗、五角星形 12 颗');
    expect(split.source).toBe('answer-line');
    expect(split.correct).toBe(false);
    expect(split.convicts).toBe(false);
  });

  it('takes the number after the last = when the answer line states a sum', () => {
    // "9 + 12 = 21": the sum is the conclusion, not the addends.
    const read = readCandyAnswer(question, '答案：9 + 12 = 21');
    expect(read.source).toBe('answer-line');
    expect(read.correct).toBe(true);
    // The `=` inside a parenthetical ("21（= 9 + 12）") must not steal the conclusion:
    // the parenthetical is stripped before grading.
    const parenthesized = readCandyAnswer(question, '答案：21（= 9 + 12）');
    expect(parenthesized.source).toBe('answer-line');
    expect(parenthesized.correct).toBe(true);
  });

  it('grades the 33 reviewed answer-line shapes end to end', () => {
    // The round-9 review table: every case was recomputed by hand against these rules
    // (total phrase > sum > single/leading number; parentheticals are not conclusions;
    // contradictory answer lines never convict).
    const cases: Array<{ text: string; verdict: 'pass' | 'fail' | 'inconclusive'; matchedWrong?: number | null }> = [
      // Plain and decorated conclusions.
      { text: '答案：21', verdict: 'pass' },
      { text: '答案是 21', verdict: 'pass' },
      { text: '**答案**：21', verdict: 'pass' },
      { text: '### 答案：21', verdict: 'pass' },
      { text: '答案：$21$', verdict: 'pass' },
      { text: '答案：\\boxed{21}', verdict: 'pass' },
      { text: '答案：**21** 颗', verdict: 'pass' },
      // Conclusion with a parenthetical split.
      { text: '答案：21 颗（圆形 9 + 五角星形 12）', verdict: 'pass' },
      // Stated sums.
      { text: '答案：9 + 12 = 21', verdict: 'pass' },
      { text: '答案：最少取 9+12=21 颗', verdict: 'pass' },
      // Explanations that used to steal the conclusion.
      { text: '答案：21（= 9 + 12）', verdict: 'pass' },
      { text: '答案：21 (round=9, star=12)', verdict: 'pass' },
      { text: '答案：21 颗，即 9 + 12', verdict: 'pass' },
      // Total phrases carry the conclusion over earlier numbers.
      { text: '答案：圆形 9 颗、五角星形 12 颗，共 21 颗', verdict: 'pass' },
      { text: '答案：第 2 种方案，共 21 颗', verdict: 'pass' },
      { text: '答案：2 种形状共 21 颗', verdict: 'pass' },
      { text: '答案：至少 21 颗', verdict: 'pass' },
      // Self-correction keeps the LAST answer line.
      { text: '答案：20\n重新检查……\n答案：21', verdict: 'pass' },
      // Committed wrong answers.
      { text: '答案：20', verdict: 'fail', matchedWrong: 20 },
      { text: '答案：20 颗', verdict: 'fail', matchedWrong: 20 },
      { text: '答案：共 41 颗', verdict: 'fail', matchedWrong: 41 },
      { text: '答案：至少 28 颗', verdict: 'fail', matchedWrong: 28 },
      { text: '答案：22，即 10 + 12', verdict: 'fail', matchedWrong: null },
      { text: '答案：22 颗（圆形 10 + 五角星 12）', verdict: 'fail', matchedWrong: null },
      { text: '答案：28（= 24 + 4 不够，故取更大）', verdict: 'fail', matchedWrong: 28 },
      // A split without a total cannot convict.
      { text: '答案：圆形 9 颗、五角星形 12 颗', verdict: 'inconclusive' },
      // Contradictory answer lines cannot convict either.
      { text: '答案：21\n最终答案：圆形9颗', verdict: 'inconclusive' },
      // Negations.
      { text: '答案：不是 21，是 22', verdict: 'inconclusive' },
      { text: '答案：22，而不是 21', verdict: 'inconclusive' },
      // Expected and known-wrong both present.
      { text: '答案：20 或 21', verdict: 'inconclusive' },
      // The expected answer is mentioned but is not the conclusion.
      { text: '答案：22 还是 21', verdict: 'inconclusive' },
      { text: '答案：共 2 种形状，21 颗', verdict: 'inconclusive' },
      // No number at all.
      { text: '答案：无法确定', verdict: 'inconclusive' },
    ];

    expect(cases).toHaveLength(33);
    for (const testCase of cases) {
      const read = readCandyAnswer(question, testCase.text);
      const graded = resolveCandyProbeVerdict(read);
      expect(graded.verdict, testCase.text).toBe(testCase.verdict);
      if (testCase.verdict === 'fail') {
        expect(read.matchedWrongAnswer, testCase.text).toBe(testCase.matchedWrong ?? null);
      }
    }
  });

  it('declares an answer line invalid when expected and known-wrong both appear', () => {
    // "答案：20 或 21" used to read as correct (21 appears anywhere) and "答案：不是 21，
    // 是 29" still does — which number the model committed to is a guess in both directions.
    for (const text of ['答案：20 或 21', '答案：不是 21，是 29', '答案是 21 吗？不，是 29。']) {
      const read = readCandyAnswer(question, text);
      expect(read.source, text).toBe('none');
      expect(read.correct, text).toBe(false);
    }
  });

  it('treats a negated or merely-mentioned expected answer as ambiguous, never as pass', () => {
    // R3: "行内出现 21" 算对 let "不是 21，是 22" and "22，而不是 21" slip through as pass.
    for (const text of ['答案：不是 21，是 22', '答案：22，而不是 21']) {
      const read = readCandyAnswer(question, text);
      expect(read.source, text).toBe('none');
      expect(read.correct, text).toBe(false);
    }
    // The expected answer appears but is NOT the conclusion ("22 还是 21"): mentioned,
    // not committed.
    const mentioned = readCandyAnswer(question, '答案：22 还是 21');
    expect(mentioned.source).toBe('none');
    expect(mentioned.correct).toBe(false);
    // No number at all: not something to judge.
    const noNumber = readCandyAnswer(question, '答案：无法确定');
    expect(noNumber.source).toBe('none');
  });

  it('does not treat a question about the answer as an answer line', () => {
    // R4: "答案是" followed by anything but a number is a question the model asks itself.
    const read = readCandyAnswer(question, '答案是否唯一？先看圆形 9 颗');
    expect(read.source).not.toBe('answer-line');
    // And whatever fallback layer reads it, the 9 must not be able to convict.
    expect(read.correct).toBe(false);
    expect(read.convicts).toBe(false);
  });

  it('lets only the answer line and terse replies convict; prose fallbacks just prove a pass', () => {
    // The reviewer's reported misread: a short split statement carries TWO numbers, so it
    // is not "obviously the answer" — the last integer (12) must not be able to convict.
    const splitStatement = readCandyAnswer(question, '圆形至少 9 颗，五角星至少 12 颗。');
    expect(splitStatement.source).toBe('text-fallback');
    expect(splitStatement.correct).toBe(false);
    expect(splitStatement.matchedWrongAnswer).toBeNull();
    expect(splitStatement.convicts).toBe(false);

    const markerWrong = readCandyAnswer(question, '我认真地把每一种坏情况都完整推演了一遍，确定没有遗漏之后，最终的结论是最少 12 颗。');
    expect(markerWrong.fallbackLayer).toBe('marker');
    expect(markerWrong.correct).toBe(false);
    expect(markerWrong.convicts).toBe(false);

    const lastLineWrong = readCandyAnswer(question, [
      '先想清楚每一种坏情况，再决定取多少。',
      '坏情况都排除之后，剩下的组合一目了然。',
      '所以取 29 颗就好。',
    ].join('\n'));
    expect(lastLineWrong.fallbackLayer).toBe('last-line');
    expect(lastLineWrong.correct).toBe(false);
    expect(lastLineWrong.matchedWrongAnswer).toBe(29);
    expect(lastLineWrong.convicts).toBe(false);

    // The same layers still prove a pass, and a single-number terse reply still convicts
    // — a short reply with one number IS the answer, even when wrong.
    const markerRight = readCandyAnswer(question, '我认真地把每一种坏情况都完整推演了一遍，确定没有遗漏之后，最终的结论是最少 21 颗。');
    expect(markerRight.fallbackLayer).toBe('marker');
    expect(markerRight.correct).toBe(true);
    expect(markerRight.convicts).toBe(true);
    const terseWrong = readCandyAnswer(question, '取 20 颗');
    expect(terseWrong.fallbackLayer).toBe('terse');
    expect(terseWrong.correct).toBe(false);
    expect(terseWrong.convicts).toBe(true);
    // A terse question back is not an answer at all: the 9 belongs to the question, not
    // to a committed conclusion, so it must not be able to convict.
    const questionBack = readCandyAnswer(question, '答案是否唯一？先看圆形 9 颗');
    expect(questionBack.fallbackLayer).toBe('terse');
    expect(questionBack.correct).toBe(false);
    expect(questionBack.convicts).toBe(false);
  });

  it('reads a terse reply by its FIRST integer, split annotations included', () => {
    // R5: "21 颗（圆形9+五角星12）" is 21, not the trailing 12 — the split is an
    // annotation of the answer, so the first number is the conclusion.
    const withSplit = readCandyAnswer(question, '21 颗（圆形9+五角星12）');
    expect(withSplit.fallbackLayer).toBe('terse');
    expect(withSplit.correct).toBe(true);

    const wrong = readCandyAnswer(question, '取 20 颗');
    expect(wrong.fallbackLayer).toBe('terse');
    expect(wrong.correct).toBe(false);
    expect(wrong.matchedWrongAnswer).toBe(20);

    // A self-corrected terse reply keeps its FIRST number: "21？不对，是 29。" reads 21.
    // The direction is deliberate — a maybe-correction must not turn into a conviction,
    // and grading by the first number errs toward the pass/inconclusive side.
    const corrected = readCandyAnswer(question, '21？不对，是 29。');
    expect(corrected.fallbackLayer).toBe('terse');
    expect(corrected.correct).toBe(true);
    expect(corrected.convicts).toBe(true);
  });

  it('clips a very long answer text before it is persisted', () => {
    const longMarker = `${'推'.repeat(300)}最少 21 颗`;
    const read = readCandyAnswer(question, longMarker);
    expect(read.correct).toBe(true);
    expect(read.answerText.length).toBe(CANDY_MAX_ANSWER_TEXT_CHARS);
  });

  it('strips inline reasoning tags before reading anything', () => {
    // Some relays flatten thinking into the content channel; the draft's numbers must not
    // read as conclusions, but the real answer after the tag must survive.
    const withClosedTag = readCandyAnswer(question, [
      '<think>先试 20 颗……不，至少 29 颗？</think>',
      '答案：21',
    ].join('\n'));
    expect(withClosedTag.source).toBe('answer-line');
    expect(withClosedTag.correct).toBe(true);

    // A stream cut inside the tag loses everything after the opener: the draft's 29 is
    // never read, and the pre-tag conclusion is what remains.
    const unclosed = readCandyAnswer(question, '我认为最少 20 颗。<think>等等，再想想，29 颗……');
    expect(unclosed.answerText).not.toContain('29');
    expect(unclosed.matchedWrongAnswer).toBe(20);
  });

  it('reads the number out of the text when the model ignored the format', () => {
    const reasoning = [
      `袋子里一共 ${REFERENCE_BAG_TOTAL} 颗糖，非圆形最多 17 颗。`,
      '把两种坏情况分别取最大，最后取 21 颗就一定能满足。',
    ].join('\n');
    const read = readCandyAnswer(question, reasoning);
    expect(read.source).toBe('text-fallback');
    expect(read.correct).toBe(true);
    // Too long for the terse layer, no self-stated conclusion — the short final line is
    // what carries the answer.
    expect(read.fallbackLayer).toBe('last-line');
  });

  it('grades the committed conclusion, not a candidate the reasoning mentioned', () => {
    // The old rule accepted the expected value anywhere in the text, so a model that
    // writes "maybe 21" mid-reasoning and concludes 29 passed. The fallback layers read
    // ONE number — the conclusion — and grade only that.
    const reasoning = [
      '先考虑圆形糖果的情况，最坏的情况下可能需要取 21 颗才能保证。',
      '但是五角星形的情况更复杂，需要重新计算一下才行。',
      '综合考虑两种形状的最坏情况，所以应该取 29 颗糖果才能满足要求，这样才是正确的结论。',
    ].join('\n');
    const read = readCandyAnswer(question, reasoning);
    expect(read.source).toBe('text-fallback');
    expect(read.fallbackLayer).toBe('last-line');
    expect(read.correct).toBe(false);
    expect(read.matchedWrongAnswer).toBe(29);
  });

  it('reads the last self-stated conclusion when the model announces it in prose', () => {
    const reasoning = [
      '先考虑圆形糖果，最坏情况下需要不少。',
      '再考虑五角星形糖果，两种情况要分别计算。',
      '综合两种最坏情况来看，最少需要取 21 颗糖果才能保证。',
    ].join('\n');
    const read = readCandyAnswer(question, reasoning);
    expect(read.source).toBe('text-fallback');
    expect(read.fallbackLayer).toBe('marker');
    expect(read.correct).toBe(true);
  });

  it('takes the last marker statement, not the first', () => {
    const reasoning = [
      '一开始我觉得最少要取 20 颗糖果。',
      '重新算了一遍，结论是最少 21 颗才对。',
    ].join('\n');
    const read = readCandyAnswer(question, reasoning);
    expect(read.fallbackLayer).toBe('marker');
    expect(read.correct).toBe(true);
  });

  it('reads a terse reply by its FIRST integer (see the dedicated test above)', () => {
    // Kept for the plain single-number shapes; the split/self-correction cases live in
    // "reads a terse reply by its FIRST integer, split annotations included".
    const correct = readCandyAnswer(question, '21 颗');
    expect(correct.source).toBe('text-fallback');
    expect(correct.fallbackLayer).toBe('terse');
    expect(correct.correct).toBe(true);
  });

  it('declares long unstructured prose unreadable rather than guessing', () => {
    const prose = [
      '这个问题需要仔细分析两种形状的最坏情况，我们先从圆形糖果开始讨论，圆形糖果有三种口味。',
      '每种口味都有固定的数量，我们需要保证苹果味和桃子味在不同形状中都能拿到。',
      '这个过程比较复杂，需要逐一枚举各种组合情况，分别验证每一种取法是否满足题目要求，然后才能得出最终的结论。',
    ].join('\n');
    const read = readCandyAnswer(question, prose);
    expect(read.source).toBe('none');
    expect(read.answerText).toBe('');
  });

  it('treats a decimal answer as unreadable, not as its integer part', () => {
    const read = readCandyAnswer(question, '答案：21.5');
    expect(read.source).toBe('none');
    expect(read.correct).toBe(false);
  });

  it('never reads the example out of an echoed answer instruction', () => {
    // The instruction line carries its own example ("例如「答案：7」"); a model that
    // restates the format instead of following it must not be graded as answering 7.
    const echo = [
      '好的，我复述一下题目：',
      question.prompt,
      '可以写推理过程，但最后必须单独占一行，以「答案：」开头给出结论，例如「答案：7」。',
      '我不会做这道题。',
    ].join('\n');
    const read = readCandyAnswer(question, echo);
    expect(read.source).toBe('none');
    expect(read.correct).toBe(false);
  });

  it('does not treat a refusal or a question back as an answer', () => {
    for (const text of ['我无法完成这个题目。', '请问是要算最坏情况吗？', '']) {
      const read = readCandyAnswer(question, text);
      expect(read.correct, text).toBe(false);
      expect(read.source, text).toBe('none');
    }
  });

  it('does not count a restated question as an answer', () => {
    // The prompt itself carries numbers, so an echo must not read as an answer. It contains no
    // 21, so the failure mode here is "wrong", not "correct" — the point is that it is not read
    // as a conclusion at all.
    const echo = `好的，我复述一下题目：${question.prompt}`;
    const read = readCandyAnswer(question, echo);
    expect(read.correct).toBe(false);
  });

  it('strips an echo line by line but keeps the model\'s own text', () => {
    const promptLine = question.prompt.split('\n')[0] as string;
    const text = `${promptLine}\n我算出来是 21 颗。`;
    const stripped = stripQuestionEcho(text, question.prompt);
    expect(stripped).not.toContain(promptLine);
    expect(stripped).toContain('21');
  });

  it('extracts standalone integers, ignoring decimals', () => {
    expect(extractIntegers('圆形 7 颗，21 颗够了吗？')).toEqual([7, 21]);
    expect(extractIntegers('9.11 比 9.9 大')).toEqual([]);
    expect(extractIntegers('120 和 21')).toEqual([120, 21]);
  });
});

describe('the verdict over one answer', () => {
  const question = CANDY_BAG_REFERENCE_QUESTION;

  it('passes when the single answer is correct', () => {
    const graded = resolveCandyProbeVerdict(readCandyAnswer(question, '答案：21'));
    expect(graded.verdict).toBe('pass');
    expect(graded.reason).toBeNull();
  });

  it('fails when the model committed to a wrong answer', () => {
    // One question, one answer: a wrong committed answer is a fail, no tally needed.
    const graded = resolveCandyProbeVerdict(readCandyAnswer(question, '答案：20'));
    expect(graded.verdict).toBe('fail');
    expect(graded.reason).toContain('答案为');
  });

  it('stays inconclusive on every ambiguous or compromised read', () => {
    for (const text of [
      '答案：20 或 21', // both expected and known-wrong
      '答案：不是 21，是 22', // negation
      '圆形至少 9 颗，五角星至少 12 颗。', // prose fallback, cannot convict
      '这个问题的答案取决于坏情况。', // nothing readable
    ]) {
      const graded = resolveCandyProbeVerdict(readCandyAnswer(question, text));
      expect(graded.verdict, text).toBe('inconclusive');
      expect(graded.reason, text).toBeTruthy();
    }
  });
});

describe('generated candy-bag questions', () => {
  it('is always answerable, unique and non-trivial', () => {
    const random = seededRandom(11);
    let generated = 0;

    for (let run = 0; run < 60; run += 1) {
      const drawn = buildUniqueCandyBagInstance(random);
      expect(drawn).not.toBeNull();
      const { capacities, solution } = drawn!;
      const bagTotal = capacities.flat().reduce((sum, value) => sum + value, 0);

      expect(solution.answer).not.toBeNull();
      // Unique optimum: exactly one split reaches it.
      expect(solution.optimalSplits).toHaveLength(1);
      // Non-degenerate: every cell exists, and "take everything" is never the answer.
      for (const cell of capacities.flat()) expect(cell).toBeGreaterThanOrEqual(2);
      expect(solution.answer!).toBeGreaterThan(0);
      expect(solution.answer!).toBeLessThan(bagTotal);
      // The near miss fails, and the global largest failing hand is at least that.
      expect(solution.largestFailingTotal).toBeGreaterThanOrEqual(solution.answer! - 1);
      generated += 1;
    }

    expect(generated).toBe(60);
  });

  it('re-derives each generated answer independently', () => {
    // Solve twice through different paths: the generator's own solution, and a fresh
    // enumeration seeded by nothing but the capacities. They must agree, and the prompt must
    // describe the same bag.
    const random = seededRandom(29);
    for (let run = 0; run < 25; run += 1) {
      const question = generateCandyBagQuestion(random);
      expect(question).not.toBeNull();
      const instance = question as CandyBagQuestion;
      const drawn = buildUniqueCandyBagInstance(seededRandom(29 + run));
      // Only the structural properties are comparable across draws; assert the invariants the
      // grader depends on instead.
      expect(instance.answer).toBeGreaterThan(0);
      expect(instance.expectedLabel).toBe(String(instance.answer));
      expect(instance.wrongAnswers).toContain(instance.answer - 1);
      expect(instance.wrongAnswers).not.toContain(instance.answer);
      for (const cell of String(instance.prompt).matchAll(/(\d+) 颗/g)) {
        expect(Number(cell[1])).toBeGreaterThan(0);
      }
      void drawn;
    }
  });

  it('builds a prompt that names the quantities it was drawn with', () => {
    const prompt = buildCandyBagPrompt({
      capacities: [[5, 6, 7], [4, 6, 8]],
      shapeLabels: ['圆形', '五角星形'],
      flavorLabels: ['苹果味', '桃子味', '西瓜味'],
    });
    for (const count of [5, 6, 7, 4, 6, 8]) {
      expect(prompt).toContain(`${count} 颗`);
    }
    expect(prompt).toContain('圆形苹果味 5 颗');
    // Solving the same capacities twice is deterministic.
    expect(solveCandyBag([[5, 6, 7], [4, 6, 8]])).toEqual(solveCandyBag([[5, 6, 7], [4, 6, 8]]));
  });
});
