/**
 * Host-injected GitLab transport.
 *
 * The host authenticates and executes HTTP. This package owns endpoint
 * construction, pagination policy, and response parsing.
 */
export type GitLabTransport = {
  request<T>(request: {
    body?: unknown;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
  }): Promise<T>;
  /**
   * Optional paginated reader. When omitted, {@link request} is called with
   * `page` / `per_page` until a short page is returned.
   */
  requestPages?(request: {
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
  }): Promise<Array<unknown>>;
  /** Optional raw text reader for repository file blobs. */
  requestText?(request: {
    path: string;
    query?: Readonly<Record<string, boolean | number | string>>;
  }): Promise<string>;
};

export type FakeGitLabTransportRoute = {
  body?: unknown;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Readonly<Record<string, boolean | number | string>>;
  response:
    | unknown
    | ((request: {
        method: string;
        path: string;
        query?: Readonly<Record<string, boolean | number | string>>;
      }) => unknown | Promise<unknown>);
  text?:
    | string
    | ((request: {
        method: string;
        path: string;
        query?: Readonly<Record<string, boolean | number | string>>;
      }) => string | Promise<string>);
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
export const createFakeGitLabTransport = (
  routes: ReadonlyArray<FakeGitLabTransportRoute>,
): GitLabTransport & {
  calls: Array<{ method: string; path: string; query?: Record<string, boolean | number | string> }>;
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
        throw new Error(
          `No fake GitLab route for ${method} ${request.path}?${queryKey(request.query)}`,
        );
      }
      const response =
        typeof route.response === 'function'
          ? await route.response({ method, path: request.path, query: request.query })
          : route.response;
      return response as never;
    },
    async requestPages(request) {
      // Collect all pages if fake routes include page query variants; else one shot.
      const values: Array<unknown> = [];
      let page = 1;
      while (page < 50) {
        const pageQuery = { ...(request.query ?? {}), page, per_page: 100 };
        const route =
          matchRoute('GET', request.path, pageQuery) ??
          (page === 1 ? matchRoute('GET', request.path, request.query) : undefined);
        if (!route) {
          break;
        }
        calls.push({ method: 'GET', path: request.path, query: pageQuery });
        const response =
          typeof route.response === 'function'
            ? await route.response({ method: 'GET', path: request.path, query: pageQuery })
            : route.response;
        const pageValues = Array.isArray(response) ? response : [];
        values.push(...pageValues);
        if (pageValues.length < 100) {
          break;
        }
        page += 1;
      }
      return values;
    },
    async requestText(request) {
      calls.push({
        method: 'GET',
        path: request.path,
        ...(request.query ? { query: { ...request.query } } : {}),
      });
      const route = matchRoute('GET', request.path, request.query);
      if (!route || route.text == null) {
        throw new Error(`No fake GitLab text route for GET ${request.path}`);
      }
      return typeof route.text === 'function'
        ? route.text({ method: 'GET', path: request.path, query: request.query })
        : route.text;
    },
  };
};
