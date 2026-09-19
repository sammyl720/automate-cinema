import { z } from 'zod';
import { config } from './config';
import { base, list, save } from './db';
import { paidRequest } from './paid-call';
import { DomainError } from './policy';
import type { ApiCall, Job } from '../shared/domain';

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
export const elevenLabsTransport = {
  fetch: (url: string, init: RequestInit) => fetch(url, init),
};
export function requireElevenLabs() {
  if (!config.ELEVENLABS_API_KEY)
    throw new DomainError(
      'Set ELEVENLABS_API_KEY in the server .env and restart.',
      422,
    );
}
interface CallOptions<T> {
  provider?: 'openai' | 'elevenlabs';
  voiceId?: string;
  pricingBasis?: string;
  job: Job;
  stage: string;
  sceneId?: string;
  model: string;
  endpoint: 'responses' | 'audio/speech' | 'eleven-speech' | 'eleven-music';
  body: unknown;
  estimatedUsd: number;
  signal: AbortSignal;
  decode: (response: Response) => Promise<{
    result: T;
    calculatedUsd: number;
    usage: Record<string, unknown>;
  }>;
}
export async function paidCall<T>(
  options: CallOptions<T>,
): Promise<{ result: T; call: ApiCall }> {
  const eleven = options.provider === 'elevenlabs';
  const providerName = eleven ? 'ElevenLabs' : 'OpenAI';
  if (eleven) requireElevenLabs();
  else requireOpenAI();
  if (eleven !== options.endpoint.startsWith('eleven-'))
    throw new DomainError('Provider endpoint mismatch');
  if (
    options.endpoint === 'eleven-speech' &&
    !/^[a-zA-Z0-9_-]{1,100}$/.test(options.voiceId ?? '')
  )
    throw new DomainError('Invalid ElevenLabs voice ID');
  return paidRequest({
    ...options,
    provider: options.provider ?? 'openai',
    providerName,
    send: async (callId) => {
      return await (eleven ? elevenLabsTransport : openaiTransport).fetch(
        eleven
          ? `https://api.elevenlabs.io/v1/${options.endpoint === 'eleven-music' ? 'music' : `text-to-speech/${options.voiceId}`}?output_format=mp3_44100_128`
          : `https://api.openai.com/v1/${options.endpoint}`,
        {
          method: 'POST',
          headers: {
            ...(eleven
              ? { 'xi-api-key': config.ELEVENLABS_API_KEY }
              : { Authorization: `Bearer ${config.OPENAI_API_KEY}` }),
            'Content-Type': 'application/json',
            'X-Client-Request-Id': callId,
          },
          body: JSON.stringify(options.body),
          signal: AbortSignal.any([
            options.signal,
            AbortSignal.timeout(eleven ? 150000 : config.OPENAI_TIMEOUT_MS),
          ]),
        },
      );
    },
  });
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
