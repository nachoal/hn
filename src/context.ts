import { AlgoliaClient } from './clients/algolia.js';
import { FirebaseClient } from './clients/firebase.js';
import { resolveSettings, type Settings } from './config.js';
import { Http } from './http.js';
import type { Meta, Source } from './types.js';

export interface Ctx {
  http: Http;
  firebase: FirebaseClient;
  algolia: AlgoliaClient;
  settings: Settings;
}

export function createContext(): Ctx {
  const settings = resolveSettings();
  const http = new Http({ timeoutMs: settings.timeoutMs, userAgent: settings.userAgent });
  return { http, firebase: new FirebaseClient(http), algolia: new AlgoliaClient(http), settings };
}

export function buildMeta(ctx: Ctx, note?: string): Meta {
  const labels = ctx.http.log.endpoints;
  const usedAlgolia = labels.some((l) => l.startsWith('algolia'));
  const usedFirebase = labels.some((l) => l.startsWith('firebase'));
  const source: Source = usedAlgolia && usedFirebase ? 'mixed' : usedAlgolia ? 'algolia' : usedFirebase ? 'firebase' : 'local';
  const meta: Meta = {
    source,
    requests: ctx.http.log.requests,
    endpoints: [...labels],
    fetched_at: new Date().toISOString(),
  };
  if (note) meta.note = note;
  return meta;
}
