'use client';
import Image from 'next/image';
import { useEffect, useState, useCallback } from 'react';
import {
  Clapperboard,
  Plus,
  ArrowUpRight,
  Layers,
  Activity,
  Film,
  Radio,
  ArrowLeft,
  Play,
  Pause,
  Check,
  Download,
  RefreshCw,
  Clock,
  Image as ImageIcon,
  ShieldCheck,
  Workflow,
  Settings2,
  FolderOpen,
  BarChart3,
  Search,
} from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Progress } from '@/components/ui/progress';
import { Checkbox } from '@/components/ui/checkbox';
import { toast, Toaster } from 'sonner';
import { api, readStudio, readProject, label, money } from '@/lib/studio-api';
import type {
  Snapshot,
  Project,
  ProjectDetail,
  Scene,
  Asset,
  Job,
} from '@/shared/domain';
import { projectInput } from '@/shared/domain';
const initial: Snapshot = {
  projects: [],
  jobs: [],
  providers: [],
  assets: [],
  events: [],
};
type Action = (path: string, input?: unknown) => Promise<void>;
function Choice({
  label: caption,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <label className="field">
      {caption}
      <Select
        value={value}
        onValueChange={(v) => {
          if (v) onChange(v);
        }}
      >
        <SelectTrigger className="choice">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((v) => (
            <SelectItem key={v} value={v}>
              {label(v)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
function StateBadge({ state }: { state: string }) {
  return <span className={`badge state-${state}`}>{label(state)}</span>;
}
function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <Film size={28} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function ProjectCard({
  p,
  index,
  onOpen,
  assets,
}: {
  p: Project;
  index: number;
  onOpen: () => void;
  assets: Asset[];
}) {
  const thumbnail = assets
    .filter((a) => a.projectId === p.id && a.type === 'thumbnail')
    .at(-1);
  return (
    <button className="project-card" onClick={onOpen}>
      <div className={`cover cover-${index % 3}`}>
        {thumbnail && (
          <Image
            unoptimized
            width={640}
            height={360}
            src={`/media/${thumbnail.id}`}
            alt="Development render thumbnail"
          />
        )}
        <StateBadge state={p.state} />
        <div className="cover-number">{String(index + 1).padStart(2, '0')}</div>
        <span className="format">
          {p.aspect} / {p.quality.toUpperCase()} ·{' '}
          {thumbnail ? 'TEST RENDER' : 'CONCEPT COVER'}
        </span>
      </div>
      <div className="card-copy">
        <span className="eyebrow">
          {p.kind === 'factual'
            ? 'SCIENCE / RESEARCH REQUIRED'
            : 'ORIGINAL FICTION'}
        </span>
        <h3>{p.title}</h3>
        <div className="card-footer">
          <span>
            {p.duration} seconds · {label(p.mode)}
          </span>
          <ArrowUpRight size={20} />
        </div>
      </div>
    </button>
  );
}
export default function Home() {
  const [data, setData] = useState<Snapshot>(initial);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [section, setSection] = useState('productions');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [token, setToken] = useState('');
  const refresh = useCallback(async () => {
    const snapshot = await readStudio();
    setData(snapshot);
    if (selected) setDetail(await readProject(selected));
    setError('');
    setLoading(false);
  }, [selected]);
  useEffect(() => {
    let alive = true;
    const update = () => {
      void refresh().catch((e) => {
        if (alive) {
          setError(e.message);
          setLoading(false);
        }
      });
    };
    update();
    const interval = setInterval(update, 2000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [refresh]);
  const act: Action = async (path, input = {}) => {
    setBusy(true);
    try {
      await api(path, input);
      await refresh();
      toast.success('Studio updated');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed');
      throw e;
    } finally {
      setBusy(false);
    }
  };
  function perform(path: string, input: unknown = {}) {
    void act(path, input).catch(() => {});
  }
  useEffect(() => {
    const doc = document as Document & {
      modelContext?: {
        registerTool: (tool: unknown, options: { signal: AbortSignal }) => void;
      };
    };
    if (!doc.modelContext) return;
    const controller = new AbortController();
    try {
      doc.modelContext.registerTool(
        {
          name: 'list_cinematic_projects',
          description: 'List the persisted studio projects.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true },
          execute: async () => {
            const snapshot = await readStudio();
            setData(snapshot);
            return snapshot.projects.map((p) => ({
              id: p.id,
              title: p.title,
              state: p.state,
            }));
          },
        },
        { signal: controller.signal },
      );
      doc.modelContext.registerTool(
        {
          name: 'create_cinematic_project',
          description:
            'Create a persisted cinematic project without starting generation or publishing.',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              brief: { type: 'string' },
            },
            required: ['title', 'brief'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute: async (input: unknown) => {
            const validated = projectInput.parse(input);
            const p = await api<Project>('/api/projects', validated);
            setSelected(p.id);
            setData(await readStudio());
            return { id: p.id, title: p.title, state: p.state };
          },
        },
        { signal: controller.signal },
      );
    } catch (e) {
      console.warn('WebMCP registration unavailable', e);
    }
    return () => controller.abort();
  }, []);
  const projects = data.projects.filter((p) =>
    `${p.title} ${p.brief}`.toLowerCase().includes(query.toLowerCase()),
  );
  const activeJobs = data.jobs.filter((j) =>
    ['queued', 'running'].includes(j.status),
  );
  return (
    <main className="studio">
      <Toaster theme="dark" />
      <header>
        <button
          className="brand"
          onClick={() => {
            setSelected(null);
            setSection('productions');
          }}
        >
          <Clapperboard /> FRAME / WORK <span>CREATIVE STUDIO</span>
        </button>
        <span className="status">
          <i /> Local creative studio
        </span>
      </header>
      <section className="workspace">
        {error && (
          <div role="alert" className="notice error">
            <strong>{error}</strong>
            {error.includes('authentication') ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  perform('/api/session', { token });
                }}
              >
                <input
                  aria-label="Studio access token"
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                <button className="primary">Unlock studio</button>
              </form>
            ) : (
              <p>
                Start the studio API and worker with{' '}
                <code>npm run dev:studio</code>.
              </p>
            )}
          </div>
        )}
        {selected ? (
          <>
            <button
              className="text-button back"
              onClick={() => {
                setSelected(null);
                setDetail(null);
              }}
            >
              <ArrowLeft size={16} /> All productions
            </button>
            {detail && detail.project.id === selected ? (
              <ProjectView
                detail={detail}
                perform={perform}
                act={act}
                busy={busy}
              />
            ) : (
              <Empty title="Opening production…" />
            )}
          </>
        ) : (
          <>
            <div className="eyebrow">YOUR PRODUCTION DESK</div>
            <div className="heading">
              <div>
                <h1>
                  Make something
                  <br />
                  <em>worth watching.</em>
                </h1>
                <p>An idea becomes a story. A story becomes a world.</p>
              </div>
              <button className="primary" onClick={() => setOpen(true)}>
                <Plus size={18} /> New production
              </button>
            </div>
            <div className="stats">
              {[
                [
                  Layers,
                  String(
                    data.projects.filter(
                      (p) =>
                        !['packaged', 'published', 'archived'].includes(
                          p.state,
                        ),
                    ).length,
                  ),
                  'In development',
                ],
                [
                  Film,
                  String(
                    data.projects.filter((p) => p.state === 'packaged').length,
                  ),
                  'Packaged previews',
                ],
                [Activity, String(activeJobs.length), 'Active jobs'],
                [
                  Radio,
                  money(data.projects.reduce((n, p) => n + p.spentUsd, 0)),
                  'Generation spend',
                ],
              ].map(([Icon, n, caption]) => {
                const I = Icon as typeof Layers;
                return (
                  <div key={String(caption)}>
                    <I size={18} />
                    <strong>{String(n)}</strong>
                    <span>{String(caption)}</span>
                  </div>
                );
              })}
            </div>
            <Tabs value={section} onValueChange={setSection}>
              <TabsList variant="line" className="main-tabs">
                {[
                  ['productions', 'Productions', Clapperboard],
                  ['pipeline', 'Pipeline', Workflow],
                  ['queue', 'Generation queue', Activity],
                  ['assets', 'Asset library', FolderOpen],
                  ['providers', 'Providers', Settings2],
                  ['analytics', 'Analytics', BarChart3],
                ].map(([value, caption, Icon]) => {
                  const I = Icon as typeof Layers;
                  return (
                    <TabsTrigger value={String(value)} key={String(value)}>
                      <I size={16} />
                      {String(caption)}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
              <TabsContent value="productions">
                <div className="section-heading">
                  <h2>On the studio floor</h2>
                  <label className="search">
                    <Search size={16} />
                    <input
                      aria-label="Search productions"
                      placeholder="Find a production"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </label>
                </div>
                {loading ? (
                  <Empty title="Loading your studio…" />
                ) : projects.length ? (
                  <div className="project-grid">
                    {projects.map((p, i) => (
                      <ProjectCard
                        key={p.id}
                        p={p}
                        index={i}
                        assets={data.assets}
                        onOpen={() => setSelected(p.id)}
                      />
                    ))}
                  </div>
                ) : (
                  <Empty title="A new story starts here">
                    Create a production, or try another search.
                  </Empty>
                )}
                <div className="studio-note">
                  <Clapperboard size={22} />
                  <div>
                    <h3>
                      A complete production, one deliberate step at a time.
                    </h3>
                    <p>
                      Test footage · Optional OpenAI creative and speech ·
                      Publishing disconnected
                    </p>
                  </div>
                </div>
              </TabsContent>
              <TabsContent value="pipeline">
                <div className="kanban">
                  {[
                    [
                      'Development',
                      [
                        'idea',
                        'researching',
                        'concept_selected',
                        'script_drafting',
                        'storyboarding',
                      ],
                    ],
                    [
                      'Production',
                      ['assets_planned', 'generating', 'assembling'],
                    ],
                    [
                      'Review',
                      ['evaluating', 'revision_required', 'approved', 'failed'],
                    ],
                    [
                      'Delivery',
                      [
                        'packaged',
                        'scheduled',
                        'published',
                        'performance_tracking',
                        'archived',
                      ],
                    ],
                  ].map(([name, statuses]) => (
                    <div className="lane" key={String(name)}>
                      <h3>
                        {name}{' '}
                        <span>
                          {
                            data.projects.filter((p) =>
                              (statuses as string[]).includes(p.state),
                            ).length
                          }
                        </span>
                      </h3>
                      {data.projects
                        .filter((p) => (statuses as string[]).includes(p.state))
                        .map((p) => (
                          <button
                            className="lane-card"
                            onClick={() => setSelected(p.id)}
                            key={p.id}
                          >
                            <StateBadge state={p.state} />
                            <h3>{p.title}</h3>
                            <p>
                              {p.duration}s · {money(p.spentUsd)}
                            </p>
                          </button>
                        ))}
                    </div>
                  ))}
                </div>
              </TabsContent>
              <TabsContent value="queue">
                <Queue
                  jobs={data.jobs}
                  projects={data.projects}
                  perform={perform}
                />
              </TabsContent>
              <TabsContent value="assets">
                <AssetGrid assets={data.assets} />
              </TabsContent>
              <TabsContent value="providers">
                <div className="section-heading">
                  <h2>Your production partners</h2>
                  <span>CAPABILITY REGISTRY</span>
                </div>
                <div className="provider-grid">
                  {data.providers.map((p) => (
                    <div className="panel" key={p.id}>
                      <div className="row">
                        <h3>{p.name}</h3>
                        <StateBadge state={p.status} />
                      </div>
                      <p>
                        {p.demo
                          ? 'Deterministic video patterns and audio test tones. No credits required.'
                          : p.id === 'runway'
                            ? p.status === 'configured'
                              ? 'Key configured. Choose Runway for real Gen-4.5 video; account access is checked on first request.'
                              : 'Set RUNWAY_API_KEY in the server .env and restart. Runway API credits are separate from website subscriptions.'
                            : p.id === 'openai'
                              ? p.status === 'configured'
                                ? 'Key configured. Choose OpenAI when creating a project for paid concepts, scripts, storyboards and speech. Account access is checked on first request.'
                                : 'Set OPENAI_API_KEY in the server .env and restart. Choose your video provider separately; keys stay on the server.'
                              : p.id === 'elevenlabs'
                                ? 'Set ELEVENLABS_API_KEY in the server .env and restart. Select ElevenLabs narration and/or music when creating a production. Configured means a key is present; account access is checked on first request.'
                                : 'Adapter is not implemented. No requests or charges will be made.'}
                      </p>
                      <div className="tags">
                        <span>{p.model}</span>
                        {p.demo && (
                          <span>
                            Up to {p.capabilities.maximumDurationSeconds}s /
                            scene
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </TabsContent>
              <TabsContent value="analytics">
                <Empty title="Let the work find its audience">
                  Publishing and analytics adapters are not connected. No
                  performance metrics have been collected.
                </Empty>
              </TabsContent>
            </Tabs>
          </>
        )}
        <NewProject
          open={open}
          onClose={() => setOpen(false)}
          onCreate={async (input) => {
            setBusy(true);
            try {
              const p = await api<Project>('/api/projects', input);
              setOpen(false);
              setSelected(p.id);
              toast.success('Production created');
            } catch (e) {
              toast.error(
                e instanceof Error ? e.message : 'Could not create project',
              );
            } finally {
              setBusy(false);
            }
          }}
          busy={busy}
        />
      </section>
    </main>
  );
}
function NewProject({
  open,
  onClose,
  onCreate,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (v: unknown) => Promise<void>;
  busy: boolean;
}) {
  const [kind, setKind] = useState('fiction'),
    [mode, setMode] = useState('assisted'),
    [aspect, setAspect] = useState('9:16'),
    [quality, setQuality] = useState('draft'),
    [videoProvider, setVideoProvider] = useState('development'),
    [creativeProvider, setCreativeProvider] = useState('development'),
    [narrationProvider, setNarrationProvider] = useState('development'),
    [musicProvider, setMusicProvider] = useState('none'),
    [voice, setVoice] = useState('alloy');
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent className="studio-dialog">
        <DialogHeader>
          <div className="eyebrow">START WITH AN IDEA</div>
          <DialogTitle className="dialog-title">
            Your next production.
          </DialogTitle>
          <DialogDescription>
            Set the direction. Develop the story before spending generation
            credits.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void onCreate({
              title: f.get('title'),
              brief: f.get('brief'),
              duration: Number(f.get('duration')),
              kind,
              mode,
              aspect,
              quality,
              videoProvider,
              creativeProvider,
              narrationProvider,
              musicProvider,
              elevenVoiceId: f.get('elevenVoiceId') || undefined,
              voiceStability: Number(f.get('voiceStability') ?? 0.5),
              voiceStyle: Number(f.get('voiceStyle') ?? 0),
              musicPrompt: f.get('musicPrompt') || undefined,
              musicVolumeDb: Number(f.get('musicVolumeDb') ?? -12),
              voice,
              budget: {
                maximumUsd: Number(f.get('budget')),
                maximumRegenerationsPerScene: 2,
                maximumTotalGenerationAttempts: 20,
              },
            });
          }}
        >
          <label className="field">
            Working title
            <input
              name="title"
              required
              minLength={3}
              maxLength={180}
              placeholder="The world after us"
            />
          </label>
          <label className="field">
            Creative brief
            <textarea
              name="brief"
              required
              minLength={10}
              maxLength={6000}
              rows={3}
              placeholder="A 15-second film about the first flower to grow in an abandoned city…"
            />
          </label>
          <div className="form-grid">
            <Choice
              label="Story type"
              value={kind}
              options={['fiction', 'factual']}
              onChange={setKind}
            />
            <Choice
              label="Creative control"
              value={mode}
              options={['manual', 'assisted', 'autonomous']}
              onChange={setMode}
            />
            <Choice
              label="Frame"
              value={aspect}
              options={
                videoProvider === 'runway'
                  ? ['9:16', '16:9']
                  : ['9:16', '16:9', '1:1']
              }
              onChange={setAspect}
            />
            <Choice
              label="Generation quality"
              value={quality}
              options={['draft', 'final']}
              onChange={setQuality}
            />
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setVideoProvider('runway');
                setCreativeProvider('openai');
                setNarrationProvider('openai');
                setMode('assisted');
                setAspect('9:16');
              }}
            >
              Use AI MVP setup
            </button>
            <Choice
              label="Video provider"
              value={videoProvider}
              options={['development', 'runway']}
              onChange={(value) => {
                setVideoProvider(value);
                if (value === 'runway' && aspect === '1:1') setAspect('9:16');
              }}
            />
            <Choice
              label="Creative provider"
              value={creativeProvider}
              options={['development', 'openai']}
              onChange={setCreativeProvider}
            />
            <Choice
              label="Narration provider"
              value={narrationProvider}
              options={['development', 'openai', 'elevenlabs']}
              onChange={setNarrationProvider}
            />
            {narrationProvider === 'elevenlabs' && (
              <>
                <label className="field">
                  ElevenLabs voice ID
                  <input
                    name="elevenVoiceId"
                    defaultValue="JBFqnCBsd6RMkjVDRZzb"
                    required
                    pattern="[a-zA-Z0-9_-]{1,100}"
                  />
                </label>
                <label className="field">
                  Voice stability (0 expressive · 1 consistent)
                  <input
                    name="voiceStability"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    defaultValue="0.5"
                    required
                  />
                </label>
                <label className="field">
                  Style exaggeration
                  <input
                    name="voiceStyle"
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    defaultValue="0"
                    required
                  />
                </label>
              </>
            )}
            <Choice
              label="Music provider"
              value={musicProvider}
              options={['none', 'elevenlabs']}
              onChange={setMusicProvider}
            />
            {musicProvider === 'elevenlabs' && (
              <>
                <label className="field">
                  Instrumental soundtrack prompt
                  <textarea
                    name="musicPrompt"
                    maxLength={2000}
                    rows={3}
                    defaultValue="Subtle cinematic instrumental score, warm textures, gentle emotional build, spacious arrangement beneath spoken narration."
                  />
                </label>
                <label className="field">
                  Music level / dB (lower is quieter)
                  <input
                    name="musicVolumeDb"
                    type="number"
                    min="-40"
                    max="0"
                    defaultValue="-12"
                    required
                  />
                </label>
                <p className="helper">
                  Eleven Music generates an instrumental soundtrack. Music fades
                  in and out and automatically dips under narration.
                </p>
              </>
            )}
            {narrationProvider === 'openai' && (
              <Choice
                label="AI voice"
                value={voice}
                options={['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']}
                onChange={setVoice}
              />
            )}
            <label className="field">
              Duration / seconds
              <input
                name="duration"
                type="number"
                min={6}
                max={videoProvider === 'runway' ? 30 : 90}
                defaultValue={15}
                required
              />
            </label>
            <label className="field">
              Maximum budget / USD
              <input
                name="budget"
                type="number"
                min={0}
                max={10000}
                defaultValue={20}
                required
              />
            </label>
          </div>
          <p className="helper">
            {videoProvider === 'runway'
              ? 'Runway Gen-4.5 video costs $0.12 per requested second (each scene rounds up to a whole second), plus selected OpenAI text and speech. A 15-second video is about $1.80 before OpenAI and tax. Choose 6–30 seconds. Assisted mode pauses for review before video generation; Run workflow authorizes selected paid creative stages.'
              : creativeProvider === 'openai' || narrationProvider === 'openai'
                ? 'OpenAI text and speech are paid; video uses free test patterns. Assisted mode pauses before video generation. Starting a workflow authorizes its selected AI stages.'
                : 'Development generation costs $0. Assisted mode pauses before generation.'}
          </p>
          {(narrationProvider === 'elevenlabs' ||
            musicProvider === 'elevenlabs') && (
            <p className="helper">
              ElevenLabs audio is paid. Estimates use server-configured rates
              (default $0.10 / 1,000 speech characters and $0.15 / minute of
              music). Starting the workflow authorizes the selected audio
              stages.
            </p>
          )}
          <button disabled={busy} className="primary wide">
            <Plus size={18} /> Create production
          </button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
function ProjectView({
  detail: d,
  perform,
  act,
  busy,
}: {
  detail: ProjectDetail;
  perform: (p: string, i?: unknown) => void;
  act: Action;
  busy: boolean;
}) {
  const p = d.project;
  const [editing, setEditing] = useState<Scene | null>(null);
  const active = d.jobs.some((j) => ['running', 'queued'].includes(j.status));
  const render = d.assets
    .filter((a) => a.type === 'render' && a.revision === p.revision)
    .at(-1);
  const completed = d.scenes.filter((s) => s.assetId).length;
  const actions: Record<string, [string, string][]> = {
    idea: [['concepts', 'Develop concepts']],
    researching: [['concepts', 'Develop concepts']],
    concept_selected: [['script', 'Write script']],
    script_drafting: [['storyboard', 'Build storyboard']],
    assets_planned: [['generate', 'Generate scenes']],
    generating:
      completed === d.scenes.length
        ? d.assets.some(
            (a) =>
              a.type === 'narration' && !a.sceneId && a.revision === p.revision,
          )
          ? p.musicProvider === 'elevenlabs' &&
            !d.assets.some(
              (a) => a.type === 'music' && a.revision === p.revision,
            )
            ? [['music', 'Generate soundtrack']]
            : [['render', 'Render film']]
          : [
              [
                'narration',
                ['openai', 'elevenlabs'].includes(p.narrationProvider)
                  ? 'Generate AI narration'
                  : 'Generate test audio',
              ],
            ]
        : [['generate', 'Generate missing scenes']],
    assembling: [['evaluate', 'Evaluate render']],
    approved: [['package', 'Create platform packages']],
    revision_required: [['render', 'Render revision']],
  };
  return (
    <>
      <div className="project-heading">
        <div>
          <div className="eyebrow">
            PRODUCTION / {p.id.slice(0, 8).toUpperCase()}
          </div>
          <h1>{p.title}</h1>
          <div className="tags">
            <StateBadge state={p.state} />
            <span>{p.duration} seconds</span>
            <span>{p.aspect}</span>
            <span>{label(p.mode)}</span>
            {p.videoProvider === 'runway' && (
              <a href="https://runwayml.com" target="_blank" rel="noreferrer">
                Powered by Runway ↗
              </a>
            )}
            <span>Revision {p.revision}</span>
            <span>Video: {p.videoProvider ?? 'development'}</span>
            <span>Creative: {p.creativeProvider ?? 'development'}</span>
            <span>
              Audio: {p.narrationProvider ?? 'development'} · Music:{' '}
              {p.musicProvider ?? 'none'}
            </span>
          </div>
        </div>
        <div className="actions">
          {p.automationRunning ? (
            <button
              className="secondary"
              onClick={() => perform(`/api/projects/${p.id}/pause`)}
            >
              <Pause size={16} /> Pause progression
            </button>
          ) : (
            <button
              className="secondary"
              disabled={busy || active || p.state === 'packaged'}
              onClick={() => perform(`/api/projects/${p.id}/run`)}
            >
              <Play size={16} />{' '}
              {p.mode === 'manual' ? 'Start next review' : 'Run workflow'}
            </button>
          )}
          {(actions[p.state] ?? []).map(([action, caption]) => (
            <button
              className="primary"
              key={action}
              disabled={busy || active}
              onClick={() => {
                if (action === 'generate' && p.videoProvider === 'runway') {
                  void act(`/api/projects/${p.id}/generate`)
                    .then(() => act(`/api/projects/${p.id}/run`))
                    .catch(() => {});
                } else perform(`/api/projects/${p.id}/${action}`);
              }}
            >
              {active ? <Clock size={16} /> : <Play size={16} />}{' '}
              {action === 'generate' && p.videoProvider === 'runway'
                ? 'Generate film'
                : caption}
            </button>
          ))}
        </div>
      </div>
      {p.error && <div className="notice error">{p.error}</div>}
      {p.videoProvider === 'runway' && p.state === 'assets_planned' && (
        <div className="notice">
          Review the three scenes, then choose Generate film to authorize Runway
          clips, the selected narration, and assembly. Estimated video:{' '}
          {money(
            d.scenes.reduce(
              (total, s) => total + Math.ceil(s.durationSeconds) * 0.12,
              0,
            ),
          )}
          , plus OpenAI and tax. Your project budget applies.
        </div>
      )}
      <div className="project-summary">
        <div className="panel brief">
          <span className="eyebrow">DIRECTOR’S BRIEF</span>
          <p>{p.brief}</p>
        </div>
        <div className="panel">
          <div className="row">
            <span>Scene production</span>
            <strong>
              {completed} / {d.scenes.length}
            </strong>
          </div>
          <Progress
            aria-label="Completed scenes"
            value={d.scenes.length ? (completed / d.scenes.length) * 100 : 0}
          />
          <div className="row helper">
            <span>
              {money(p.spentUsd)} spent / {money(p.budget.maximumUsd)} limit
            </span>
            <span>{p.generationAttempts} attempts</span>
          </div>
        </div>
      </div>
      <Tabs defaultValue="storyboard">
        <TabsList variant="line" className="main-tabs">
          {[
            'storyboard',
            'concepts',
            'script',
            'research',
            'assets',
            'generations',
            'review',
            'delivery',
            'activity',
          ].map((t) => (
            <TabsTrigger value={t} key={t}>
              {label(t)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="storyboard">
          <div className="section-heading">
            <h2>The film, scene by scene</h2>
            <span>
              {p.quality.toUpperCase()} /{' '}
              {(p.videoProvider ?? 'development').toUpperCase()}
            </span>
          </div>
          {d.scenes.length ? (
            <>
              <div className="scene-grid">
                {d.scenes.map((s) => {
                  const asset = d.assets.find((a) => a.id === s.assetId);
                  return (
                    <article className="scene-card" key={s.id}>
                      <div
                        className={`scene-media cover-${(s.sceneNumber - 1) % 3}`}
                      >
                        {asset ? (
                          <video
                            src={`/media/${asset.id}`}
                            controls
                            preload="metadata"
                            playsInline
                            aria-label={`Scene ${s.sceneNumber} video preview`}
                            muted
                          />
                        ) : (
                          <div className="scene-placeholder">
                            <Film size={30} />
                            <span>
                              Shot {String(s.sceneNumber).padStart(2, '0')}
                            </span>
                            <small>Awaiting test footage</small>
                          </div>
                        )}
                        <span className="scene-time">
                          {s.startTime.toFixed(0)} — {s.endTime.toFixed(0)}s
                        </span>
                      </div>
                      <div className="scene-body">
                        <div className="row">
                          <span className="eyebrow">
                            SCENE {String(s.sceneNumber).padStart(2, '0')}
                          </span>
                          <StateBadge state={s.status} />
                        </div>
                        <h3>{s.purpose}</h3>
                        <p className="narration">“{s.narration}”</p>
                        <p className="helper">{s.cameraDirection}</p>
                        <div className="scene-actions">
                          <button
                            className="secondary"
                            disabled={active}
                            onClick={() => setEditing(s)}
                          >
                            <Settings2 size={14} /> Edit scene
                          </button>
                          {asset && (
                            <>
                              <button
                                className="icon-button"
                                title="Approve scene"
                                aria-label={`Approve scene ${s.sceneNumber}`}
                                disabled={active}
                                onClick={() =>
                                  perform(`/api/scenes/${s.id}/approve`)
                                }
                              >
                                <Check size={17} />
                              </button>
                              <button
                                className="icon-button"
                                title="Regenerate scene"
                                aria-label={`Regenerate scene ${s.sceneNumber}`}
                                disabled={active}
                                onClick={() =>
                                  perform(`/api/scenes/${s.id}/regenerate`)
                                }
                              >
                                <RefreshCw size={16} />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
              <div className="timeline">
                <span className="eyebrow">TIMELINE</span>
                <div className="timeline-clips">
                  {d.scenes.map((s) => (
                    <div key={s.id} style={{ flex: s.durationSeconds }}>
                      <Film size={14} /> {s.sceneNumber}{' '}
                      <small>{s.durationSeconds.toFixed(1)}s</small>
                    </div>
                  ))}
                </div>
                <div className="audio-track">
                  <Radio size={14} />{' '}
                  {d.assets.some(
                    (a) =>
                      a.type === 'narration' &&
                      !a.sceneId &&
                      a.revision === p.revision,
                  )
                    ? ['openai', 'elevenlabs'].includes(p.narrationProvider)
                      ? 'AI-generated voice · scene-aligned'
                      : 'Development test tone · not spoken narration'
                    : 'Audio not generated'}
                </div>
              </div>
            </>
          ) : (
            <Empty title="Every shot needs a purpose">
              Select a concept, generate a script, then build the storyboard.
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="concepts">
          <div className="section-heading">
            <h2>Find the story worth telling</h2>
            <span>
              {p.creativeProvider === 'openai'
                ? 'AI EDITORIAL SCORES / NOT AUDIENCE DATA'
                : 'DEVELOPMENT RUBRIC / NOT A RETENTION PREDICTION'}
            </span>
          </div>
          <div className="concept-grid">
            {d.concepts.map((c) => (
              <article
                className={`panel concept ${c.selected ? 'selected' : ''}`}
                key={c.id}
              >
                <div className="row">
                  <span className="eyebrow">{c.hookType}</span>
                  <div className="score">
                    {c.score}
                    <small>/100</small>
                  </div>
                </div>
                <h3>{c.title}</h3>
                <blockquote>{c.hook}</blockquote>
                <p>{c.premise}</p>
                <div className="tags">
                  <span>{c.emotionalTarget}</span>
                </div>
                <details>
                  <summary>Scoring rationale</summary>
                  <p>{c.explanation}</p>
                  {Object.entries(c.criteria).map(([key, v]) => (
                    <div className="row helper" key={key}>
                      <span>{label(key)}</span>
                      <strong>{v}</strong>
                    </div>
                  ))}
                </details>
                <button
                  className={c.selected ? 'secondary wide' : 'primary wide'}
                  disabled={
                    busy ||
                    active ||
                    !['idea', 'researching', 'concept_selected'].includes(
                      p.state,
                    ) ||
                    c.selected
                  }
                  onClick={() =>
                    perform(`/api/projects/${p.id}/select`, { conceptId: c.id })
                  }
                >
                  {c.selected ? (
                    <>
                      <Check size={16} /> Selected direction
                    </>
                  ) : (
                    'Select this concept'
                  )}
                </button>
              </article>
            ))}
          </div>
          {!d.concepts.length && (
            <Empty title="Explore three creative directions">
              Use Develop concepts to create hooks, premises and a transparent
              score.
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="script">
          {d.scripts.length ? (
            <div className="script-page">
              <span className="eyebrow">CANONICAL SCRIPT / DRAFT</span>
              <h2>{p.title}</h2>
              {d.scenes.map((s) => (
                <section key={s.id}>
                  <span className="eyebrow">
                    {s.sceneNumber}. {s.purpose} /{' '}
                    {s.durationSeconds.toFixed(1)} SECONDS
                  </span>
                  <blockquote>{s.narration}</blockquote>
                  <p>{s.visualDescription}</p>
                  <p className="helper">
                    {s.lighting} · {s.soundDesign}
                  </p>
                </section>
              ))}
            </div>
          ) : (
            <Empty title="The script begins with a concept" />
          )}
        </TabsContent>
        <TabsContent value="research">
          <Research detail={d} act={act} />
        </TabsContent>
        <TabsContent value="assets">
          <AssetGrid assets={d.assets} />
        </TabsContent>
        <TabsContent value="generations">
          <div className="section-heading">
            <h2>AI requests &amp; calculated costs</h2>
            <span>{money(p.reservedUsd)} RESERVED</span>
          </div>
          <p className="helper">
            Costs use published rates and returned usage, not a billing invoice.
            Uncertain requests retain a reservation to avoid duplicate charges.
          </p>
          {(d.apiCalls ?? []).map((call) => (
            <details className="panel" key={call.id}>
              <summary>
                {label(call.stage)} · {call.model} · {call.status} · $
                {call.calculatedUsd.toFixed(6)}
              </summary>
              <p>
                Request ID: {call.requestId ?? 'Not returned'} · Attempt{' '}
                {call.attempt} · ${call.estimatedUsd.toFixed(6)} estimated
              </p>
              <p>{call.error ?? call.pricingBasis}</p>
              <pre>{JSON.stringify(call.usage ?? {}, null, 2)}</pre>
            </details>
          ))}

          <Queue jobs={d.jobs} projects={[p]} perform={perform} />
          <div className="section-heading">
            <h2>Generation lineage</h2>
          </div>
          {d.generations.map((g) => (
            <details className="panel" key={g.id}>
              <summary>
                {g.provider} / {g.model} · Attempt {g.attempt} · {g.status} ·{' '}
                {money(g.actualUsd)}
              </summary>
              <p>Request: {g.remoteTaskId ?? g.requestId}</p>
              <p>
                {g.costBasis ?? 'Estimated cost'} · {money(g.estimatedUsd)}
              </p>
              <pre>{g.prompt}</pre>
              <p>
                {g.error ??
                  `${g.latencyMs ?? 0} ms · ${g.assetId ?? 'No asset yet'}`}
              </p>
            </details>
          ))}
          <details className="panel">
            <summary>Versioned prompt executions ({d.prompts.length})</summary>
            {d.prompts.map((pr) => (
              <div key={pr.id}>
                <h3>
                  {pr.version} · {pr.model}
                </h3>
                <pre>{JSON.stringify(pr.input, null, 2)}</pre>
              </div>
            ))}
          </details>
        </TabsContent>
        <TabsContent value="review">
          {render ? (
            <div className="review-layout">
              <div className="render-player">
                <video
                  controls
                  preload="metadata"
                  src={`/media/${render.id}`}
                  aria-label="Assembled film preview"
                >
                  <track
                    kind="captions"
                    src={
                      d.assets
                        .filter(
                          (a) =>
                            a.type === 'subtitles' &&
                            a.path.endsWith('.vtt') &&
                            a.revision === p.revision,
                        )
                        .at(-1)
                        ? `/media/${d.assets.filter((a) => a.type === 'subtitles' && a.path.endsWith('.vtt') && a.revision === p.revision).at(-1)!.id}`
                        : '/development.vtt'
                    }
                    srcLang="en"
                    label="Canonical script"
                  />
                </video>
              </div>
              <div>
                <div className="notice">
                  <ShieldCheck size={20} />
                  <div>
                    <strong>
                      {p.videoProvider === 'runway'
                        ? 'AI-generated film'
                        : 'Development preview'}
                    </strong>
                    <p>
                      {p.videoProvider === 'runway'
                        ? 'This film uses AI-generated video. '
                        : 'This preview uses test visuals. '}
                      {['openai', 'elevenlabs'].includes(p.narrationProvider)
                        ? 'Narration is AI-generated, not a human voice.'
                        : 'Audio is a test tone.'}{' '}
                      Technical checks do not evaluate story quality or factual
                      accuracy.
                    </p>
                  </div>
                </div>
                {d.evaluations.map((e) => (
                  <article className="panel" key={e.id}>
                    <div className="row">
                      <h3>Technical export check</h3>
                      <StateBadge state={e.passed ? 'passed' : 'failed'} />
                    </div>
                    <p>{e.method}</p>
                    <div className="tags">
                      {Object.entries(e.metrics).map(([k, v]) => (
                        <span key={k}>
                          {label(k)}: {String(v)}
                        </span>
                      ))}
                    </div>
                    {e.issues.map((issue) => (
                      <p key={issue}>{issue}</p>
                    ))}
                  </article>
                ))}
                <a className="primary" href={`/media/${render.id}?download=1`}>
                  <Download size={16} /> Download MP4
                </a>
              </div>
            </div>
          ) : (
            <Empty title="The screening room is waiting">
              Generate every scene and the audio track, then render the film.
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="delivery">
          <div className="notice">
            <ShieldCheck size={20} />
            <div>
              <strong>Publishing is disconnected</strong>
              <p>
                Packages are local exports. Review visuals, narration, factual
                claims and rights before publishing manually. Synthetic media is
                disclosed in each package.
              </p>
            </div>
          </div>
          <div className="provider-grid">
            {d.packages.map((pack) => (
              <article className="panel" key={pack.id}>
                <span className="eyebrow">{pack.platform}</span>
                <h3>{pack.title}</h3>
                <p>{pack.caption}</p>
                <p className="helper">{pack.disclosure}</p>
                <p>{pack.hashtags.map((h) => `#${h}`).join(' ')}</p>
                <div className="download-links">
                  <a href={`/media/${pack.assetId}?download=1`}>Video ↗</a>
                  <a href={`/media/${pack.subtitleAssetId}?download=1`}>
                    Subtitles ↗
                  </a>
                  <a href={`/media/${pack.thumbnailAssetId}?download=1`}>
                    Thumbnail ↗
                  </a>
                  <a href={`/media/${pack.downloadAssetId}?download=1`}>
                    Package JSON ↗
                  </a>
                </div>
              </article>
            ))}
          </div>
          {!d.packages.length && (
            <Empty title="No delivery packages yet">
              A successful technical evaluation unlocks platform packaging.
            </Empty>
          )}
        </TabsContent>
        <TabsContent value="activity">
          <div className="event-list">
            {[...d.events].reverse().map((e) => (
              <article key={e.id}>
                <span className="event-dot" />
                <div>
                  <strong>{label(e.type.replaceAll('.', ' '))}</strong>
                  <p>{JSON.stringify(e.detail)}</p>
                </div>
                <time>{new Date(e.createdAt).toLocaleTimeString()}</time>
              </article>
            ))}
          </div>
        </TabsContent>
      </Tabs>
      <SceneEditor scene={editing} close={() => setEditing(null)} act={act} />
    </>
  );
}
function SceneEditor({
  scene: s,
  close,
  act,
}: {
  scene: Scene | null;
  close: () => void;
  act: Action;
}) {
  return (
    <Dialog
      open={Boolean(s)}
      onOpenChange={(v) => {
        if (!v) close();
      }}
    >
      <DialogContent className="studio-dialog">
        <DialogHeader>
          <DialogTitle className="dialog-title">
            Direct scene {s?.sceneNumber}
          </DialogTitle>
          <DialogDescription>
            Edits preserve the previous scene revision and invalidate its
            generated output.
          </DialogDescription>
        </DialogHeader>
        {s && (
          <form
            key={s.id}
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(`/api/scenes/${s.id}/edit`, {
                prompt: f.get('prompt'),
                narration: f.get('narration'),
                provider: s.provider ?? 'development',
              })
                .then(close)
                .catch(() => {});
            }}
          >
            <label className="field">
              Generation prompt
              <textarea
                name="prompt"
                rows={8}
                required
                minLength={10}
                maxLength={8000}
                defaultValue={s.prompt}
              />
            </label>
            <label className="field">
              Narration
              <textarea
                name="narration"
                rows={3}
                maxLength={3000}
                defaultValue={s.narration}
              />
            </label>
            <p className="helper">
              Provider: Development studio · Reference uploads and real
              generation adapters are not connected.
            </p>
            <div className="actions">
              <button className="primary">Save revision</button>
              {s.assetId && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    void act(`/api/scenes/${s.id}/reject`)
                      .then(close)
                      .catch(() => {})
                  }
                >
                  Reject scene
                </button>
              )}
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
function Research({ detail: d, act }: { detail: ProjectDetail; act: Action }) {
  const [verified, setVerified] = useState(false);
  return (
    <>
      <div className="notice">
        <ShieldCheck size={20} />
        <div>
          <strong>
            {d.project.kind === 'fiction'
              ? 'Fiction: factual verification bypassed'
              : 'Factual project: human verification required'}
          </strong>
          <p>
            Store the source and the specific claim it supports. Source
            retrieval and automated fact-checking are not connected.
          </p>
        </div>
      </div>
      <div className="research-grid">
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const f = new FormData(form);
            void act(`/api/projects/${d.project.id}/research`, {
              url: f.get('url'),
              fact: f.get('fact'),
              confidence: Number(f.get('confidence')),
              verified,
              notes: 'Added and reviewed in the studio',
            })
              .then(() => form.reset())
              .catch(() => {});
          }}
        >
          <h3>Add a source</h3>
          <label className="field">
            Source URL
            <input name="url" type="url" required placeholder="https://…" />
          </label>
          <label className="field">
            Supported factual claim
            <textarea
              name="fact"
              minLength={10}
              maxLength={4000}
              required
              rows={3}
            />
          </label>
          <label className="field">
            Confidence / 0–1
            <input
              name="confidence"
              type="number"
              min={0}
              max={1}
              step={0.1}
              defaultValue={0.8}
              required
            />
          </label>
          <label className="check-label" htmlFor="verify-source">
            <Checkbox
              id="verify-source"
              checked={verified}
              onCheckedChange={(v) => setVerified(Boolean(v))}
            />{' '}
            I have verified this claim against the source.
          </label>
          <button className="primary">Save source</button>
        </form>
        <div>
          {d.research.map((r) => (
            <article className="panel" key={r.id}>
              <StateBadge
                state={r.verified ? 'human_verified' : 'unverified'}
              />
              <p>{r.fact}</p>
              <a href={r.url} target="_blank" rel="noreferrer">
                Read source ↗
              </a>
              <p className="helper">
                Confidence: {r.confidence} ·{' '}
                {new Date(r.accessedAt).toLocaleDateString()}
              </p>
            </article>
          ))}
          {!d.research.length && <Empty title="No sources recorded" />}
        </div>
      </div>
    </>
  );
}
function AssetGrid({ assets }: { assets: Asset[] }) {
  return assets.length ? (
    <div className="asset-grid">
      {[...assets].reverse().map((a) => (
        <article className="panel asset" key={a.id}>
          {a.type === 'video' || a.type === 'render' ? (
            <video
              src={`/media/${a.id}`}
              controls
              preload="metadata"
              playsInline
              aria-label={`${a.type} revision ${a.revision}`}
            >
              <track
                kind="captions"
                src={
                  assets
                    .filter(
                      (c) =>
                        c.projectId === a.projectId &&
                        c.revision === a.revision &&
                        c.type === 'subtitles' &&
                        c.path.endsWith('.vtt'),
                    )
                    .at(-1)
                    ? `/media/${assets.filter((c) => c.projectId === a.projectId && c.revision === a.revision && c.type === 'subtitles' && c.path.endsWith('.vtt')).at(-1)!.id}`
                    : '/development.vtt'
                }
                srcLang="en"
                label="Development audio description"
              />
            </video>
          ) : a.type === 'thumbnail' ? (
            <Image
              unoptimized
              width={360}
              height={640}
              src={`/media/${a.id}`}
              alt="Development thumbnail"
            />
          ) : a.type === 'narration' || a.type === 'music' ? (
            <audio
              src={`/media/${a.id}`}
              controls
              aria-label={
                a.parameters.isSpeech
                  ? 'AI-generated narration'
                  : a.type === 'music'
                    ? 'AI-generated instrumental soundtrack'
                    : 'Development audio test tone'
              }
            >
              <track
                kind="captions"
                src={
                  assets
                    .filter(
                      (c) =>
                        c.projectId === a.projectId &&
                        c.revision === a.revision &&
                        c.type === 'subtitles' &&
                        c.path.endsWith('.vtt'),
                    )
                    .at(-1)
                    ? `/media/${assets.filter((c) => c.projectId === a.projectId && c.revision === a.revision && c.type === 'subtitles' && c.path.endsWith('.vtt')).at(-1)!.id}`
                    : '/development.vtt'
                }
                srcLang="en"
                label="Test tone"
              />
            </audio>
          ) : (
            <div className="file-icon">
              <ImageIcon size={30} />
            </div>
          )}
          <div className="row">
            <h3>{label(a.type)}</h3>
            <span className="helper">r{a.revision}</span>
          </div>
          <p className="helper">
            {a.provider} · {(a.size / 1024).toFixed(0)} KB · {money(a.costUsd)}
          </p>
          <a href={`/media/${a.id}?download=1`} className="download">
            <Download size={14} /> Download
          </a>
          <details>
            <summary>Provenance</summary>
            <p className="helper">{a.license}</p>
            <pre>
              {JSON.stringify(
                {
                  prompt: a.prompt,
                  parameters: a.parameters,
                  parentAssetId: a.parentAssetId,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </article>
      ))}
    </div>
  ) : (
    <Empty title="Your asset library is ready">
      Generated clips, audio, captions and final renders will appear here with
      their provenance.
    </Empty>
  );
}
function Queue({
  jobs,
  projects,
  perform,
}: {
  jobs: Job[];
  projects: Project[];
  perform: (path: string) => void;
}) {
  return jobs.length ? (
    <div className="queue">
      <div className="queue-row queue-head">
        <span>Production / job</span>
        <span>Status</span>
        <span>Attempt</span>
        <span>Updated</span>
        <span>Action</span>
      </div>
      {jobs.map((j) => (
        <div className="queue-row" key={j.id}>
          <div>
            <strong>{label(j.type)}</strong>
            <small>
              {projects.find((p) => p.id === j.projectId)?.title ??
                j.projectId.slice(0, 8)}
            </small>
            {j.error && <p className="job-error">{j.error}</p>}
          </div>
          <StateBadge state={j.status} />
          <span>
            {j.attempt} / {j.maxAttempts}
          </span>
          <span>{new Date(j.updatedAt).toLocaleTimeString()}</span>
          <div>
            {['queued', 'running'].includes(j.status) ? (
              <button
                className="text-button"
                onClick={() => perform(`/api/jobs/${j.id}/cancel`)}
              >
                Cancel
              </button>
            ) : ['failed', 'cancelled'].includes(j.status) &&
              j.attempt < j.maxAttempts ? (
              <button
                className="text-button"
                onClick={() => perform(`/api/jobs/${j.id}/retry`)}
              >
                Retry
              </button>
            ) : (
              <Check size={16} />
            )}
          </div>
        </div>
      ))}
    </div>
  ) : (
    <Empty title="Nothing in the queue">
      Launch a production step to see persistent jobs, attempts and failures
      here.
    </Empty>
  );
}
