import { base, event, get, list, save, transaction } from './db';
import { DomainError } from './policy';
import type { ApiCall, Job, Project } from '../shared/domain';
export interface PaidRequest<T> {
  provider: ApiCall['provider'];
  providerName: string;
  pricingBasis?: string;
  cacheKey?: string;
  job: Job;
  stage: string;
  sceneId?: string;
  model: string;
  body: unknown;
  estimatedUsd: number;
  signal: AbortSignal;
  send: (callId: string) => Promise<Response>;
  decode: (
    response: Response,
  ) => Promise<{
    result: T;
    calculatedUsd: number;
    usage: Record<string, unknown>;
  }>;
}
export async function paidRequest<T>(
  options: PaidRequest<T>,
): Promise<{ result: T; call: ApiCall }> {
  const providerName = options.providerName;
  options.signal.throwIfAborted();
  if (!Number.isFinite(options.estimatedUsd) || options.estimatedUsd < 0)
    throw new DomainError('Invalid request estimate');
  const key =
    options.cacheKey ??
    `${options.job.id}:${options.stage}:${options.sceneId ?? 'project'}`;
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
      provider: options.provider ?? 'openai',
      model: options.model,
      status: 'reserved',
      attempt: (previous?.attempt ?? 0) + 1,
      estimatedUsd: options.estimatedUsd,
      calculatedUsd: 0,
      pricingBasis:
        options.pricingBasis ??
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
    response = await options.send(call!.id);
  } catch {
    settle(
      'uncertain',
      { error: 'Connection interrupted; provider billing outcome unknown.' },
      false,
    );
    throw new DomainError(
      `${providerName} request interrupted. Its budget reservation is retained; automatic paid retry is blocked.`,
    );
  }
  const requestId =
    response.headers.get('x-typesafe-request-id') ??
    response.headers.get('x-request-id') ??
    undefined;
  if (!response.ok) {
    await response.body?.cancel();
    // Server errors can follow accepted work; do not assume it is safe to resubmit.
    if (response.status >= 500 || response.status === 408) {
      settle(
        'uncertain',
        {
          requestId,
          error: `${providerName} HTTP ${response.status}; outcome unknown`,
        },
        false,
      );
      throw new DomainError(
        `${providerName} server error; inspect the recorded request ID before retrying paid work.`,
      );
    }
    settle(
      'failed',
      {
        requestId,
        error: `${providerName} HTTP ${response.status}`,
        latencyMs: Date.now() - started,
      },
      true,
    );
    if (response.status === 429)
      throw new Error(
        `${providerName} rate limit reached; bounded retry scheduled`,
      );
    throw new DomainError(
      `${providerName} rejected the request (HTTP ${response.status}). Check key, billing, permissions and model access.`,
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
      `${providerName} returned an unreadable response. Paid retry blocked; inspect the request record.`,
    );
  }
}
