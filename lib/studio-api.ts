import type { Snapshot, ProjectDetail } from '../shared/domain';
export async function api<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: input === undefined ? {} : { 'Content-Type': 'application/json' },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const data = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Request failed');
  return data as T;
}
export const readStudio = () => api<Snapshot>('/api/studio');
export const readProject = (id: string) =>
  api<ProjectDetail>(`/api/projects/${id}`);
export const label = (s: string) =>
  s.replaceAll('_', ' ').replace(/^\w/, (x) => x.toUpperCase());
export const money = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    n,
  );
