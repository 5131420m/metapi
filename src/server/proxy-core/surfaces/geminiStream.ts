import { parseProxyUsage } from '../../services/proxyUsageParser.js';

type GeminiStreamReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock(): void;
};

type GeminiStreamResult = {
  status: 'completed' | 'failed';
  committed: boolean;
  errorMessage: string | null;
  usage: ReturnType<typeof parseProxyUsage>;
  rawStreamText: string;
};

export async function pipeGeminiSseStream(input: {
  reader: GeminiStreamReader;
  commit: () => void;
  write: (line: string) => void;
  consume: (buffer: string) => { rest: string; lines: string[] };
  aggregateState: unknown;
  captureRaw: boolean;
}): Promise<GeminiStreamResult> {
  const decoder = new TextDecoder();
  let rest = '';
  let rawStreamText = '';
  let committed = false;
  let terminalSeen = false;

  const emit = (lines: string[]) => {
    for (const line of lines) {
      if (line.includes('[DONE]')) terminalSeen = true;
      if (!committed) {
        input.commit();
        committed = true;
      }
      input.write(line);
    }
  };

  try {
    while (true) {
      const { done, value } = await input.reader.read();
      if (done) break;
      if (!value) continue;
      const chunkText = decoder.decode(value, { stream: true });
      if (input.captureRaw) rawStreamText += chunkText;
      const consumed = input.consume(rest + chunkText);
      rest = consumed.rest;
      emit(consumed.lines);
    }
    const tail = decoder.decode();
    if (tail) {
      if (input.captureRaw) rawStreamText += tail;
      const consumed = input.consume(rest + tail);
      rest = consumed.rest;
      emit(consumed.lines);
    }
    return {
      status: 'completed',
      committed,
      errorMessage: null,
      usage: parseProxyUsage(input.aggregateState),
      rawStreamText,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Gemini upstream stream failed';
    if (committed && !terminalSeen) {
      input.write(`event: error\ndata: ${JSON.stringify({ error: { message: errorMessage, type: 'upstream_error' } })}\n\n`);
      input.write('data: [DONE]\n\n');
    }
    return {
      status: 'failed',
      committed,
      errorMessage,
      usage: parseProxyUsage(input.aggregateState),
      rawStreamText,
    };
  } finally {
    input.reader.releaseLock();
  }
}
