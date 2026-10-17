import { describe, expect, it } from 'vitest';
import {
  CANDY_QUESTIONS,
  buildCandyProbePrompt,
  gradeCandyProbeRun,
  judgeCandyAnswer,
  parseCandyAnswers,
  selectCandyQuestions,
  type CandyQuestion,
} from './questionBank.js';

const compareDecimals = CANDY_QUESTIONS.find((question) => question.id === 'compare-decimals') as CandyQuestion;
const countR = CANDY_QUESTIONS.find((question) => question.id === 'count-r-strawberry') as CandyQuestion;
const literalOk = CANDY_QUESTIONS.find((question) => question.id === 'literal-ok') as CandyQuestion;

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

describe('candy run grading', () => {
  const questions = [compareDecimals, countR, literalOk];

  it('passes when the score reaches the threshold', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '1: 9.9\n2: 3\n3: OK',
      minCorrect: 2,
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
      minCorrect: 2,
    });
    expect(grade.verdict).toBe('fail');
    expect(grade.score).toBe(1);
    expect(grade.reason).toContain('1/3');
  });

  it('never fails on an empty completion', () => {
    const grade = gradeCandyProbeRun({ questions, text: '', minCorrect: 2 });
    expect(grade.verdict).toBe('inconclusive');
    expect(grade.reason).toContain('未返回可判分内容');
  });

  it('notes truncation when the model ran out of output budget', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '',
      minCorrect: 2,
      stopReason: 'max_tokens',
    });
    expect(grade.verdict).toBe('inconclusive');
    expect(grade.reason).toContain('上限');
  });

  it('stays inconclusive when the format drifted but the answers are present', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '第一题答案是 9.9。',
      minCorrect: 2,
    });
    expect(grade.verdict).toBe('inconclusive');
    expect(grade.reason).toContain('格式不符');
  });

  it('fails a well-formed answer that missed every question', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '1: 9.1\n2: 1\n3: NO',
      minCorrect: 2,
    });
    expect(grade.verdict).toBe('fail');
    expect(grade.score).toBe(0);
  });

  it('fails an unparseable answer that contains no expected answer at all', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '抱歉，我无法回答这个问题。',
      minCorrect: 2,
    });
    expect(grade.verdict).toBe('fail');
    expect(grade.score).toBe(0);
    expect(grade.reason).toContain('未命中');
  });

  it('carries per-question detail for the UI', () => {
    const grade = gradeCandyProbeRun({
      questions,
      text: '1: 9.9\n2: 2\n3: OK',
      minCorrect: 2,
    });
    expect(grade.questions).toHaveLength(3);
    expect(grade.questions[0]).toMatchObject({ id: 'compare-decimals', answer: '9.9', correct: true });
    expect(grade.questions[1]).toMatchObject({ id: 'count-r-strawberry', answer: '2', correct: false, expected: '3' });
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
