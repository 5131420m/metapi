/**
 * Candy-question bank and automatic grading for the degrade (降智) probe.
 *
 * Every question is chosen so that its answer is a short, language-independent,
 * machine-checkable token (a number, or one literal word). That is what makes the
 * verdict automatic: no judge model, no embedding comparison, no human.
 *
 * Two tiers exist because a battery made only of easy questions cannot discriminate:
 *
 * - `discriminative` questions are the ones weak / swapped models reliably get wrong
 *   (the classic "9.11 vs 9.9" and letter-counting traps).
 * - `basic` questions are a sanity floor: a healthy model never misses them, so
 *   missing several means the channel is not serving an intelligence at all.
 *
 * A run therefore always draws most of its questions from the discriminative tier.
 */

export type CandyQuestionTier = 'discriminative' | 'basic';

export type CandyAnswerRule =
  /** Grade the first number appearing in the answer. */
  | { kind: 'firstNumber'; value: number }
  /** Grade the LAST number: a reasoning answer puts its conclusion at the end. */
  | { kind: 'lastNumber'; value: number }
  /** Grade an exact literal answer, ignoring case, punctuation and spacing. */
  | { kind: 'exact'; value: string };

export type CandyQuestion = {
  id: string;
  tier: CandyQuestionTier;
  /** Chinese prompt: the question text handed to the model. */
  prompt: string;
  /** Human-readable expectation, shown in the UI detail panel. */
  expectedLabel: string;
  rule: CandyAnswerRule;
  /**
   * The classic wrong answers for this question.
   *
   * Used only when per-question attribution is impossible: a question whose expected
   * answer never appears while its canonical trap answer does is evidence of a weak
   * model, not of a formatting accident. Optional on purpose — inventing trap answers
   * for coverage would invent failures.
   */
  wrongAnswers?: readonly (number | string)[];
};

/**
 * Kept small and literal on purpose. Adding a question here is enough to widen the
 * battery; nothing else in the probe needs to change.
 */
export const CANDY_QUESTIONS: readonly CandyQuestion[] = [
  {
    id: 'compare-decimals',
    tier: 'discriminative',
    prompt: '9.11 和 9.9 哪个更大？只回答更大的那个数字。',
    expectedLabel: '9.9',
    rule: { kind: 'firstNumber', value: 9.9 },
    wrongAnswers: [9.11],
  },
  {
    id: 'count-r-strawberry',
    tier: 'discriminative',
    prompt: '单词 strawberry 里有几个字母 r？',
    expectedLabel: '3',
    rule: { kind: 'firstNumber', value: 3 },
    wrongAnswers: [2],
  },
  {
    id: 'count-a-banana',
    tier: 'discriminative',
    prompt: '单词 banana 里有几个字母 a？',
    expectedLabel: '3',
    rule: { kind: 'firstNumber', value: 3 },
    wrongAnswers: [2],
  },
  {
    id: 'literal-ok',
    tier: 'discriminative',
    prompt: '请只输出两个大写字母 OK，不要输出其他任何内容。',
    expectedLabel: 'OK',
    rule: { kind: 'exact', value: 'ok' },
    wrongAnswers: ['no'],
  },
  {
    id: 'count-hanzi',
    tier: 'discriminative',
    prompt: '“今天天气很好”这句话里有几个汉字？',
    expectedLabel: '6',
    rule: { kind: 'firstNumber', value: 6 },
  },
  {
    id: 'power-of-two',
    tier: 'basic',
    prompt: '2 的 10 次方等于多少？',
    expectedLabel: '1024',
    rule: { kind: 'firstNumber', value: 1024 },
    wrongAnswers: [512],
  },
  {
    id: 'square-area',
    tier: 'basic',
    prompt: '一个正方形的边长是 7，它的面积是多少？',
    expectedLabel: '49',
    rule: { kind: 'firstNumber', value: 49 },
    wrongAnswers: [28],
  },
  {
    id: 'decimal-sum',
    tier: 'basic',
    prompt: '0.5 加 0.25 等于多少？',
    expectedLabel: '0.75',
    rule: { kind: 'firstNumber', value: 0.75 },
  },
  {
    id: 'largest-of-three',
    tier: 'basic',
    prompt: '17、9、23 这三个数里哪个最大？只回答最大的那个数字。',
    expectedLabel: '23',
    rule: { kind: 'firstNumber', value: 23 },
    wrongAnswers: [17],
  },
  {
    id: 'count-to-ten',
    tier: 'basic',
    prompt: '从 1 数到 10，最后一个数字是几？',
    expectedLabel: '10',
    rule: { kind: 'firstNumber', value: 10 },
  },
];

export const DEFAULT_CANDY_QUESTION_COUNT = 3;
export const DEFAULT_CANDY_DISCRIMINATIVE_COUNT = 2;

function asTrimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Strip the noise that legitimately surrounds a correct answer (code fences, markdown
 * emphasis, full-width punctuation) before matching. Deliberately conservative: it must
 * never turn a wrong answer into a right one.
 */
export function normalizeCandyAnswer(raw: string): string {
  return asTrimmedText(raw)
    .replace(/```[a-zA-Z]*/g, ' ')
    .replace(/[`*_#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function extractCandyNumbers(text: string): number[] {
  const matches = asTrimmedText(text).match(/-?\d+(?:\.\d+)?/g);
  if (!matches) return [];
  return matches
    .map((match) => Number(match))
    .filter((value) => Number.isFinite(value));
}

function matchesRule(rule: CandyAnswerRule, rawAnswer: string): boolean {
  const normalized = normalizeCandyAnswer(rawAnswer);
  if (!normalized) return false;

  if (rule.kind === 'exact') {
    const compact = normalized.replace(/[^a-z0-9]+/g, '');
    const expectedCompact = rule.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    return compact.length > 0 && compact === expectedCompact;
  }

  const numbers = extractCandyNumbers(normalized);
  if (numbers.length <= 0) return false;
  const candidate = rule.kind === 'lastNumber' ? numbers[numbers.length - 1] : numbers[0];
  return Math.abs((candidate as number) - rule.value) < 1e-9;
}

/**
 * Does `token` appear in `text` as a standalone value?
 *
 * Boundaries matter: looking for `9.9` inside `9.11` (or `3` inside `13`) would let a
 * wrong answer count as a hit, which is exactly the false negative this whole check
 * exists to avoid.
 */
export function candyAnswerAppearsInText(token: number | string, text: string): boolean {
  const haystack = asTrimmedText(text).toLowerCase();
  if (!haystack) return false;

  if (typeof token === 'number') {
    const literal = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\d.])${literal}(?![\\d.])`).test(haystack);
  }

  const word = token.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!word) return false;
  return new RegExp(`(?<![a-z0-9])${word}(?![a-z0-9])`).test(haystack);
}

/** The answer token a question accepts as correct, for whole-text matching. */
function questionExpectedAppears(question: CandyQuestion, text: string): boolean {
  return candyAnswerAppearsInText(question.rule.value, text);
}

/**
 * A question is "actively wrong" only when its trap answer appears and its expected
 * answer does not. Checking both halves is what keeps a correct-but-verbose answer from
 * being scored as a wrong one.
 */
function questionAnsweredWrong(question: CandyQuestion, text: string): boolean {
  const traps = question.wrongAnswers ?? [];
  if (traps.length <= 0) return false;
  if (questionExpectedAppears(question, text)) return false;
  return traps.some((token) => candyAnswerAppearsInText(token, text));
}

/**
 * Grade one question against one answer.
 *
 * `firstNumber` lets a verbose-but-correct answer pass (`9.9 比 9.11 大`) while the
 * canonical wrong answer still fails (`9.11` never contains 9.9 first). `lastNumber`
 * exists for reasoning questions, where the conclusion — not the first figure quoted —
 * is the answer.
 */
export function judgeCandyAnswer(question: CandyQuestion, rawAnswer: string): boolean {
  return matchesRule(question.rule, rawAnswer);
}

function pickUnique<T>(pool: readonly T[], count: number, random: () => number): T[] {
  const remaining = [...pool];
  const picked: T[] = [];
  const target = Math.max(0, Math.min(count, remaining.length));
  while (picked.length < target) {
    const index = Math.min(remaining.length - 1, Math.max(0, Math.floor(random() * remaining.length)));
    picked.push(remaining.splice(index, 1)[0] as T);
  }
  return picked;
}

export function selectCandyQuestions(input: {
  count?: number;
  discriminativeCount?: number;
  random?: () => number;
  /** Restrict the draw to one tier (used by tests). */
  tier?: CandyQuestionTier;
} = {}): CandyQuestion[] {
  const random = input.random ?? Math.random;
  const count = Math.max(1, Math.trunc(input.count ?? DEFAULT_CANDY_QUESTION_COUNT));
  const pool = input.tier
    ? CANDY_QUESTIONS.filter((question) => question.tier === input.tier)
    : [...CANDY_QUESTIONS];
  if (pool.length <= 0) return [];

  const discriminative = pool.filter((question) => question.tier === 'discriminative');
  const basic = pool.filter((question) => question.tier !== 'discriminative');
  const requestedDiscriminative = input.tier
    ? pool.length
    : Math.max(0, Math.trunc(input.discriminativeCount ?? DEFAULT_CANDY_DISCRIMINATIVE_COUNT));

  let picked = pickUnique(discriminative, Math.min(requestedDiscriminative, count), random);
  if (picked.length < count) {
    picked = picked.concat(pickUnique(basic, count - picked.length, random));
  }
  if (picked.length < count) {
    const chosen = new Set(picked.map((question) => question.id));
    picked = picked.concat(pickUnique(
      pool.filter((question) => !chosen.has(question.id)),
      count - picked.length,
      random,
    ));
  }

  // Shuffle so neither the order nor the tier pattern is stable across runs: a fixed
  // shape is trivial for a relay to fingerprint and special-case.
  for (let index = picked.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.min(index, Math.max(0, Math.floor(random() * (index + 1))));
    const current = picked[index] as CandyQuestion;
    picked[index] = picked[swapIndex] as CandyQuestion;
    picked[swapIndex] = current;
  }

  return picked;
}

/**
 * Ask for every answer in one request, with a strict line format.
 *
 * One request keeps the probe cheap and fast (a button click, not a batch job), and the
 * format is what makes per-question attribution possible in the detail panel.
 */
export function buildCandyProbePrompt(questions: readonly CandyQuestion[]): string {
  return [
    `请依次回答下面 ${questions.length} 道题。`,
    '每题只输出答案本身，不要解释，不要输出单位或多余文字。',
    '每道题单独占一行，格式为「题号:答案」。',
    '',
    ...questions.map((question, index) => `${index + 1}. ${question.prompt}`),
  ].join('\n');
}

export type CandyAnswerParseMode = 'numbered' | 'lines' | 'none';

export type CandyAnswerParseResult = {
  mode: CandyAnswerParseMode;
  /** Aligned with the questions array; empty string when the answer was not found. */
  answers: string[];
};

/**
 * A leading list marker: `1:`, `1. `, `第1题：`, `2、`.
 *
 * The `.` separator requires following whitespace on purpose — `9.9` is a decimal answer,
 * not question 9, and treating it as a marker would silently truncate a correct answer to
 * `9`.
 */
const NUMBERED_LINE_PATTERN = /^\s*(?:第\s*)?(\d{1,2})\s*(?:题)?\s*(?:[:：、)）]|\.(?=\s))\s*(.+)$/;

function splitCandidateLines(text: string): string[] {
  return asTrimmedText(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-•]\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * Split one completion into per-question answers.
 *
 * `numbered` is the requested format. `lines` is the common near-miss where the model
 * dropped the numbering but kept one answer per line — accepted because the line count
 * still pins each answer to a question. Anything else is `none`, and the caller must not
 * turn an unparseable answer into a "degraded" verdict: it resolves that case by looking
 * for the expected answers anywhere in the text (see `gradeCandyProbeRun`).
 */
export function parseCandyAnswers(input: {
  questions: readonly CandyQuestion[];
  text: string;
}): CandyAnswerParseResult {
  const lines = splitCandidateLines(input.text);
  const answers = input.questions.map(() => '');

  let numberedHits = 0;
  for (const line of lines) {
    const match = line.match(NUMBERED_LINE_PATTERN);
    if (!match) continue;
    const questionIndex = Number(match[1]) - 1;
    if (questionIndex < 0 || questionIndex >= input.questions.length) continue;
    if (answers[questionIndex]) continue;
    answers[questionIndex] = asTrimmedText(match[2]);
    numberedHits += 1;
  }
  if (numberedHits >= input.questions.length) {
    return { mode: 'numbered', answers };
  }

  if (lines.length === input.questions.length) {
    return {
      mode: 'lines',
      answers: lines.map((line) => {
        const match = line.match(NUMBERED_LINE_PATTERN);
        return asTrimmedText(match ? match[2] : line);
      }),
    };
  }

  return { mode: 'none', answers };
}

export type CandyProbeVerdict = import('../../../shared/candyProbe.js').CandyProbeVerdict;

export type CandyGradedQuestion = import('../../../shared/candyProbe.js').CandyProbeQuestionResult;

export type CandyProbeGrade = {
  verdict: CandyProbeVerdict;
  score: number;
  total: number;
  answered: number;
  parseMode: CandyAnswerParseMode;
  reason: string | null;
  questions: CandyGradedQuestion[];
};

/** Truncation stop reasons, kept together so both call sites agree on the vocabulary. */
const CANDY_TRUNCATION_STOP_REASONS = new Set(['max_tokens', 'length', 'incomplete']);

function isTruncatedStopReason(stopReason: string | null | undefined): boolean {
  return typeof stopReason === 'string' && CANDY_TRUNCATION_STOP_REASONS.has(stopReason.trim().toLowerCase());
}

/** A short excerpt of the raw answer, so a verdict can be diagnosed without the trace. */
function excerptForReason(text: string): string {
  const flat = asTrimmedText(text).replace(/\s+/g, ' ');
  if (!flat) return '';
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/**
 * The pass threshold for a run, derived from the question count.
 *
 * This is the ONLY place the threshold is decided. It used to be a fixed constant that
 * callers passed in, which silently disagreed with the question count: a 1-question run
 * graded against a threshold of 2 could never pass, and a 6-question run passed on 2.
 * Two thirds (rounded up, never below one) keeps the intent — clearly more right than
 * wrong — at every battery size.
 */
export function resolveCandyPassThreshold(total: number): number {
  const safeTotal = Math.max(1, Math.trunc(total));
  return Math.max(1, Math.min(safeTotal, Math.ceil(safeTotal * 2 / 3)));
}

/**
 * Grade a whole run.
 *
 * The failure modes are asymmetric on purpose: a channel wrongly declared degraded loses
 * availability for a real user, while a missed degradation only leaves today's behaviour
 * unchanged. So every ambiguous case (unparseable output, empty output, truncation)
 * resolves to `inconclusive` rather than `fail` — `inconclusive` never blocks anything.
 */
export function gradeCandyProbeRun(input: {
  questions: readonly CandyQuestion[];
  text: string;
  stopReason?: string | null;
}): CandyProbeGrade {
  const questions = input.questions;
  const total = questions.length;
  const threshold = resolveCandyPassThreshold(total);
  const parsed = parseCandyAnswers({ questions, text: input.text });
  const expectedAnswers = questions.map((question) => question.expectedLabel);

  const graded = questions.map((question, index) => {
    const answer = parsed.mode === 'none' ? '' : (parsed.answers[index] || '');
    return {
      id: question.id,
      prompt: question.prompt,
      expected: expectedAnswers[index] as string,
      answer,
      correct: answer.length > 0 && judgeCandyAnswer(question, answer),
    };
  });
  const score = graded.filter((item) => item.correct).length;
  const answered = graded.filter((item) => item.answer.length > 0).length;
  const truncationNote = isTruncatedStopReason(input.stopReason) ? '（输出长度达到上限）' : '';
  // Whole-text evidence about the answers, used when per-question attribution failed.
  const wrongHits = questions.filter((question) => questionAnsweredWrong(question, input.text)).length;
  const rightHits = questions.filter((question) => questionExpectedAppears(question, input.text)).length;
  // How many questions we have ANY signal for: a parsed answer, or whole-text evidence.
  const addressed = parsed.mode === 'none' ? rightHits + wrongHits : answered;
  // With no per-question attribution, "addressed" is the honest count to report: it is how
  // many questions we can say something about, which is what the UI wants to show.
  const reportedAnswered = parsed.mode === 'none' ? addressed : answered;

  if (!asTrimmedText(input.text)) {
    return {
      verdict: 'inconclusive',
      score,
      total,
      answered,
      parseMode: parsed.mode,
      reason: `模型未返回可判分内容${truncationNote}`,
      questions: graded,
    };
  }

  // Cut off mid-answer with questions unaccounted for: the missing answers are an artefact
  // of the cut, not a property of the model, so the run cannot be scored either way. This
  // is checked before the whole-text rescue below, which would otherwise read a truncated
  // answer as "enough questions were right".
  if (truncationNote && addressed < total) {
    return {
      verdict: 'inconclusive',
      score,
      total,
      answered: reportedAnswered,
      parseMode: parsed.mode,
      reason: `输出被截断，仅答出 ${addressed}/${total} 题${truncationNote}`,
      questions: graded,
    };
  }

  if (parsed.mode === 'none') {
    // The output did not follow the requested shape. That on its own is NOT degradation:
    // a relay answering 200 with "insufficient quota", a refusal, or a truncated body all
    // land here, and calling them "疑似降智" would be a wrong conclusion.
    //
    // The only thing that can rescue a verdict from this state is evidence about the
    // answers themselves, and it must be whole-text evidence, because per-question
    // attribution is exactly what is unavailable.
    const excerpt = excerptForReason(input.text);

    if (wrongHits >= threshold) {
      return {
        verdict: 'fail',
        score: 0,
        total,
        answered: reportedAnswered,
        parseMode: parsed.mode,
        reason: `回答格式不符，且命中 ${wrongHits} 个已知错误答案`
          + (excerpt ? `｜原文：${excerpt}` : ''),
        questions: graded,
      };
    }
    if (rightHits >= threshold) {
      return {
        verdict: 'pass',
        score: rightHits,
        total,
        answered: reportedAnswered,
        parseMode: parsed.mode,
        reason: null,
        questions: graded,
      };
    }
    return {
      verdict: 'inconclusive',
      score: 0,
      total,
      answered: reportedAnswered,
      parseMode: parsed.mode,
      reason: `回答格式不符，无法逐题判分（命中预期 ${rightHits} / 命中已知错误 ${wrongHits}，阈值 ${threshold}）`
        + (excerpt ? `｜原文：${excerpt}` : ''),
      questions: graded,
    };
  }

  if (answered <= 0) {
    return {
      verdict: 'inconclusive',
      score,
      total,
      answered,
      parseMode: parsed.mode,
      reason: '模型未返回可判分内容',
      questions: graded,
    };
  }

  const passed = score >= threshold;
  return {
    verdict: passed ? 'pass' : 'fail',
    score,
    total,
    answered,
    parseMode: parsed.mode,
    reason: passed ? null : `答对 ${score}/${total}，低于通过阈值 ${threshold}`,
    questions: graded,
  };
}
