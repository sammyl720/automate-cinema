import { get, list } from './db';
import { DomainError } from './policy';
import { stat } from 'node:fs/promises';
import type { Generation, Asset } from '../shared/domain';
import { config } from './config';
import { mediaPath, prepareDir, runProcess, dimensions } from './media';
import type { Project, Scene, ProviderInfo } from '../shared/domain';
export interface VideoGenerationRequest {
  project: Project;
  scene: Scene;
  idempotencyKey: string;
  signal?: AbortSignal;
}
export interface GenerationJob {
  id: string;
  status: 'completed' | 'pending';
  storageKey?: string;
  costUsd: number;
  providerRequestId: string;
}
export interface VideoGenerationProvider {
  info: ProviderInfo;
  generate(input: VideoGenerationRequest): Promise<GenerationJob>;
  getStatus(jobId: string): Promise<GenerationJob>;
  cancel?(jobId: string): Promise<void>;
}
export interface NarrationProvider {
  generate(input: {
    project: Project;
    transcript: string;
    signal?: AbortSignal;
  }): Promise<{ storageKey: string; isSpeech: boolean }>;
}
export interface ImageGenerationProvider {
  generate(input: {
    prompt: string;
    referenceAssetIds: string[];
    aspect: string;
    idempotencyKey: string;
  }): Promise<GenerationJob>;
}
export interface PublishingProvider {
  status: 'connected' | 'unsupported' | 'authentication_required';
  publish(input: {
    projectId: string;
    packageId: string;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string; status: 'published' }>;
}
const caps = {
  textToVideo: true,
  imageToVideo: false,
  referenceImages: false,
  audioGeneration: true,
  maximumDurationSeconds: 30,
  supportedAspectRatios: ['9:16', '16:9', '1:1'],
};
export const providerRegistry: ProviderInfo[] = [
  {
    id: 'development',
    name: 'Development studio',
    status: 'connected',
    demo: true,
    capabilities: caps,
    costPerSecond: 0,
    model: 'deterministic-v1',
  },
  {id:'openai', name:'OpenAI · creative & narration',status:'authentication_required',demo:false,capabilities:{...caps,textToVideo:false,audioGeneration:true,maximumDurationSeconds:0},costPerSecond:0,model:'gpt-4.1-mini / tts-1'},
  ...['Runway', 'Higgsfield', 'ElevenLabs'].map((name) => ({
    id: name.toLowerCase(),
    name,
    status: 'unsupported' as const,
    demo: false,
    capabilities: {
      ...caps,
      textToVideo: false,
      audioGeneration: false,
      maximumDurationSeconds: 0,
    },
    costPerSecond: 0,
    model: 'Not integrated',
  })),
];
export class DevelopmentVideoProvider implements VideoGenerationProvider {
  info = providerRegistry[0];
  async generate({
    project: p,
    scene: s,
    idempotencyKey,
    signal,
  }: VideoGenerationRequest) {
    await prepareDir(p.id);
    const [w, h] = dimensions(p.aspect, p.quality);
    const key = `${p.id}/${s.id}-r${s.revision}.mp4`;
    const colors = ['0x244650', '0x64503b', '0x294836'];
    await runProcess(
      config.FFMPEG_PATH,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${colors[(s.sceneNumber - 1) % 3]}:s=${w}x${h}:r=24:d=${s.durationSeconds}`,
        '-vf',
        `drawgrid=w=iw/6:h=ih/10:t=1:c=white@0.08,drawbox=x=iw/5:y=ih/3:w=iw*0.6:h=ih/3:color=white@0.07:t=fill`,
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        mediaPath(key),
      ],
      signal,
    );
    return {
      id: idempotencyKey,
      status: 'completed' as const,
      storageKey: key,
      costUsd: 0,
      providerRequestId: idempotencyKey,
    };
  }
  async getStatus(jobId: string): Promise<GenerationJob> {
    const generation = list<Generation>('generation').find(
      (g) => g.requestId === jobId,
    );
    if (!generation) throw new DomainError('Generation job not found', 404);
    if (generation.status === 'failed')
      throw new DomainError(generation.error ?? 'Generation failed');
    if (!generation.assetId)
      return {
        id: jobId,
        status: 'pending',
        costUsd: generation.estimatedUsd,
        providerRequestId: jobId,
      };
    const asset = get<Asset>('asset', generation.assetId);
    await stat(mediaPath(asset.path));
    return {
      id: jobId,
      status: 'completed',
      storageKey: asset.path,
      costUsd: generation.actualUsd,
      providerRequestId: jobId,
    };
  }
}
export const developmentNarration: NarrationProvider = {
  async generate({ project: p, signal }) {
    await prepareDir(p.id);
    const key = `${p.id}/narration-r${p.revision}.wav`;
    await runProcess(
      config.FFMPEG_PATH,
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=130:sample_rate=48000:duration=${p.duration}`,
        '-af',
        `volume=0.025,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, p.duration - 1)}:d=1`,
        '-c:a',
        'pcm_s16le',
        mediaPath(key),
      ],
      signal,
    );
    return { storageKey: key, isSpeech: false };
  },
};
export const unavailablePublisher: PublishingProvider = {
  status: 'unsupported',
  async publish() {
    throw new DomainError(
      'Publishing is unavailable. Connect an implemented publishing adapter before publishing.',
      501,
    );
  },
};

export const videoProviders: Record<string, VideoGenerationProvider> = {
  development: new DevelopmentVideoProvider(),
};

export function getProviderRegistry():ProviderInfo[]{return providerRegistry.map(p=>p.id==='openai'?{...p,status:config.OPENAI_API_KEY?'configured':'authentication_required'}:p)}
