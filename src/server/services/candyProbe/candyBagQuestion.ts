/**
 * The candy-bag question, and how one answer is read and graded.
 *
 * WHY THIS IS A SINGLE QUESTION
 *
 * The probe used to bundle three questions per request (two "discriminative", one easy) and
 * grade them together. That design failed in four separate ways, and all four follow from the
 * bundle rather than from the questions:
 *
 * - the candy question — the only one that separates a swapped model from a healthy one — was
 *   drawn ~22% of the time, so most runs measured `9.11 vs 9.9`;
 * - the easy questions are answered correctly by every current model, including the cheap
 *   ones a relay substitutes, so "pass" carried almost no information while looking credible;
 * - one request had to carry all three answers in a rigid format ("one line per question, no
 *   explanation"), which suppresses the reasoning the hard question needs;
 * - with no baseline, "degraded" really meant "this model got it wrong", which is wrong for a
 *   small model that is expected to fail it.
 *
 * So: one question per sample, reasoning allowed, several samples per verdict (see
 * `candyProbeService`), and the answer read from a dedicated answer line.
 *
 * GRADING (fixes the reported false negative)
 *
 * The old rule took the LAST number of the answer text. "21（圆形 9 颗 + 五角星形 12 颗）" —
 * the most natural way a model writes it — ends in 12 and was graded wrong. The reader below
 * prefers the last `答案：N` line and, within it, accepts the expected value anywhere as a
 * standalone integer, so an explanation next to the conclusion cannot invert the verdict.
 */

export const CANDY_BAG_SHAPE_LABELS = ['圆形', '五角星形'] as const;
export const CANDY_BAG_FLAVOR_LABELS = ['苹果味', '桃子味', '西瓜味'] as const;

/**
 * One candy-bag question, with the fields the probe needs.
 *
 * Deliberately flat: the battery is one question, so there is no tier system and no bundled
 * answer format to satisfy.
 */
export type CandyBagQuestion = {
  id: string;
  prompt: string;
  /** Human-readable expected answer, for the detail panel. */
  expectedLabel: string;
  /** The exact answer the grader accepts. */
  answer: number;
  /**
   * The classic wrong answers: `answer - 1` (the near miss — the largest total that still
   * fails) and the bag total ("take everything").
   */
  wrongAnswers: readonly number[];
};

/** Build the prompt for one instance. Used by the reference question and the generator. */
export function buildCandyBagPrompt(input: {
  capacities: readonly (readonly number[])[];
  shapeLabels: readonly string[];
  flavorLabels: readonly string[];
}): string {
  const [shapeA, shapeB] = input.shapeLabels as [string, string];
  const [flavorA, flavorB, flavorC] = input.flavorLabels as [string, string, string];
  const cell = (shape: number, flavor: number): string => {
    const count = input.capacities[shape]?.[flavor] ?? 0;
    const shapeName = shape === 0 ? shapeA : shapeB;
    const flavorName = flavor === 0 ? flavorA : flavor === 1 ? flavorB : flavorC;
    return `${shapeName}${flavorName} ${count} 颗`;
  };
  return [
    `在一个黑色的袋子里放有三种口味的糖果（${flavorA}、${flavorB}、${flavorC}），`,
    `每种糖果有两种形状（${shapeA}和${shapeB}）。`,
    '形状可以凭手感分辨，允许在袋内按形状挑选，但无法辨认口味，取出的糖果不能放回。',
    `已知数量：${cell(0, 0)}、${cell(0, 1)}、${cell(0, 2)}；`,
    `${cell(1, 0)}、${cell(1, 1)}、${cell(1, 2)}。`,
    `参赛者需要在活动前决定分别摸出多少颗${shapeA}糖果和多少颗${shapeB}糖果。`,
    `最少取出多少颗糖果，才能保证手中同时拥有不同形状的${flavorA}和${flavorB}`,
    `（即：有${shapeA}${flavorA}且有${shapeB}${flavorB}，或者有${shapeA}${flavorB}且有${shapeB}${flavorA}，都算满足）？`,
  ].join('');
}

/**
 * The original question, in the operator's own wording.
 *
 * Kept verbatim because the community's "candy question" is this exact bag: a result on it is
 * comparable to what people measure by hand. The answer is 21, at the unique split
 * round=9 / star=12, re-derived from every possible composition in the test rather than
 * trusted — a hand-derived answer was wrong here once already.
 */
export const CANDY_BAG_REFERENCE_QUESTION: CandyBagQuestion = {
  id: 'candy-bag-reference',
  prompt: buildCandyBagPrompt({
    capacities: [[7, 9, 8], [7, 6, 4]],
    shapeLabels: CANDY_BAG_SHAPE_LABELS,
    flavorLabels: CANDY_BAG_FLAVOR_LABELS,
  }),
  expectedLabel: '21',
  answer: 21,
  // Wrong answers a model plausibly lands on. Only 20 is unsafe under EVERY split (one
  // short of the minimum guaranteeing total); 28/29/34/41 each admit a safe split that is
  // simply not the minimum (e.g. 28 = 11 round + 17 star), which is what makes them
  // convincing near-misses:
  //   20 — the near miss: no split of 20 guarantees the goal;
  //   28 — the largest total that still admits a failing split (24 round + 4 star: the
  //        four stars can all be watermelon), i.e. "take the whole worst case";
  //   29 — "compute the worst case, add one", the classic off-by-one;
  //   34 — the mis-transcription with "at least 5 mint" instead of "at least 5 star";
  //   41 — the whole bag: safe, but the question asks for the minimum.
  // These values only enrich the sample note; the verdict never depends on them.
  wrongAnswers: [20, 28, 29, 34, 41],
};

/** The instruction appended to every candy question. */
export const CANDY_BAG_ANSWER_INSTRUCTION =
  '可以写推理过程，但最后必须单独占一行，以「答案：」开头给出结论，例如「答案：7」。';

/** The prompt actually sent: the question, then how to answer it. */
export function buildCandyProbePrompt(question: CandyBagQuestion): string {
  return `${question.prompt}\n${CANDY_BAG_ANSWER_INSTRUCTION}`;
}

export type CandyAnswerSource = 'answer-line' | 'text-fallback' | 'none';

/**
 * Which fallback rule read the conclusion, when the model ignored the `答案：` format.
 *
 * Kept as a separate field rather than more `source` values: the verdict logic only cares
 * about readable-or-not, while the sample note cares about exactly which compromise was
 * made — an operator reading "按末行数字判定" knows the verdict rests on a reading
 * heuristic, not on the model's own committed line.
 */
export type CandyFallbackLayer = 'terse' | 'marker' | 'last-line';

export type CandyAnswerRead = {
  source: CandyAnswerSource;
  /** The text the verdict was read from ('' when nothing was readable). */
  answerText: string;
  /** True when the expected value appears in the read text. */
  correct: boolean;
  /** A known wrong answer that appears, when the expected one does not. */
  matchedWrongAnswer: number | null;
  /** Which fallback rule produced this read; null for the answer line and for `none`. */
  fallbackLayer: CandyFallbackLayer | null;
  /**
   * Whether this read may support a FAIL verdict when it did not hit the answer.
   *
   * The answer line and a terse reply are the model's own commitment — a wrong number there
   * convicts. The prose fallbacks (marker, last line) are reading compromises: they can
   * PROVE the model answered correctly, but a wrong number read out of prose may be an
   * intermediate value the reasoning discarded ("圆形至少 9 颗，五角星至少 12 颗" reads 12),
   * so a wrong fallback read makes the sample invalid instead of wrong.
   */
  convicts: boolean;
};

/**
 * Layer-2 threshold: a reply this short IS the answer, so its first integer is the
 * conclusion — no marker required.
 */
export const CANDY_FALLBACK_TERSE_MAX_CHARS = 32;

/**
 * Layer-4 threshold: only a short final line is trusted to end on its conclusion. A long
 * final paragraph may end mid-reasoning, and its last integer is then an intermediate
 * number, not a committed answer.
 */
export const CANDY_FALLBACK_LAST_LINE_MAX_CHARS = 64;

/**
 * One question, one answer: the verdict of a single-shot probe.
 *
 * - correct        → `pass`
 * - a committed wrong answer (answer line or single-number terse reply, `convicts`) → `fail`
 * - everything else — ambiguous reads, prose fallbacks that missed the answer, nothing
 *   readable — is `inconclusive`: the model never committed to an answer, and treating
 *   that as wrong would mark quota errors and 502s as "答错".
 *
 * Upstream failures, timeouts and truncation never reach this function: the service
 * short-circuits them to `inconclusive` with their own reason.
 */
export function resolveCandyProbeVerdict(read: CandyAnswerRead): {
  verdict: 'pass' | 'fail' | 'inconclusive';
  reason: string | null;
} {
  if (read.correct) return { verdict: 'pass', reason: null };
  // The answer line or a single-number terse reply IS the model's own conclusion: a wrong
  // one is a wrong answer, not a reading compromise.
  if (read.source !== 'none' && read.convicts) {
    return { verdict: 'fail', reason: `答案为 ${read.answerText}` };
  }
  return {
    verdict: 'inconclusive',
    reason: read.source === 'none'
      ? '没有可判读的答案'
      : '未找到答案行，正文读数不能作为不通过的依据',
  };
}

/**
 * A dedicated conclusion line: `答案：21` / `最终答案: 21` / `答案是 21`, optionally wrapped in
 * markdown (`### 答案：21`, `**答案**：21`) — models love to decorate the one line we asked for.
 *
 * `答案是` must be followed by a number (the lookahead): "答案是否唯一？…" is a question the
 * model asks itself, not a committed answer, and the 9 that follows its "圆形 9 颗" used to
 * be misread as the conclusion. The `.` separator is still not accepted: "答案 21" with no
 * separator is ambiguous with prose, and a wrong guess here silently inverts a verdict.
 */
const ANSWER_LINE_PATTERN = /^\s*#{0,6}\s*\*{0,2}(?:最终)?答案(?:\*{0,2}\s*[:：]|\s*是\s*[:：]?(?=\s*\**\s*\d))\s*(.+?)\s*\*{0,2}\s*$/;

/** Words that REJECT the number next to them: the stated value is being denied, not committed. */
const NEGATION_PATTERN = /(不是|而非|并非|而不是|\bnot\b)/;

/**
 * Remove inline reasoning tags that some relays leave INSIDE the content channel.
 *
 * Structured reasoning is already excluded by the response parser; this is the unstructured
 * escape — a relay flattening `` into content. The prose fallbacks would
 * otherwise read the draft's numbers as conclusions; a truncated stream that never closes
 * the tag loses everything after the opener, which is exactly the reasoning we did not want.
 */
export function stripInlineReasoningTags(text: string): string {
  const withoutClosed = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  const openTagAt = withoutClosed.search(/<think(?:ing)?>/i);
  return openTagAt >= 0 ? withoutClosed.slice(0, openTagAt) : withoutClosed;
}

/** Standalone integer: not part of a longer number, and not the fraction of a decimal. */
function containsInteger(haystack: string, value: number): boolean {
  const literal = String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${literal}(?![\\d.])`).test(haystack);
}

/** Integers present in a piece of text, in order of appearance. */
export function extractIntegers(text: string): number[] {
  const found: number[] = [];
  const pattern = /(?<![\d.])(\d{1,4})(?![\d.])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    found.push(Number(match[1]));
  }
  return found;
}

/** "共 21 颗" / "总共需要 21" / "total 21"：总数短语是最强的结论信号。 */
const TOTAL_PHRASE_PATTERN =
  /(?:共|总共|一共|合计|总计|\btotal\b)\s*(?:取|需|要|需要|是|为)?\s*(\d{1,4})(?![\d.])/i;

/** 行首数字（可带"至少/最少/共"等前缀）："21 颗，即 9 + 12" 的 21。 */
const LEADING_NUMBER_PATTERN = /^\s*(?:约|共|最少|至少|需要|要|取)?\s*(\d{1,4})(?![\d.])/;

/**
 * 答案行的规范化：去掉 \boxed{}、$、*、`，并删除括号里的说明。
 * 括号里是解释（"21（= 9 + 12）"、"21 (round=9, star=12)"），不是结论；
 * 留着它会让"最后一个 = 后的数"取到 9。
 */
function normalizeAnswerLine(line: string): string {
  return line
    .replace(/\\boxed\{([^}]*)\}/g, '$1')
    .replace(/[$*`]/g, '')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .trim();
}

type AnswerLineConclusion =
  | { kind: 'value'; value: number; strong: boolean }
  | { kind: 'none' };

/**
 * 读出答案行的结论数。strong=true 表示这个数可以作为定罪依据。
 * 优先级：总数短语 > 最后一个 "=" 之后的第一个数 > 唯一的数 > 行首数字 > 第一个数（weak）。
 */
function readAnswerLineConclusion(body: string): AnswerLineConclusion {
  const numbers = extractIntegers(body);
  if (numbers.length === 0) return { kind: 'none' };

  const total = body.match(TOTAL_PHRASE_PATTERN);
  if (total) return { kind: 'value', value: Number(total[1]), strong: true };

  const lastEqualsAt = body.lastIndexOf('=');
  if (lastEqualsAt >= 0) {
    const after = extractIntegers(body.slice(lastEqualsAt + 1));
    if (after.length > 0) return { kind: 'value', value: after[0]!, strong: true };
  }

  if (numbers.length === 1) return { kind: 'value', value: numbers[0]!, strong: true };

  const leading = body.match(LEADING_NUMBER_PATTERN);
  if (leading) return { kind: 'value', value: Number(leading[1]), strong: true };

  // 多个数、没有总数、行首也不是数字（"圆形 9 颗、五角星形 12 颗"）：只能证明通过，不能定罪
  return { kind: 'value', value: numbers[0]!, strong: false };
}

/**
 * Cap on the persisted `answerText` (R8): the value only feeds the detail panel and the
 * usage-log note, and an unbounded relay answer would bloat the settings row the result is
 * persisted into.
 */
export const CANDY_MAX_ANSWER_TEXT_CHARS = 200;

function clipAnswerText(text: string): string {
  return text.length > CANDY_MAX_ANSWER_TEXT_CHARS ? text.slice(0, CANDY_MAX_ANSWER_TEXT_CHARS) : text;
}

/** An answer that cannot be graded in either direction. The original text is still kept. */
const unreadableRead = (answerText: string): CandyAnswerRead => ({
  source: 'none',
  answerText: clipAnswerText(answerText),
  correct: false,
  matchedWrongAnswer: null,
  fallbackLayer: null,
  convicts: false,
});

/**
 * Grade ONE captured answer line (the text after `答案：`).
 *
 * Order: empty → negation (on the RAW text, before paren-stripping could hide it) →
 * both-answers-present → no number → correct → expected-mentioned-but-not-conclusion →
 * weak conclusion (recorded, never convicting) → committed wrong answer.
 */
function readAnswerLine(question: CandyBagQuestion, raw: string): CandyAnswerRead {
  const answerText = raw.trim();
  if (answerText.length === 0) return unreadableRead(answerText);
  // 1. A negation rejects the number next to it: "不是 21，是 22" tells us 21 is wrong.
  //    Which number survives is a parse of prose, not a commitment — in both directions.
  if (NEGATION_PATTERN.test(answerText)) return unreadableRead(answerText);
  // 2. Parentheses carry explanations ("21（= 9 + 12）"), not conclusions: grade the
  //    normalized body, so an `=` inside a parenthetical cannot steal the conclusion.
  const body = normalizeAnswerLine(answerText);
  // 3. Both the expected answer and a known wrong one: which one the model committed to
  //    is a guess ("20 或 21"), and a guess here silently inverts a verdict.
  const hasExpected = containsInteger(body, question.answer);
  const hasKnownWrong = question.wrongAnswers.some((value) => containsInteger(body, value));
  if (hasExpected && hasKnownWrong) return unreadableRead(answerText);
  // 4. The conclusion; no number at all (a refusal, prose) is not something to judge.
  const conclusion = readAnswerLineConclusion(body);
  if (conclusion.kind === 'none') return unreadableRead(answerText);
  // 5. Committed conclusion equals the answer.
  if (conclusion.kind === 'value' && conclusion.value === question.answer) {
    return {
      source: 'answer-line',
      answerText: clipAnswerText(answerText),
      correct: true,
      matchedWrongAnswer: null,
      fallbackLayer: null,
      convicts: true,
    };
  }
  // 6. The expected answer appears but is not the conclusion ("22 还是 21"、"共 2 种形状，
  //    21 颗"): the model mentioned it without committing to it.
  if (hasExpected) return unreadableRead(answerText);
  // 7. A weak conclusion (several numbers, no total phrase, no leading number — "圆形 9
  //    颗、五角星形 12 颗") is a split statement, not a committed total: it can never
  //    convict, so the run stays inconclusive rather than turning a split into a wrong
  //    answer.
  if (conclusion.kind === 'value' && !conclusion.strong) {
    return {
      source: 'answer-line',
      answerText: clipAnswerText(answerText),
      correct: false,
      matchedWrongAnswer: null,
      fallbackLayer: null,
      convicts: false,
    };
  }
  // 8. Otherwise the conclusion is the model's committed answer on a trusted line — even
  //    when it is a number neither expected nor known-wrong.
  return {
    source: 'answer-line',
    answerText: clipAnswerText(answerText),
    correct: false,
    matchedWrongAnswer: question.wrongAnswers.includes(conclusion.value) ? conclusion.value : null,
    fallbackLayer: null,
    convicts: true,
  };
}

/**
 * Remove a verbatim echo of the question from the completion.
 *
 * Only the fallback path needs this: the question text contains the counts (and for the
 * reference bag, nothing that equals the answer), so a model that restates the question must
 * not be read as having answered it. Line-by-line, so partial echoes still count as echoes.
 */
export function stripQuestionEcho(text: string, prompt: string): string {
  const promptLines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8);
  if (promptLines.length === 0) return text;
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      // Drop a line that is (a fragment of) the prompt: the counts it quotes are not answers.
      const isEcho = promptLines.some((promptLine) => trimmed.includes(promptLine));
      return isEcho ? '' : line;
    })
    .join('\n');
}

/**
 * A conclusion the model stated in prose, e.g. "最少 21 颗" / "at least 21".
 *
 * Deliberately excludes the summation words (合计/总共/一共/最多): reasoning sums the bag
 * mid-derivation, and octopus measured exactly that — a sum word grabbing an intermediate
 * total and grading it as the answer. Only words that introduce a CONCLUSION are markers.
 */
const FALLBACK_MARKER_PATTERN = /(答案|answer|最少|至少|minimum|at\s*least|结论)[^\d\n]{0,10}?(\d{1,4})/gi;

/**
 * The LAST self-stated conclusion in the text, with the line it appears on.
 *
 * An earlier statement may be a candidate the model went on to reject, so the last one
 * wins. `matchAll` clones the shared regex, so its `lastIndex` is never mutated here.
 */
function readLastMarkerConclusion(text: string): { value: number; context: string } | null {
  let found: { value: number; context: string } | null = null;
  for (const line of text.split(/\r?\n/)) {
    for (const match of line.matchAll(FALLBACK_MARKER_PATTERN)) {
      const value = Number(match[2]);
      if (Number.isFinite(value)) found = { value, context: line.trim() };
    }
  }
  return found;
}

function lastNonEmptyLine(text: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}

/**
 * Read one answer out of a completion.
 *
 * Layer 1 — the `答案：…` lines, in order; the LAST one is the model's final word. The
 * conclusion of a line is read with a priority that matches how models actually write
 * totals: a total phrase ("共 21 颗") beats a stated sum ("9 + 12 = 21"), which beats the
 * only/leading number. Parenthetical explanations ("21（= 9 + 12）", "21 (round=9,
 * star=12)") are stripped before grading — they are not conclusions. A line with several
 * numbers and no total ("圆形 9 颗、五角星形 12 颗") is a split statement: it can prove a
 * pass but never convict. A line that carries BOTH the expected answer and a known wrong
 * one ("答案：20 或 21"), or that merely mentions the expected answer ("22 还是 21"), is
 * ambiguous in both directions and is therefore invalid — a guess here silently inverts a
 * verdict. And when several answer lines contradict each other (the last one wrong while
 * an earlier one was right), neither direction may be believed.
 *
 * Layers 2–4 — the model ignored the format, so the conclusion has to be found in the prose.
 * The old rule graded the expected value wherever it appeared in the whole text, which a
 * thinking model defeats by writing "maybe 21… no, 29" mid-reasoning. Each layer now reads
 * ONE number — the model's committed conclusion — and grades only that:
 *
 * 2. terse: a very short reply IS the answer, its first integer is the conclusion — and a
 *    single-number reply without a question mark may convict; several numbers, or a
 *    question back, can only prove a pass;
 * 3. marker: the last self-stated conclusion ("最少 21 颗", "at least 21");
 * 4. last line: a short final line, its last integer is what the reply ends on.
 *
 * The prose layers 3–4 can only PROVE the model answered correctly. A wrong number read
 * out of prose may be an intermediate value the reasoning went on to discard ("圆形至少
 * 9 颗，五角星至少 12 颗" reads 12), so a wrong prose read is an INVALID sample, never a
 * wrong one — the direction stays "rather inconclusive than a false degradation".
 *
 * Layer 5 — nothing the model committed to. That is "unreadable", never "wrong": a refusal
 * or a question back is not evidence about the model's arithmetic.
 */
export function readCandyAnswer(question: CandyBagQuestion, rawText: string): CandyAnswerRead {
  // Some relays flatten reasoning into the content channel; the prose layers would read
  // the draft's numbers as conclusions. Strip before anything else looks at the text.
  const text = stripInlineReasoningTags(rawText);
  const lines = text.split(/\r?\n/);
  // Layer 1 — every `答案：…` line, in order. The LAST one is the model's final word
  // (an earlier one may be a candidate it went on to correct), but a last line that
  // convicts while an earlier one already gave the correct conclusion is a model
  // contradicting itself, and a contradiction is not a commitment.
  const answerLines: string[] = [];
  for (const line of lines) {
    const match = line.match(ANSWER_LINE_PATTERN);
    if (match) answerLines.push(match[1] ?? '');
  }

  if (answerLines.length > 0) {
    const reads = answerLines.map((line) => readAnswerLine(question, line));
    const last = reads[reads.length - 1]!;
    // The last line convicts, but an earlier answer line already gave the correct
    // conclusion: the model contradicts itself, so neither direction may be believed.
    if (!last.correct && last.convicts && reads.slice(0, -1).some((read) => read.correct)) {
      return unreadableRead(answerLines[answerLines.length - 1]!.trim());
    }
    // "先答错、再改对"（答案：20 … 答案：21）still grades as the corrected last line.
    return last;
  }

  // No conclusion line. Strip the question AND the answer-instruction echoes: the
  // instruction line carries its own example ("例如「答案：7」"), whose 7 must never be
  // read as this model's conclusion.
  const stripped = stripQuestionEcho(text, `${question.prompt}\n${CANDY_BAG_ANSWER_INSTRUCTION}`);

  const gradeFallback = (
    value: number,
    context: string,
    layer: CandyFallbackLayer,
    convicts: boolean,
  ): CandyAnswerRead => ({
    source: 'text-fallback',
    answerText: clipAnswerText(context),
    correct: value === question.answer,
    matchedWrongAnswer: question.wrongAnswers.includes(value) ? value : null,
    fallbackLayer: layer,
    convicts,
  });

  // Layer 2: terse. A reply this short cannot be an excerpt of reasoning — but only a
  // SINGLE-number reply is "obviously the answer", and a question back is not an answer at
  // all ("答案是否唯一？…"). The FIRST integer is the conclusion: "21 颗（圆形 9 + 五角星
  // 12）" grades by the 21, not by the trailing split. One number may convict; several
  // numbers — or a question mark — can only prove a pass.
  const terse = stripped.trim();
  const terseNumbers = extractIntegers(terse);
  if (terse.length > 0 && terse.length <= CANDY_FALLBACK_TERSE_MAX_CHARS && terseNumbers.length > 0) {
    const terseValue = terseNumbers[0]!;
    const committed = terseNumbers.length === 1 && !/[?？]/.test(terse);
    return gradeFallback(
      terseValue,
      terse,
      'terse',
      terseValue === question.answer || committed,
    );
  }

  // Layer 3: the last self-stated conclusion. Prose: proves a pass, never convicts.
  const marker = readLastMarkerConclusion(stripped);
  if (marker) return gradeFallback(marker.value, marker.context, 'marker', marker.value === question.answer);

  // Layer 4: a short final line. Same rule: proves a pass, never convicts.
  const lastLine = lastNonEmptyLine(stripped);
  if (lastLine && lastLine.length <= CANDY_FALLBACK_LAST_LINE_MAX_CHARS) {
    const lineNumbers = extractIntegers(lastLine);
    if (lineNumbers.length > 0) {
      return gradeFallback(lineNumbers[lineNumbers.length - 1]!, lastLine, 'last-line', false);
    }
  }

  // Layer 5: unreadable.
  return { source: 'none', answerText: '', correct: false, matchedWrongAnswer: null, fallbackLayer: null, convicts: false };
}
