export type Call = { method: string; url: string; body: any; headers: Record<string, string> };

/**
 * A fetch that routes "METHOD url-substring" to a status and JSON body (or a function of the call),
 * picking the longest matching route, and records every call.
 */
export function fakeApi(routes: Record<string, [number, unknown] | ((call: Call) => [number, unknown])>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const raw = init?.body ? String(init.body) : undefined;
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const call: Call = { method, url, body, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const key = Object.keys(routes).filter((k) => k.startsWith(`${method} `) && url.includes(k.slice(method.length + 1))).sort((a, b) => b.length - a.length)[0];
    if (!key) return new Response('no route', { status: 404 });
    const route = routes[key];
    const [status, json] = typeof route === 'function' ? route(call) : route;
    return new Response(status === 204 ? null : JSON.stringify(json), { status });
  }) as typeof fetch;
  return { impl, calls };
}
