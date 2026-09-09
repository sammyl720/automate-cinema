import { z } from 'zod';
import { config } from './config';
import { base, event, get, list, save, transaction } from './db';
import { DomainError } from './policy';
import type { ApiCall, Job, Project } from '../shared/domain';

// Standard synchronous rates, verified 2026-09-08. Never treated as a billing invoice.
export const rates = {
  input: 0.4,
  cached: 0.1,
  output: 1.6,
  speechCharacters: 15,
};
export const TEXT_MODEL = 'gpt-4.1-mini';
export const SPEECH_MODEL = 'tts-1';
export const MAX_OUTPUT_TOKENS = 4000;
export const openaiTransport = {
  fetch: (url: string, init: RequestInit) => fetch(url, init),
};
export function requireOpenAI() {
  if (!config.OPENAI_API_KEY)
    throw new DomainError(
      'OpenAI authentication required. Set OPENAI_API_KEY in the server .env and restart.',
      422,
    );
}
export function textEstimate(body: unknown) {
  return (
    ((Buffer.byteLength(JSON.stringify(body)) + 8192) * rates.input +
      MAX_OUTPUT_TOKENS * rates.output) /
    1e6
  );
}
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  input_tokens_details: z
    .object({ cached_tokens: z.number().int().nonnegative() })
    .optional(),
});
export function textCost(usage: unknown) {
  const u = usageSchema.parse(usage);
  const cached = Math.min(
    u.input_tokens,
    u.input_tokens_details?.cached_tokens ?? 0,
  );
  return {
    usd:
      ((u.input_tokens - cached) * rates.input +
        cached * rates.cached +
        u.output_tokens * rates.output) /
      1e6,
    usage: u,
  };
}
export async function boundedBody(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new Error('Provider response exceeded size limit');
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel();
    throw e;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
interface CallOptions<T> {
  job: Job;
  stage: string;
  sceneId?: string;
  model: string;
  endpoint: 'responses' | 'audio/speech';
  body: unknown;
  estimatedUsd: number;
  signal: AbortSignal;
  decode: (
    response: Response,
  ) => Promise<{
    result: T;
    calculatedUsd: number;
    usage: Record<string, unknown>;
  }>;
}
export async function paidCall<T>(
  options: CallOptions<T>,
): Promise<{ result: T; call: ApiCall }> {
  requireOpenAI();
  options.signal.throwIfAborted();
  const key = `${options.job.id}:${options.stage}:${options.sceneId ?? 'project'}`;
  const previous = list<ApiCall>('apiCall', options.job.projectId)
    .filter((c) => c.key === key)
    .at(-1);
  if (previous?.status === 'completed')
    return { result: previous.result as T, call: previous };
  if (previous && ['reserved', 'uncertain'].includes(previous.status))
    throw new DomainError(
      'A previous paid request has an uncertain outcome. Budget remains reserved; reconcile it in provider billing before a new request.',
    );
  if (previous && previous.attempt >= 3)
    throw new DomainError('Paid request attempt limit reached');
  let call: ApiCall;
  transaction(() => {
    const p = get<Project>('project', options.job.projectId);
    if (p.spentUsd + p.reservedUsd + options.estimatedUsd > p.budget.maximumUsd)
      throw new DomainError(
        'Project budget cannot cover this AI request estimate',
      );
    call = save('apiCall', {
      ...base(),
      projectId: p.id,
      jobId: options.job.id,
      sceneId: options.sceneId,
      key,
      stage: options.stage,
      provider: 'openai',
      model: options.model,
      status: 'reserved',
      attempt: (previous?.attempt ?? 0) + 1,
      estimatedUsd: options.estimatedUsd,
      calculatedUsd: 0,
      pricingBasis:
        'Standard rates 2026-09-08; calculated, not provider invoice',
      request: options.body,
    });
    save('project', {
      ...p,
      reservedUsd: p.reservedUsd + options.estimatedUsd,
    });
    event(p.id, 'provider.request_reserved', {
      callId: call.id,
      stage: options.stage,
      estimatedUsd: options.estimatedUsd,
    });
  });
  const settle = (
    status: ApiCall['status'],
    patch: Partial<ApiCall>,
    release: boolean,
  ) =>
    transaction(() => {
      const p = get<Project>('project', options.job.projectId);
      call = save('apiCall', { ...call!, ...patch, status });
      save('project', {
        ...p,
        reservedUsd: release
          ? Math.max(0, p.reservedUsd - options.estimatedUsd)
          : p.reservedUsd,
        spentUsd: p.spentUsd + (patch.calculatedUsd ?? 0),
      });
      event(p.id, `provider.request_${status}`, {
        callId: call.id,
        stage: options.stage,
        calculatedUsd: patch.calculatedUsd ?? null,
      });
    });
  const started = Date.now();
  let response: Response;
  try {
    response = await openaiTransport.fetch(
      `https://api.openai.com/v1/${options.endpoint}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Client-Request-Id': call!.id,
        },
        body: JSON.stringify(options.body),
        signal: AbortSignal.any([
          options.signal,
          AbortSignal.timeout(config.OPENAI_TIMEOUT_MS),
        ]),
      },
    );
  } catch {
    settle(
      'uncertain',
      { error: 'Connection interrupted; provider billing outcome unknown.' },
      false,
    );
    throw new DomainError(
      'OpenAI request interrupted. Its budget reservation is retained; automatic paid retry is blocked.',
    );
  }
  const requestId = response.headers.get('x-request-id') ?? undefined;
  if (!response.ok) {
    await response.body?.cancel();
    // Server errors can follow accepted work; do not assume it is safe to resubmit.
    if (response.status >= 500) {
      settle(
        'uncertain',
        { requestId, error: `OpenAI HTTP ${response.status}; outcome unknown` },
        false,
      );
      throw new DomainError(
        'OpenAI server error; inspect the recorded request ID before retrying paid work.',
      );
    }
    settle(
      'failed',
      {
        requestId,
        error: `OpenAI HTTP ${response.status}`,
        latencyMs: Date.now() - started,
      },
      true,
    );
    if (response.status === 429)
      throw new Error('OpenAI rate limit reached; bounded retry scheduled');
    throw new DomainError(
      `OpenAI rejected the request (HTTP ${response.status}). Check key, billing, permissions and model access.`,
      422,
    );
  }
  try {
    const decoded = await options.decode(response);
    if (!Number.isFinite(decoded.calculatedUsd) || decoded.calculatedUsd < 0)
      throw new Error('Invalid cost');
    settle(
      'completed',
      {
        requestId,
        result: decoded.result,
        calculatedUsd: decoded.calculatedUsd,
        usage: decoded.usage,
        latencyMs: Date.now() - started,
      },
      true,
    );
    return { result: decoded.result, call: call! };
  } catch {
    settle(
      'uncertain',
      {
        requestId,
        error:
          'Response could not be decoded or persisted; billing outcome requires review.',
      },
      false,
    );
    throw new DomainError(
      'OpenAI returned an unreadable response. Paid retry blocked; inspect the request record.',
    );
  }
}
export async function structuredCall<T>(
  job: Job,
  stage: string,
  instructions: string,
  input: unknown,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  const body = {
    model: TEXT_MODEL,
    store: false,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    instructions,
    input: JSON.stringify(input),
    text: {
      format: {
        type: 'json_schema',
        name: stage,
        strict: true,
        schema: z.toJSONSchema(schema),
      },
    },
  };
  const { result, call } = await paidCall({
    job,
    stage,
    model: TEXT_MODEL,
    endpoint: 'responses',
    body,
    estimatedUsd: textEstimate(body),
    signal,
    decode: async (response) => {
      const value = JSON.parse(
        Buffer.from(await boundedBody(response, 2 * 1024 * 1024)).toString(
          'utf8',
        ),
      ) as Record<string, unknown>;
      const cost = textCost(value.usage);
      return { result: value, calculatedUsd: cost.usd, usage: cost.usage };
    },
  });
  const envelope = z
    .object({
      status: z.literal('completed'),
      output: z.array(
        z.object({
          type: z.string(),
          content: z
            .array(z.object({ type: z.string(), text: z.string().optional() }))
            .optional(),
        }),
      ),
    })
    .safeParse(result);
  if (!envelope.success)
    throw new DomainError(
      'Creative response was incomplete. Its cost is recorded; no automatic re-generation will occur.',
    );
  const content = envelope.data.output.flatMap((x) => x.content ?? []);
  if (content.some((c) => c.type === 'refusal'))
    throw new DomainError(
      'The creative provider declined this request. Review the brief.',
    );
  let parsed: T;
  try {
    parsed = schema.parse(
      JSON.parse(
        content
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text ?? '')
          .join(''),
      ),
    );
  } catch {
    throw new DomainError(
      'Creative output failed structured validation. Review the paid request; no automatic re-generation will occur.',
    );
  }
  if (
    !list<{ id: string; callId: string }>('prompt', job.projectId).some(
      (p) => p.callId === call.id,
    )
  )
    save('prompt', {
      ...base(),
      projectId: job.projectId,
      name: stage,
      version: `${stage}/2.0.0`,
      provider: 'openai',
      model: TEXT_MODEL,
      callId: call.id,
      input: { instructions, data: input },
      output: parsed,
    });
  return parsed;
}
