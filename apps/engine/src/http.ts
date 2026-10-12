/** `fetch` that gives up after `ms`, so a hung server never stalls a run or a page. */
export function timedFetch(ms: number): typeof fetch {
  return (input, init = {}) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, signal }).catch((e: unknown) => {
      if (timeout.aborted) throw new Error(`No answer within ${Math.round(ms / 1000)} seconds.`);
      throw e;
    });
  };
}

/** For APIs (code hosts, trackers, Figma, Confluence, model lists). */
export const httpFetch = timedFetch(30_000);
/** For a model generating a reply: local models on a laptop can take minutes. */
export const modelFetch = timedFetch(15 * 60_000);
