import { describe, expect, it } from 'vitest';
import {
  CANDY_QUESTIONS,
  buildCandyProbePrompt,
  candyAnswerAppearsInText,
  gradeCandyProbeRun,
  judgeCandyAnswer,
  parseCandyAnswers,
  resolveCandyPassThreshold,
  selectCandyQuestions,
  type CandyQuestion,
} from './questionBank.js';

const compareDecimals = CANDY_QUESTIONS.find((question) => question.id === 'compare-decimals') as CandyQuestion;
const countR = CANDY_QUESTIONS.find((question) => question.id === 'count-r-strawberry') as CandyQuestion;
const literalOk = CANDY_QUESTIONS.find((question) => question.id === 'literal-ok') as CandyQuestion;
const candyBags = CANDY_QUESTIONS.find((question) => question.id === 'candy-bags-three-flavors') as CandyQuestion;

describe('the multi-constraint candy-bag question', () => {
  // The answer is 21, and it was checked by hand before being written down: with 24 round and
  // 17 star candies, the bad hands are (≤8 round), (≤17 round∧≤10 star), (≤15 round∧≤11 star)
  // and (≤4 mint), whose maxima are 8+17=25? — no: each bad hand is bounded separately and the
  // largest is 20, so 21 draws always succeed and 20 does not.
  it('is in the bank with the unique minimum as its answer', () => {
    expect(candyBags).toBeDefined();
    expect(candyBags.expectedLabel).toBe('21');
    expect(candyBags.rule).toEqual({ kind: 'lastNumber', value: 21 });
    // A reasoning answer leads with other counts, so `firstNumber` would grade the wrong one.
    expect(candyBags.tier).toBe('discriminative');
  });

  it('grades a full reasoning answer by its conclusion', () => {
    const reasoning = [
      '最坏情况是不满足任一条件。',
      '至少 9 颗圆形：非圆形最多 17 颗，还需 9 颗，共 26？',
      '由于非圆形全部取完后只剩圆形，所以取 17+9=26 可保证 9 颗圆形。',
      '综合考虑四组限制，答案为 21。',
    ].join('\n');
    const result = gradeCandyProbeRun({
      questions: [candyBags],
      text: `1: ${reasoning}`,
    });
    expect(result.verdict).toBe('pass');
    expect(result.score).toBe(1);
  });

  it('treats the plausible wrong answers as failures', () => {
    for (const wrong of [17, 24, 28]) {
      const result = gradeCandyProbeRun({
        questions: [candyBags],
        text: `1: 最少要取 ${wrong} 颗。`,
      });
      expect(result.verdict, `answer ${wrong}`).toBe('fail');
      expect(result.score).toBe(0);
    }
  });
});

describe('candy question grading', () => {
  it('accepts the correct answer and rejects the canonical degraded answer', () => {
    expect(judgeCandyAnswer(compareDecimals, '9.9')).toBe(true);
    expect(judgeCandyAnswer(compareDecimals, '9.11')).toBe(false);
  });

  it('accepts a verbose answer as long as the first number is right', () => {
    expect(judgeCandyAnswer(compareDecimals, '9.9 比 9.11 大')).toBe(true);
    expect(judgeCandyAnswer(countR, '3 个字母 r')).toBe(true);
  });

  it('keeps the wrong number wrong even when surrounded by text', () => {
    expect(judgeCandyAnswer(countR, 'strawberry 里有 2 个 r')).toBe(false);
  });

  it('grades literal answers ignoring case, spacing and trailing punctuation', () => {
    expect(judgeCandyAnswer(literalOk, 'OK')).toBe(true);
    expect(judgeCandyAnswer(literalOk, 'ok.')).toBe(true);
    expect(judgeCandyAnswer(literalOk, 'Sure! OK')).toBe(false);
    expect(judgeCandyAnswer(literalOk, '')).toBe(false);
  });

  it('strips code fences and markdown emphasis before matching', () => {
    expect(judgeCandyAnswer(compareDecimals, '```\n9.9\n```')).toBe(true);
    expect(judgeCandyAnswer(compareDecimals, '**9.9**')).toBe(true);
  });
});

describe('candy answer parsing', () => {
  const questions = [compareDecimals, countR, literalOk];

  it('parses the requested numbered format', () => {
    const parsed = parseCandyAnswers({
      questions,
      text: '1: 9.9\n2: 3\n3: OK',
    });
    expect(parsed.mode).toBe('numbered');
    expect(parsed.answers).toEqual(['9.9', '3', 'OK']);
  });

  it('accepts one answer per line when the numbering is dropped', () => {
    const parsed = parseCandyAnswers({
      questions,
      text: '9.9\n3\nOK',
    });
    expect(parsed.mode).toBe('lines');
    expect(parsed.answers).toEqual(['9.9', '3', 'OK']);
  });

  it('reports an unparseable answer instead of guessing', () => {
    const parsed = parseCandyAnswers({
      questions,
      text: '我认为第一题是 9.9，第二题的话需要仔细数一数字母，第三题就输出 OK 吧。',
    });
    expect(parsed.mode).toBe('none');
    expect(parsed.answers).toEqual(['', '', '']);
  });

  it('tolerates full-width separators and bullet prefixes', () => {
    const parsed = parseCandyAnswers({
      questions,
      text: '- 1: 9.9\n- 2：3\n- 3、OK',
    });
    expect(parsed.mode).toBe('numbered');
    expect(parsed.answers).toEqual(['9.9', '3', 'OK']);
  });

  it('does not mistake a decimal answer for a question marker', () => {
    const parsed = parseCandyAnswers({
      questions,
      text: '9.9\n3\nOK',
    });
    expect(parsed.answers).toEqual(['9.9', '3', 'OK']);
  });
});

describe('candy pass threshold', () => {
  it('scales with the question count instead of being fixed', () => {
    // The threshold used to be a fixed 2 while the API allows 1..6 questions, which made a
    // 1-question run unpassable and a 6-question run passable on 2.
    expect([1, 2, 3, 4, 5, 6].map(resolveCandyPassThreshold)).toEqual([1, 2, 2, 3, 4, 4]);
  });

  it('never demands more than the battery contains', () => {
    for (let total = 1; total <= 12; total += 1) {
      const threshold = resolveCandyPassThreshold(total);
      expect(threshold).toBeGreaterThanOrEqual(1);
      expect(threshold).toBeLessThanOrEqual(total);
    }
  });
});

describe('candy run grading', () => {
  const questions = [compareDecimals, countR, literalOk];

  it('passes when the score reaches the threshold', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '1: 9.9\n2: 3\n3: OK',
    });
    expect(grade.verdict).toBe('pass');
    expect(grade.score).toBe(3);
    expect(grade.total).toBe(3);
    expect(grade.reason).toBeNull();
  });

  it('fails when the score is below the threshold', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '1: 9.11\n2: 2\n3: OK',
    });
    expect(grade.verdict).toBe('fail');
    expect(grade.score).toBe(1);
    expect(grade.reason).toContain('1/3');
    expect(grade.reason).toContain('2');
  });

  it('passes a single-question battery answered correctly', () => {
    const grade = gradeCandyProbeRun({ questions: [compareDecimals], text: '1: 9.9' });
    expect(grade.verdict).toBe('pass');
    expect(grade.score).toBe(1);
    expect(grade.total).toBe(1);
  });

  it('fails a six-question battery that only got two right', () => {
    const six = [
      compareDecimals, countR, literalOk,
      { ...compareDecimals, id: 'a' }, { ...countR, id: 'b' }, { ...literalOk, id: 'c' },
    ];
    const grade = gradeCandyProbeRun({
      questions: six,
      text: '1: 9.9\n2: 3\n3: NO\n4: 9.11\n5: 2\n6: NO',
    });
    expect(grade.total).toBe(6);
    expect(grade.score).toBe(2);
    expect(grade.verdict).toBe('fail');
  });

  it('never fails on an empty completion', () => {
    const grade = gradeCandyProbeRun({ questions, text: '' });
    expect(grade.verdict).toBe('inconclusive');
    expect(grade.reason).toContain('未返回可判分内容');
  });

  it('notes truncation when the model ran out of output budget', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '',
      stopReason: 'max_tokens',
    });
    expect(grade.verdict).toBe('inconclusive');
    expect(grade.reason).toContain('上限');
  });

  it('stays inconclusive when the format drifted but the answers are present', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '第一题答案是 9.9。',
    });
    expect(grade.verdict).toBe('inconclusive');
    expect(grade.reason).toContain('格式不符');
  });

  it('fails a well-formed answer that missed every question', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '1: 9.1\n2: 1\n3: NO',
    });
    expect(grade.verdict).toBe('fail');
    expect(grade.score).toBe(0);
  });

  it('does not call a refusal degradation just because the format is unparseable', () => {
    // A relay answering 200 with a refusal, or with "insufficient quota", is a transport /
    // availability problem. Grading it "疑似降智" would be a wrong conclusion.
    const grade = gradeCandyProbeRun({
      questions,
      text: '抱歉，我无法回答这个问题。',
    });
    expect(grade.verdict).toBe('inconclusive');
    expect(grade.reason).toContain('格式不符');
    expect(grade.reason).toContain('原文');
  });

  it('fails an unparseable answer that states the known wrong answers', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '我的判断：第一个是 9.11 更大，第二个有 2 个 r，第三个我不能确定。',
    });
    expect(grade.verdict).toBe('fail');
    expect(grade.reason).toContain('已知错误答案');
  });

  it('passes an unparseable answer that states enough expected answers', () => {
    const grade = gradeCandyProbeRun({
      questions,
      // 9.9 and 3 are both present as standalone values; only the layout drifted.
      text: '我算出来分别是 9.9、3，最后一题我写在下面。',
    });
    expect(grade.verdict).toBe('pass');
    expect(grade.score).toBe(2);
  });

  it('stays inconclusive when only part of the answer survived a truncation', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '1: 9.9\n2: 3',
      stopReason: 'length',
    });
    expect(grade.verdict).toBe('inconclusive');
    expect(grade.reason).toContain('截断');
    // Two questions have whole-text evidence even though the format broke down.
    expect(grade.answered).toBe(2);
  });

  it('still grades a complete answer that reported a truncation stop reason', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '1: 9.9\n2: 3\n3: OK',
      stopReason: 'max_tokens',
    });
    expect(grade.verdict).toBe('pass');
  });

  it('carries per-question detail for the UI', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '1: 9.9\n2: 2\n3: OK',
    });
    expect(grade.questions).toHaveLength(3);
    expect(grade.questions[0]).toMatchObject({ id: 'compare-decimals', answer: '9.9', correct: true });
    expect(grade.questions[1]).toMatchObject({ id: 'count-r-strawberry', answer: '2', correct: false, expected: '3' });
  });
});

describe('candy answer rules', () => {
  it('grades the last number for reasoning-style questions', () => {
    const question = {
      id: 'guarantee',
      tier: 'discriminative' as const,
      prompt: 'x',
      expectedLabel: '21',
      rule: { kind: 'lastNumber' as const, value: 21 },
    };
    expect(judgeCandyAnswer(question, '21')).toBe(true);
    expect(judgeCandyAnswer(question, '9 + 12 = 21')).toBe(true);
    expect(judgeCandyAnswer(question, '答案是：圆形 9 颗、五角星 12 颗，共 21 颗')).toBe(true);
    expect(judgeCandyAnswer(question, '20')).toBe(false);
    expect(judgeCandyAnswer(question, '答案是 21，另外 9 号袋子也要看')).toBe(false);
  });

  it('matches whole-text tokens on real boundaries only', () => {
    expect(candyAnswerAppearsInText(9.9, '9.9 更大')).toBe(true);
    expect(candyAnswerAppearsInText(9.9, '9.11 更大')).toBe(false);
    expect(candyAnswerAppearsInText(9.9, '19.9')).toBe(false);
    expect(candyAnswerAppearsInText(9.9, '9.90')).toBe(false);
    expect(candyAnswerAppearsInText(3, '有 3 个 r')).toBe(true);
    expect(candyAnswerAppearsInText(3, '有 13 个 r')).toBe(false);
    expect(candyAnswerAppearsInText('ok', 'OK')).toBe(true);
    expect(candyAnswerAppearsInText('no', 'nothing')).toBe(false);
  });
});

describe('candy question selection', () => {
  it('draws mostly discriminative questions and never repeats one', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const questions = selectCandyQuestions({ random: makeSeededRandom(seed) });
      expect(questions).toHaveLength(3);
      expect(new Set(questions.map((question) => question.id)).size).toBe(3);
      const discriminative = questions.filter((question) => question.tier === 'discriminative');
      expect(discriminative.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('is deterministic for a given random source', () => {
    const first = selectCandyQuestions({ random: makeSeededRandom(7) }).map((question) => question.id);
    const second = selectCandyQuestions({ random: makeSeededRandom(7) }).map((question) => question.id);
    expect(first).toEqual(second);
  });

  it('can restrict the draw to a single tier', () => {
    const basic = selectCandyQuestions({ tier: 'basic', count: 4, random: makeSeededRandom(3) });
    expect(basic).toHaveLength(4);
    expect(basic.every((question) => question.tier === 'basic')).toBe(true);
  });

  it('builds a prompt that numbers every question', () => {
    const questions = [compareDecimals, countR, literalOk];
    const prompt = buildCandyProbePrompt(questions);
    expect(prompt).toContain('1. 9.11 和 9.9');
    expect(prompt).toContain('3. 请只输出两个大写字母 OK');
    expect(prompt).toContain('格式为「题号:答案」');
  });
});

function makeSeededRandom(seed: number): () => number {
  let state = seed + 1;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}
