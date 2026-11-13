/* Types for the relay Worker, so the app's tests can drive it. */
export interface RelayEnv { GITHUB_TOKEN: string; REPO: string; ALLOWED_ORIGINS?: string }
export interface RelayContext { waitUntil(p: Promise<unknown>): void }

declare const worker: {
  fetch(request: Request, env: RelayEnv, ctx: RelayContext): Promise<Response>;
};
export default worker;

export function playerTag(key: string): Promise<string>;
export function nextWeekly(meta: { start: string; timeZone: string }, now: number): { start: string; startUtc: string };

export const _test: {
  clean(text: unknown, max: number): string;
  command(action: string, input: Record<string, unknown>, name: string): string;
  Refusal: new (message: string, status?: number) => Error & { status: number };
};
