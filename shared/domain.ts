import { z } from 'zod';
export const states = [
  'idea',
  'researching',
  'concept_selected',
  'script_drafting',
  'storyboarding',
  'assets_planned',
  'generating',
  'assembling',
  'evaluating',
  'revision_required',
  'approved',
  'packaged',
  'scheduled',
  'published',
  'performance_tracking',
  'archived',
  'failed',
] as const;
export type State = (typeof states)[number];
export const projectInput = z.object({
  title: z.string().trim().min(3).max(180),
  brief: z.string().trim().min(10).max(6000),
  kind: z.enum(['fiction', 'factual']).default('fiction'),
  duration: z.number().int().min(6).max(90).default(15),
  aspect: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
  mode: z.enum(['manual', 'assisted', 'autonomous']).default('assisted'),
  quality: z.enum(['draft', 'final']).default('draft'),
  videoProvider: z.enum(['development', 'runway']).default('development'),
  creativeProvider: z.enum(['development', 'openai']).default('development'),
  narrationProvider: z.enum(['development', 'openai']).default('development'),
  voice: z
    .enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])
    .default('alloy'),
  budget: z
    .object({
      maximumUsd: z.number().min(0).max(10000).default(20),
      maximumRegenerationsPerScene: z.number().int().min(0).max(5).default(2),
      maximumTotalGenerationAttempts: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20),
    })
    .default({
      maximumUsd: 20,
      maximumRegenerationsPerScene: 2,
      maximumTotalGenerationAttempts: 20,
    }),
});
export interface RecordBase {
  id: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}
export interface Project extends RecordBase, z.infer<typeof projectInput> {
  state: State;
  selectedConceptId?: string;
  automationRunning: boolean;
  publishingEnabled: boolean;
  spentUsd: number;
  reservedUsd: number;
  generationAttempts: number;
  revision: number;
  creativeBible: {
    palette: string[];
    visualRules: string[];
    characters: string[];
  };
  error?: string;
}
export interface Concept extends RecordBase {
  projectId: string;
  title: string;
  premise: string;
  hook: string;
  hookType: string;
  arc: string[];
  ending: string;
  emotionalTarget: string;
  visualIdentity: string;
  score: number;
  criteria: Record<string, number>;
  explanation: string;
  selected: boolean;
}
export const sceneOutput = z.object({
  sceneNumber: z.number().int().positive(),
  durationSeconds: z.number().positive().max(30),
  purpose: z.string().min(3),
  narration: z.string(),
  visualDescription: z.string().min(10),
  cameraDirection: z.string().min(3),
  lighting: z.string(),
  mood: z.string(),
  transition: z.string(),
  soundDesign: z.string(),
});
export interface Scene extends RecordBase, z.infer<typeof sceneOutput> {
  projectId: string;
  startTime: number;
  endTime: number;
  prompt: string;
  negativePrompt: string;
  provider: string;
  status: 'planned' | 'generating' | 'generated' | 'approved' | 'rejected';
  revision: number;
  assetId?: string;
}
export interface Script extends RecordBase {
  projectId: string;
  title: string;
  hook: string;
  ending: string;
  estimatedDurationSeconds: number;
  version: number;
  narration: {
    sceneNumber: number;
    text: string;
    start: number;
    end: number;
  }[];
}
export interface Asset extends RecordBase {
  projectId: string;
  sceneId?: string;
  type:
    | 'video'
    | 'narration'
    | 'render'
    | 'subtitles'
    | 'thumbnail'
    | 'package';
  path: string;
  mime: string;
  provider: string;
  prompt: string;
  parameters: Record<string, unknown>;
  costUsd: number;
  duration: number;
  width: number;
  height: number;
  size: number;
  revision: number;
  parentAssetId?: string;
  status: 'ready';
  license: string;
}
export interface Job extends RecordBase {
  projectId: string;
  sceneId?: string;
  type: JobType;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  maxAttempts: number;
  runAt: number;
  leaseUntil: number;
  progress: number;
  priority: number;
  key: string;
  payload: Record<string, unknown>;
  error?: string;
}
export const jobTypes = [
  'concepts',
  'script',
  'storyboard',
  'generate',
  'narration',
  'render',
  'evaluate',
  'package',
] as const;
export type JobType = (typeof jobTypes)[number];
export interface Evaluation extends RecordBase {
  projectId: string;
  sceneId?: string;
  score: number;
  passed: boolean;
  method: string;
  issues: string[];
  recommendedChanges: string[];
  metrics: Record<string, number | string | boolean>;
}
export interface Event extends RecordBase {
  projectId: string;
  type: string;
  detail: Record<string, unknown>;
}
export interface ResearchSource extends RecordBase {
  projectId: string;
  url: string;
  fact: string;
  confidence: number;
  verified: boolean;
  notes: string;
  accessedAt: string;
}
export interface PlatformPackage extends RecordBase {
  projectId: string;
  platform: string;
  title: string;
  caption: string;
  hashtags: string[];
  assetId: string;
  subtitleAssetId: string;
  thumbnailAssetId: string;
  disclosure: string;
  status: 'ready';
  downloadAssetId?: string;
}
export interface PromptExecution extends RecordBase {
  projectId: string;
  sceneId?: string;
  name: string;
  version: string;
  provider: string;
  model: string;
  input: unknown;
  output: unknown;
}
export interface Generation extends RecordBase {
  projectId: string;
  sceneId?: string;
  jobId: string;
  provider: string;
  model: string;
  requestId: string;
  prompt: string;
  attempt: number;
  estimatedUsd: number;
  actualUsd: number;
  status:
    | 'reserved'
    | 'submitting'
    | 'submitted'
    | 'uncertain'
    | 'completed'
    | 'failed';
  remoteTaskId?: string;
  billed?: boolean;
  costBasis?: string;
  assetId?: string;
  latencyMs?: number;
  error?: string;
}
export interface ProviderInfo {
  id: string;
  name: string;
  status:
    | 'connected'
    | 'configured'
    | 'unsupported'
    | 'authentication_required';
  demo: boolean;
  capabilities: {
    textToVideo: boolean;
    imageToVideo: boolean;
    referenceImages: boolean;
    audioGeneration: boolean;
    maximumDurationSeconds: number;
    supportedAspectRatios: string[];
  };
  costPerSecond: number;
  model: string;
}
export interface Snapshot {
  projects: Project[];
  jobs: Job[];
  providers: ProviderInfo[];
  assets: Asset[];
  events: Event[];
}
export interface ProjectDetail {
  project: Project;
  concepts: Concept[];
  scripts: Script[];
  scenes: Scene[];
  assets: Asset[];
  jobs: Job[];
  evaluations: Evaluation[];
  events: Event[];
  packages: PlatformPackage[];
  research: ResearchSource[];
  prompts: PromptExecution[];
  generations: Generation[];
  apiCalls: ApiCall[];
}

export interface ApiCall extends RecordBase {
  projectId: string;
  jobId: string;
  sceneId?: string;
  key: string;
  stage: string;
  provider: 'openai';
  model: string;
  status: 'reserved' | 'completed' | 'failed' | 'uncertain';
  attempt: number;
  estimatedUsd: number;
  calculatedUsd: number;
  pricingBasis: string;
  request: unknown;
  result?: unknown;
  requestId?: string;
  latencyMs?: number;
  usage?: Record<string, unknown>;
  error?: string;
}
