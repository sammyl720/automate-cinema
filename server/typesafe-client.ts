import {
  APIError,
  TypeSafeClient,
  type Questions,
  type SystemOneRequest,
} from '@typesafe-ai/sdk';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { config } from './config';
import { boundedBody } from './openai-client';
import { paidRequest } from './paid-call';
import { DomainError } from './policy';
import type { Job } from '../shared/domain';

export const typesafeTransport = {
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
};
export function requireTypeSafe() {
  if (!config.TYPESAFE_API_KEY)
    throw new DomainError(
      'Set TYPESAFE_API_KEY in the server .env and restart before selecting Jev.',
      422,
    );
}
export function decisionKey(
  stage: string,
  revision: number,
  version: string,
  body: unknown,
) {
  return `typesafe:${stage}:${revision}:${version}:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`;
}
const envelope = z
  .object({
    model: z.string().min(1).max(100),
    answers: z.record(z.string(), z.unknown()),
    usage: z.object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    }),
  })
  .loose();
export async function evaluateTypeSafe(
  job: Job,
  stage: string,
  key: string,
  body: SystemOneRequest<Questions>,
  signal: AbortSignal,
) {
  requireTypeSafe();
  // Reserve a conservative full-request allowance. Actual usage settles at the configured input rate.
  const estimatedUsd = (64000 * config.TYPESAFE_INPUT_USD_PER_MILLION) / 1e6;
  if (Buffer.byteLength(JSON.stringify(body)) > 96000)
    throw new DomainError(
      'Jev evaluation input is too large; shorten the creative state.',
    );
  const client = new TypeSafeClient({
    apiKey: config.TYPESAFE_API_KEY,
    baseURL: 'https://api.typesafe.ai',
    defaultModel: config.TYPESAFE_MODEL,
    timeout: config.TYPESAFE_TIMEOUT_MS,
    retry: { maxRetries: 0 },
    logLevel: 'off',
    fetch: async (url, init) => {
      const response = await typesafeTransport.fetch(url, {
        ...init,
        redirect: 'error',
      });
      const bytes = await boundedBody(response, 2 * 1024 * 1024);
      return new Response(Buffer.from(bytes), {
        status: response.status,
        headers: response.headers,
      });
    },
  });
  return paidRequest({
    provider: 'typesafe',
    providerName: 'Jev',
    job,
    stage,
    cacheKey: key,
    model: config.TYPESAFE_MODEL,
    body,
    estimatedUsd,
    signal,
    pricingBasis: `Configured TypeSafe input rate $${config.TYPESAFE_INPUT_USD_PER_MILLION}/million; outputs free. Calculated, not invoice.`,
    send: async (callId) => {
      try {
        return await client
          .systemOne(body, {
            signal,
            headers: { 'X-Client-Request-Id': callId },
          })
          .asResponse();
      } catch (e) {
        // Keep only safe status/ID metadata; never expose SDK error bodies or credentials.
        if (e instanceof APIError)
          return new Response(null, { status: e.status, headers: e.headers });
        throw new Error('TypeSafe transport interrupted');
      }
    },
    decode: async (response) => {
      const result = envelope.parse(
        JSON.parse(
          Buffer.from(await boundedBody(response, 2 * 1024 * 1024)).toString(
            'utf8',
          ),
        ),
      );
      return {
        result,
        calculatedUsd:
          (result.usage.input_tokens * config.TYPESAFE_INPUT_USD_PER_MILLION) /
          1e6,
        usage: result.usage,
      };
    },
  });
}
