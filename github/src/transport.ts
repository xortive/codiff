/**
 * Host-injected GitHub transport.
 *
 * The host authenticates and executes HTTP (gh api / fetch). This package owns
 * endpoint construction, pagination policy, and response parsing.
 */
export type GitHubTransport = {
  request<T>(request: {
    body?: unknown;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    /** When true, hosts should follow pagination and return a combined array. */
    paginate?: boolean;
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
  }): Promise<T>;
  /** Optional raw text reader. */
  requestText?(request: {
    body?: unknown;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    paginate?: boolean;
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
  }): Promise<string>;
};

export type FakeGitHubTransportRoute = {
  body?: unknown;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  query?: Readonly<Record<string, boolean | number | string>>;
  response:
    | unknown
    | ((request: {
        method: string;
        path: string;
        query?: Readonly<Record<string, boolean | number | string>>;
      }) => unknown | Promise<unknown>);
};

const queryKey = (query?: Readonly<Record<string, boolean | number | string>>) =>
  query
    ? Object.entries(query)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('&')
    : '';

/**
 * Deterministic transport for package tests.
 */
export const createFakeGitHubTransport = (
  routes: ReadonlyArray<FakeGitHubTransportRoute>,
): GitHubTransport & {
  calls: Array<{
    method: string;
    path: string;
    query?: Record<string, boolean | number | string>;
  }>;
} => {
  const calls: Array<{
    method: string;
    path: string;
    query?: Record<string, boolean | number | string>;
  }> = [];

  const matchRoute = (
    method: string,
    path: string,
    query?: Readonly<Record<string, boolean | number | string>>,
  ) => {
    const key = queryKey(query);
    return (
      routes.find(
        (route) =>
          route.path === path &&
          (route.method ?? 'GET') === method &&
          queryKey(route.query) === key,
      ) ??
      routes.find(
        (route) => route.path === path && (route.method ?? 'GET') === method && route.query == null,
      )
    );
  };

  return {
    calls,
    async request(request) {
      const method = request.method ?? 'GET';
      calls.push({
        method,
        path: request.path,
        ...(request.query ? { query: { ...request.query } } : {}),
      });
      const route = matchRoute(method, request.path, request.query);
      if (!route) {
        throw new Error(`No fake GitHub route for ${method} ${request.path}`);
      }
      const response =
        typeof route.response === 'function'
          ? await route.response({
              method,
              path: request.path,
              ...(request.query ? { query: request.query } : {}),
            })
          : route.response;
      return response as never;
    },
  };
};
