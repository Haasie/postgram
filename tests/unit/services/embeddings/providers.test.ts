import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APIUserAbortError } from 'openai';

import {
  createEmbeddingProvider,
  createOpenAICompatibleEmbeddingProvider,
  createOpenAIEmbeddingProvider,
  OPENAI_COMPATIBLE_MAX_BATCH_INPUTS,
  resolveEmbeddingDefaults
} from '../../../../src/services/embeddings/providers.js';
import { AppError, ErrorCode, RateLimitError } from '../../../../src/util/errors.js';

describe('resolveEmbeddingDefaults', () => {
  it('returns OpenAI defaults when unset', () => {
    expect(resolveEmbeddingDefaults('openai')).toEqual({
      model: 'text-embedding-3-small',
      dimensions: 1536
    });
  });

  it('returns Ollama defaults when unset', () => {
    expect(resolveEmbeddingDefaults('ollama')).toEqual({
      model: 'bge-m3',
      dimensions: 1024
    });
  });

  it('honors explicit overrides', () => {
    expect(resolveEmbeddingDefaults('ollama', 'nomic-embed-text', 768)).toEqual({
      model: 'nomic-embed-text',
      dimensions: 768
    });
  });
});

describe('OpenAI embedding provider', () => {
  it('returns embeddings ordered by input index', async () => {
    const create = vi.fn().mockResolvedValue({
      data: [
        { index: 1, embedding: [0.1, 0.2] },
        { index: 0, embedding: [0.3, 0.4] }
      ]
    });

    const provider = createOpenAIEmbeddingProvider(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 2,
        apiKey: 'sk-test'
      },
      { embeddings: { create } }
    );

    const vectors = await provider.embedBatch(['a', 'b']);

    expect(vectors).toEqual([[0.3, 0.4], [0.1, 0.2]]);
    const [params, options] = create.mock.calls[0] as [
      Record<string, unknown>,
      { signal?: AbortSignal } | undefined
    ];
    expect(params).toEqual({
      model: 'text-embedding-3-small',
      input: ['a', 'b'],
      encoding_format: 'float',
      dimensions: 2
    });
    // Deadline signal spanning all retry attempts.
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('throws EMBEDDING_FAILED on dimension mismatch', async () => {
    const create = vi.fn().mockResolvedValue({
      data: [{ index: 0, embedding: [0.1] }]
    });

    const provider = createOpenAIEmbeddingProvider(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 2,
        apiKey: 'sk-test'
      },
      { embeddings: { create } }
    );

    await expect(provider.embed('hello')).rejects.toMatchObject({
      code: ErrorCode.EMBEDDING_FAILED,
      message: 'Embedding dimension mismatch'
    });
  });

  it('does not pass dimensions to the API when using the default', async () => {
    const create = vi.fn().mockResolvedValue({
      data: [{ index: 0, embedding: new Array<number>(1536).fill(0.1) }]
    });

    const provider = createOpenAIEmbeddingProvider(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        apiKey: 'sk-test'
      },
      { embeddings: { create } }
    );

    await provider.embed('hi');
    const params = create.mock.calls[0]?.[0] as { dimensions?: number };
    expect(params.dimensions).toBeUndefined();
  });

  it('passes dimensions to the API when set to a non-default value', async () => {
    const create = vi.fn().mockResolvedValue({
      data: [{ index: 0, embedding: new Array<number>(512).fill(0.1) }]
    });

    const provider = createOpenAIEmbeddingProvider(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 512,
        apiKey: 'sk-test'
      },
      { embeddings: { create } }
    );

    await provider.embed('hi');
    const params = create.mock.calls[0]?.[0] as { dimensions?: number };
    expect(params.dimensions).toBe(512);
  });

  it('wraps arbitrary client errors as EMBEDDING_FAILED', async () => {
    const create = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));
    const provider = createOpenAIEmbeddingProvider(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 2,
        apiKey: 'sk-test'
      },
      { embeddings: { create } }
    );

    await expect(provider.embed('x')).rejects.toBeInstanceOf(AppError);
    await expect(provider.embed('x')).rejects.toMatchObject({
      code: ErrorCode.EMBEDDING_FAILED,
      message: '401 Unauthorized'
    });
  });

  it('passes a deadline signal that spans the whole call, not one attempt', async () => {
    // The SDK applies `timeout` per HTTP attempt and retries timed-out
    // attempts, so `timeout` alone cannot bound the operation. The provider
    // must hand the SDK an AbortSignal covering all attempts.
    const create = vi.fn().mockResolvedValue({
      data: [{ index: 0, embedding: [0.1, 0.2] }]
    });
    const provider = createOpenAIEmbeddingProvider(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 2,
        apiKey: 'sk-test',
        timeoutMs: 5_000
      },
      { embeddings: { create } }
    );

    await provider.embed('x');

    const options = create.mock.calls[0]?.[1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(options?.signal).toBeDefined();
    expect(options?.signal?.aborted).toBe(false);
  });

  it('reports an aborted deadline as a timeout rather than a generic failure', async () => {
    const create = vi.fn().mockImplementation(() => {
      // Mirrors how the SDK surfaces an aborted signal.
      return Promise.reject(new APIUserAbortError());
    });
    const provider = createOpenAIEmbeddingProvider(
      {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 2,
        apiKey: 'sk-test',
        timeoutMs: 1_234
      },
      { embeddings: { create } }
    );

    await expect(provider.embed('x')).rejects.toMatchObject({
      code: ErrorCode.EMBEDDING_FAILED,
      message: 'OpenAI embedding call timed out after 1234ms'
    });
  });
});

describe('Ollama embedding provider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts to /api/embeddings and returns the embedding', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    );

    const provider = createEmbeddingProvider({
      provider: 'ollama',
      model: 'bge-m3',
      dimensions: 4,
      baseUrl: 'http://ollama.local:11434'
    });

    const vector = await provider.embed('hello');

    expect(vector).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://ollama.local:11434/api/embeddings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'bge-m3', prompt: 'hello' })
      })
    );
  });

  it('loops sequentially for embedBatch and preserves order', async () => {
    let call = 0;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      call += 1;
      const embedding = call === 1 ? [1, 1] : [2, 2];
      return Promise.resolve(new Response(JSON.stringify({ embedding }), { status: 200 }));
    });

    const provider = createEmbeddingProvider({
      provider: 'ollama',
      model: 'bge-m3',
      dimensions: 2,
      baseUrl: 'http://ollama.local'
    });

    const vectors = await provider.embedBatch(['a', 'b']);
    expect(vectors).toEqual([[1, 1], [2, 2]]);
    expect(call).toBe(2);
  });

  it('adds bearer auth header when apiKey is provided', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ embedding: [0, 0] }), { status: 200 })
    );

    const provider = createEmbeddingProvider({
      provider: 'ollama',
      model: 'bge-m3',
      dimensions: 2,
      baseUrl: 'http://ollama.local',
      apiKey: 'secret'
    });

    await provider.embed('hi');

    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer secret');
  });

  it('throws EMBEDDING_FAILED on non-2xx', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response('model not found', { status: 404 })
    );

    const provider = createEmbeddingProvider({
      provider: 'ollama',
      model: 'bge-m3',
      dimensions: 2,
      baseUrl: 'http://ollama.local'
    });

    await expect(provider.embed('hi')).rejects.toMatchObject({
      code: ErrorCode.EMBEDDING_FAILED,
      details: expect.objectContaining({ status: 404 }) as Record<string, unknown>
    });
  });

  it('throws EMBEDDING_FAILED on network failure', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TypeError('fetch failed')
    );

    const provider = createEmbeddingProvider({
      provider: 'ollama',
      model: 'bge-m3',
      dimensions: 2,
      baseUrl: 'http://ollama.local'
    });

    await expect(provider.embed('hi')).rejects.toMatchObject({
      code: ErrorCode.EMBEDDING_FAILED,
      message: expect.stringContaining('unreachable') as unknown as string
    });
  });

  it('throws EMBEDDING_FAILED on dimension mismatch', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ embedding: [0.1] }), { status: 200 })
    );

    const provider = createEmbeddingProvider({
      provider: 'ollama',
      model: 'bge-m3',
      dimensions: 4,
      baseUrl: 'http://ollama.local'
    });

    await expect(provider.embed('hi')).rejects.toMatchObject({
      code: ErrorCode.EMBEDDING_FAILED,
      message: 'Embedding dimension mismatch'
    });
  });
});

describe('createEmbeddingProvider factory', () => {
  it('returns an OpenAI provider with correct readonly fields', () => {
    const provider = createEmbeddingProvider({
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      apiKey: 'sk-test'
    });

    expect(provider.name).toBe('openai');
    expect(provider.model).toBe('text-embedding-3-small');
    expect(provider.dimensions).toBe(1536);
  });

  it('returns an Ollama provider with correct readonly fields', () => {
    const provider = createEmbeddingProvider({
      provider: 'ollama',
      model: 'bge-m3',
      dimensions: 1024,
      baseUrl: 'http://ollama.local'
    });

    expect(provider.name).toBe('ollama');
    expect(provider.model).toBe('bge-m3');
    expect(provider.dimensions).toBe(1024);
  });
});

describe('OpenAI-compatible embedding provider', () => {
  const config = {
    provider: 'openai-compatible' as const,
    model: 'mistral-embed-2312',
    dimensions: 2,
    baseUrl: 'https://api.mistral.ai/v1'
  };

  it('resolves Mistral defaults', () => {
    expect(resolveEmbeddingDefaults('openai-compatible')).toEqual({
      model: 'mistral-embed-2312',
      dimensions: 1024
    });
  });

  it('pages large batches and passes an abort signal on every page', async () => {
    const create = vi.fn(
      (params: { input: string[] }, options?: { signal?: AbortSignal | undefined }) =>
        Promise.resolve({
          data: params.input.map((_, index) => ({
            index,
            embedding: options ? [0.1, 0.2] : [0, 0]
          }))
        })
    );
    const provider = createOpenAICompatibleEmbeddingProvider(config, {
      embeddings: { create }
    });

    const total = OPENAI_COMPATIBLE_MAX_BATCH_INPUTS * 2 + 1;
    const vectors = await provider.embedBatch(
      Array.from({ length: total }, (_, i) => `t${i}`)
    );

    expect(vectors).toHaveLength(total);
    expect(create).toHaveBeenCalledTimes(3);
    const sizes = create.mock.calls.map(
      ([params]) => (params as { input: string[] }).input.length
    );
    expect(sizes).toEqual([
      OPENAI_COMPATIBLE_MAX_BATCH_INPUTS,
      OPENAI_COMPATIBLE_MAX_BATCH_INPUTS,
      1
    ]);
    for (const call of create.mock.calls) {
      expect((call[1] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('maps an HTTP 429 to RateLimitError', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('429 Rate limit exceeded'), { status: 429 }));
    const provider = createOpenAICompatibleEmbeddingProvider(config, {
      embeddings: { create }
    });

    await expect(provider.embedBatch(['a'])).rejects.toBeInstanceOf(RateLimitError);
  });

  it('keeps non-429 failures as EMBEDDING_FAILED even if the text mentions 429', async () => {
    const create = vi.fn().mockRejectedValue(new Error('upstream said 1429'));
    const provider = createOpenAICompatibleEmbeddingProvider(config, {
      embeddings: { create }
    });

    const error = await provider.embedBatch(['a']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(ErrorCode.EMBEDDING_FAILED);
  });

  it('rejects a short response per page', async () => {
    const create = vi.fn().mockResolvedValue({ data: [{ index: 0, embedding: [0.1, 0.2] }] });
    const provider = createOpenAICompatibleEmbeddingProvider(config, {
      embeddings: { create }
    });

    await expect(provider.embedBatch(['a', 'b'])).rejects.toBeInstanceOf(AppError);
  });
});
