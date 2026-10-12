import { Injectable, inject } from '@angular/core';
import { Api } from '../api';

export interface CatalogEntry {
  models: string[];
  error: string;
}

/** The models each provider offers, fetched once per provider and shared by every model dropdown. */
@Injectable({ providedIn: 'root' })
export class ModelCatalog {
  private readonly api = inject(Api);
  private readonly cache = new Map<string, Promise<CatalogEntry>>();

  get(provider: string): Promise<CatalogEntry> {
    if (!provider) return Promise.resolve({ models: [], error: '' });
    let entry = this.cache.get(provider);
    if (!entry) {
      entry = this.api.providerModels(provider).then(
        (models) => ({ models, error: '' }),
        (e: Error) => {
          // Let a later look try again (the server may have been off).
          setTimeout(() => this.cache.delete(provider), 5000);
          return { models: [], error: e.message };
        },
      );
      this.cache.set(provider, entry);
    }
    return entry;
  }

  /** Forget a provider's list, e.g. after it was edited. */
  forget(provider?: string): void {
    if (provider) this.cache.delete(provider);
    else this.cache.clear();
  }
}
