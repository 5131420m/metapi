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
  },
  {
    id: 'count-r-strawberry',
    tier: 'discriminative',
    prompt: '单词 strawberry 里有几个字母 r？',
    expectedLabel: '3',
    rule: { kind: 'firstNumber', value: 3 },
  },
  {
    id: 'count-a-banana',
    tier: 'discriminative',
    prompt: '单词 banana 里有几个字母 a？',
    expectedLabel: '3',
    rule: { kind: 'firstNumber', value: 3 },
  },
  {
    id: 'literal-ok',
    tier: 'discriminative',
    prompt: '请只输出两个大写字母 OK，不要输出其他任何内容。',
    expectedLabel: 'OK',
    rule: { kind: 'exact', value: 'ok' },
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
  },
  {
    id: 'square-area',
    tier: 'basic',
    prompt: '一个正方形的边长是 7，它的面积是多少？',
    expectedLabel: '49',
    rule: { kind: 'firstNumber', value: 49 },
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
  const first = numbers[0] as number;
  return Math.abs(first - rule.value) < 1e-9;
}

/**
 * Grade one question against one answer.
 *
 * The "first number wins" rule is what makes verbose-but-correct answers pass
 * (`9.9 比 9.11 大` is correct) while the canonical wrong answer fails
 * (`9.11` never contains 9.9 first).
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

export type CandyProbeVerdict = 'pass' | 'fail' | 'inconclusive';

export type CandyGradedQuestion = {
  id: string;
  prompt: string;
  expected: string;
  answer: string;
  correct: boolean;
};

export type CandyProbeGrade = {
  verdict: CandyProbeVerdict;
  score: number;
  total: number;
  answered: number;
  parseMode: CandyAnswerParseMode;
  reason: string | null;
  questions: CandyGradedQuestion[];
};

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
  minCorrect: number;
  stopReason?: string | null;
}): CandyProbeGrade {
  const questions = input.questions;
  const total = questions.length;
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

  if (!asTrimmedText(input.text)) {
    const truncationNote = input.stopReason === 'max_tokens' || input.stopReason === 'length'
      ? '（输出长度达到上限）'
      : '';
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

  if (parsed.mode === 'none') {
    // The answer did not follow the requested shape. Before calling that degradation,
    // check whether the expected answers are present anywhere in the text: if they are,
    // the model was right and only the format drifted.
    const wholeTextHits = questions.filter((question) => judgeCandyAnswer(question, input.text)).length;
    if (wholeTextHits > 0) {
      return {
        verdict: 'inconclusive',
        score,
        total,
        answered,
        parseMode: parsed.mode,
        reason: '回答格式不符，但包含预期答案，无法逐题判分',
        questions: graded,
      };
    }
    return {
      verdict: 'fail',
      score: 0,
      total,
      answered,
      parseMode: parsed.mode,
      reason: '回答格式不符，且未命中任何预期答案',
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

  const passed = score >= Math.max(1, Math.trunc(input.minCorrect));
  return {
    verdict: passed ? 'pass' : 'fail',
    score,
    total,
    answered,
    parseMode: parsed.mode,
    reason: passed ? null : `答对 ${score}/${total}，低于通过阈值`,
    questions: graded,
  };
}
