import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { timingSafeEqual, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z, ZodError } from 'zod';
import { config } from './config';
import { list, get, save, base, event, db } from './db';
import {
  createProject,
  detail,
  selectConcept,
  requestStage,
  startAutomation,
  editScene,
  regenerate,
  reviewScene,
  updateBible,
  approvePreflight,
  enableImageFirst,
  approveVisual,
  reviseVisual,
} from './service';
import {
  jobTypes,
  type Project,
  type Scene,
  type Asset,
  type ResearchSource,
} from '../shared/domain';
import { getProviderRegistry, unavailablePublisher } from './providers';
import { jobs } from './db';
import { cancelJob, retryJob } from './queue';
import { DomainError } from './policy';
import { mediaPath } from './media';
export function equalSecret(a: string, b: string) {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
async function body(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 32768)
      throw new DomainError('Request is too large', 413);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new DomainError('Invalid JSON body', 400);
  }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
export function createApi() {
  const limits = new Map<string, { start: number; count: number }>();
  return createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? '').split(':')[0];
      if (
        ![
          'localhost',
          '127.0.0.1',
          new URL(config.STUDIO_ORIGIN).hostname,
          config.STUDIO_HOST,
        ].includes(host)
      )
        throw new DomainError('Untrusted host', 403);
      const origin = req.headers.origin;
      if (origin && origin !== config.STUDIO_ORIGIN)
        throw new DomainError('Origin not allowed', 403);
      const key = req.socket.remoteAddress ?? 'unknown';
      let rate = limits.get(key);
      if (!rate || Date.now() - rate.start > 60000) {
        rate = { start: Date.now(), count: 0 };
        limits.set(key, rate);
      }
      if (++rate.count > 600) throw new DomainError('Rate limit exceeded', 429);
      if (limits.size > 10000)
        for (const [k, v] of limits)
          if (Date.now() - v.start > 60000) limits.delete(k);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      if (path === '/api/session' && method === 'POST') {
        const token = z
          .object({ token: z.string().max(1000) })
          .parse(await body(req)).token;
        if (config.STUDIO_TOKEN && !equalSecret(token, config.STUDIO_TOKEN))
          throw new DomainError('Invalid studio token', 401);
        res.setHeader(
          'Set-Cookie',
          `studio_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${config.STUDIO_ORIGIN.startsWith('https:') ? '; Secure' : ''}`,
        );
        json(res, 200, { authenticated: true });
        return;
      }
      const cookie = req.headers.cookie
        ?.split(';')
        .map((s) => s.trim())
        .find((s) => s.startsWith('studio_session='))
        ?.slice(15);
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const supplied = bearer ?? (cookie ? decodeURIComponent(cookie) : '');
      if (config.STUDIO_TOKEN && !equalSecret(supplied, config.STUDIO_TOKEN))
        throw new DomainError('Studio authentication required', 401);
      if (method === 'GET' && path === '/api/health') {
        json(res, 200, {
          status: 'ok',
          storage: 'sqlite',
          provider: 'development',
          publishing: 'unsupported',
        });
        return;
      }
      if (method === 'GET' && path === '/api/studio') {
        json(res, 200, {
          projects: list('project'),
          jobs: jobs(),
          providers: getProviderRegistry(),
          assets: list('asset'),
          events: list('event').slice(-100).reverse(),
        });
        return;
      }
      if (method === 'GET' && path === '/api/projects') {
        json(res, 200, list('project'));
        return;
      }
      if (method === 'POST' && path === '/api/projects') {
        json(res, 201, createProject(await body(req)));
        return;
      }
      const projectMatch = path.match(
        /^\/api\/projects\/([\w-]+)(?:\/([\w-]+))?$/,
      );
      if (projectMatch) {
        const [, id, action] = projectMatch;
        if (method === 'GET' && !action) {
          json(res, 200, detail(id));
          return;
        }
        get<Project>('project', id);
        if (method === 'POST') {
          const input = await body(req);
          if (action === 'select') {
            const parsed = z.object({ conceptId: z.uuid() }).parse(input);
            selectConcept(id, parsed.conceptId);
          } else if (action === 'image-first') {
            enableImageFirst(id);
          } else if (action === 'approve-reference') {
            approveVisual(id, undefined, input);
          } else if (action === 'revise-reference') {
            reviseVisual(id, undefined, input);
          } else if (action === 'approve-preflight') {
            approvePreflight(id, input);
          } else if (action === 'run') {
            startAutomation(id);
          } else if (action === 'pause') {
            const p = get<Project>('project', id);
            save('project', { ...p, automationRunning: false });
            event(id, 'automation.paused', {
              reason:
                'User paused automatic progression; current jobs may finish',
            });
          } else if (action === 'bible') {
            updateBible(id, input);
          } else if (action === 'research') {
            const r = z
              .object({
                url: z
                  .url()
                  .refine((u) =>
                    ['http:', 'https:'].includes(new URL(u).protocol),
                  ),
                fact: z.string().min(10).max(4000),
                confidence: z.number().min(0).max(1),
                verified: z.boolean(),
                notes: z.string().max(2000).default(''),
              })
              .parse(input);
            save('research', {
              ...base(),
              projectId: id,
              ...r,
              accessedAt: new Date().toISOString(),
            } satisfies ResearchSource);
            event(id, 'research.source_added', {
              verification: 'human supplied; not automatically checked',
            });
          } else if (action === 'publish') {
            await unavailablePublisher.publish({
              projectId: id,
              packageId: '',
              idempotencyKey: id,
            });
          } else if (jobTypes.includes(action as (typeof jobTypes)[number]))
            requestStage(id, action as (typeof jobTypes)[number]);
          else throw new DomainError('Unknown project action', 404);
          json(res, 202, detail(id));
          return;
        }
      }
      const sceneMatch = path.match(
        /^\/api\/scenes\/([\w-]+)\/(edit|regenerate|approve|reject|approve-still|revise-still)$/,
      );
      if (method === 'POST' && sceneMatch) {
        const [, id, action] = sceneMatch;
        if (action === 'approve-still' || action === 'revise-still') {
          const scene = get<Scene>('scene', id);
          (action === 'approve-still' ? approveVisual : reviseVisual)(
            scene.projectId,
            id,
            await body(req),
          );
        } else if (action === 'edit') editScene(id, await body(req));
        else if (action === 'regenerate') regenerate(id);
        else reviewScene(id, action === 'approve');
        json(res, 202, { ok: true });
        return;
      }
      const jobMatch = path.match(/^\/api\/jobs\/([\w-]+)\/(cancel|retry)$/);
      if (method === 'POST' && jobMatch) {
        if (jobMatch[2] === 'cancel') {
          const row = db
            .prepare('SELECT project_id FROM jobs WHERE id=?')
            .get(jobMatch[1]);
          cancelJob(jobMatch[1]);
          if (row) {
            const p = get<Project>('project', String(row.project_id));
            save('project', { ...p, automationRunning: false });
          }
        } else retryJob(jobMatch[1]);
        json(res, 202, { ok: true });
        return;
      }
      const mediaMatch = path.match(/^\/media\/([\w-]+)$/);
      if (method === 'GET' && mediaMatch) {
        const asset = get<Asset>('asset', mediaMatch[1]);
        const file = mediaPath(asset.path);
        const info = await stat(file);
        res.setHeader('Content-Type', asset.mime);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.setHeader('Accept-Ranges', 'bytes');
        if (url.searchParams.has('download'))
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${asset.path.split('/').at(-1)}"`,
          );
        const range = req.headers.range;
        if (range) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (!m) throw new DomainError('Invalid range', 416);
          const start = Number(m[1]),
            end = m[2] ? Math.min(Number(m[2]), info.size - 1) : info.size - 1;
          if (start > end || start >= info.size)
            throw new DomainError('Range outside asset', 416);
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${info.size}`,
            'Content-Length': end - start + 1,
          });
          createReadStream(file, { start, end })
            .on('error', () => res.destroy())
            .pipe(res);
        } else {
          res.writeHead(200, { 'Content-Length': info.size });
          createReadStream(file)
            .on('error', () => res.destroy())
            .pipe(res);
        }
        return;
      }
      throw new DomainError('Not found', 404);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status =
        error instanceof DomainError
          ? error.status
          : error instanceof ZodError
            ? 400
            : error instanceof Error && error.message.includes('not found')
              ? 404
              : 500;
      const message =
        error instanceof ZodError
          ? error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')
          : error instanceof Error
            ? error.message
            : 'Internal error';
      json(res, status, {
        error:
          status === 500 ? 'Operation failed. Inspect server logs.' : message,
      });
      if (status === 500)
        console.error(JSON.stringify({ event: 'api.error', message }));
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createApi();
  server.listen(config.STUDIO_PORT, config.STUDIO_HOST, () =>
    console.log(
      `Studio API: http://${config.STUDIO_HOST}:${config.STUDIO_PORT}`,
    ),
  );
  for (const s of ['SIGINT', 'SIGTERM'] as const)
    process.once(s, () => server.close(() => process.exit(0)));
}
