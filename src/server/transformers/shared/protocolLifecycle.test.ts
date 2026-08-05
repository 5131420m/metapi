import { describe, expect, it, vi } from 'vitest';

import { createProxyStreamLifecycle } from './protocolLifecycle.js';

describe('createProxyStreamLifecycle', () => {
  it('routes reader failures to onReadError and closes the response', async () => {
    const onReadError = vi.fn();
    const response = { end: vi.fn() };
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        throw new Error('reader failed');
      },
      async cancel() {},
      releaseLock: vi.fn(),
    };
    const lifecycle = createProxyStreamLifecycle({
      reader,
      response,
      pullEvents: () => ({ events: [], rest: '' }),
      handleEvent: () => {},
      onReadError,
    });

    await lifecycle.run();

    expect(onReadError).toHaveBeenCalledWith(expect.objectContaining({ message: 'reader failed' }));
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('does not classify parser failures as reader failures', async () => {
    const onReadError = vi.fn();
    const response = { end: vi.fn() };
    let reads = 0;
    const reader = {
      async read() {
        reads += 1;
        return reads === 1
          ? { done: false, value: new TextEncoder().encode('data: value\n\n') }
          : { done: true };
      },
      async cancel() {},
      releaseLock: vi.fn(),
    };
    const lifecycle = createProxyStreamLifecycle({
      reader,
      response,
      pullEvents: () => {
        throw new Error('parser failed');
      },
      handleEvent: () => {},
      onReadError,
    });

    await expect(lifecycle.run()).rejects.toThrow('parser failed');
    expect(onReadError).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('does not classify downstream handler failures as reader failures', async () => {
    const onReadError = vi.fn();
    const response = { end: vi.fn() };
    let reads = 0;
    const reader = {
      async read() {
        reads += 1;
        return reads === 1
          ? { done: false, value: new TextEncoder().encode('data: value\n\n') }
          : { done: true };
      },
      async cancel() {},
      releaseLock: vi.fn(),
    };
    const lifecycle = createProxyStreamLifecycle({
      reader,
      response,
      pullEvents: () => ({ events: ['value'], rest: '' }),
      handleEvent: () => {
        throw new Error('handler failed');
      },
      onReadError,
    });

    await expect(lifecycle.run()).rejects.toThrow('handler failed');
    expect(onReadError).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('rethrows reader failures when no onReadError handler is supplied', async () => {
    const response = { end: vi.fn() };
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        throw new Error('reader failed without handler');
      },
      async cancel() {},
      releaseLock: vi.fn(),
    };
    const lifecycle = createProxyStreamLifecycle({
      reader,
      response,
      pullEvents: () => ({ events: [], rest: '' }),
      handleEvent: () => {},
    });

    await expect(lifecycle.run()).rejects.toThrow('reader failed without handler');
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('still cleans up exactly once when onReadError itself throws', async () => {
    const response = { end: vi.fn() };
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        throw new Error('reader failed');
      },
      async cancel() {},
      releaseLock: vi.fn(),
    };
    const lifecycle = createProxyStreamLifecycle({
      reader,
      response,
      pullEvents: () => ({ events: [], rest: '' }),
      handleEvent: () => {},
      onReadError: () => {
        throw new Error('terminal writer failed');
      },
    });

    await expect(lifecycle.run()).rejects.toThrow('terminal writer failed');
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
    expect(response.end).toHaveBeenCalledTimes(1);
  });

  it('does not invoke onEof after a reader failure has produced a terminal', async () => {
    const onEof = vi.fn();
    const onReadError = vi.fn();
    const response = { end: vi.fn() };
    let reads = 0;
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        reads += 1;
        if (reads === 1) {
          return { done: false, value: new TextEncoder().encode('data: partial\n\n') };
        }
        throw new Error('reader failed mid-stream');
      },
      async cancel() {},
      releaseLock: vi.fn(),
    };
    const lifecycle = createProxyStreamLifecycle({
      reader,
      response,
      pullEvents: (buffer) => ({ events: buffer.includes('partial') ? ['partial'] : [], rest: '' }),
      handleEvent: () => {},
      onEof,
      onReadError,
    });

    await lifecycle.run();

    expect(onReadError).toHaveBeenCalledTimes(1);
    expect(onEof).not.toHaveBeenCalled();
    expect(response.end).toHaveBeenCalledTimes(1);
  });
});
