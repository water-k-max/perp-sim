/**
 *  Everything the route table needs from a server, and nothing else.
 *
 *  Two transports have to satisfy it: `node:http`, which is what the local lab runs on, and the Web
 *  `Request`/`Response` pair that a serverless function is handed. Keeping the contract to the four
 *  members below is what lets one set of routes, one set of origin checks and one set of error
 *  answers serve both — a second route table would drift, and the drift would be found in
 *  production rather than in a test.
 */
export type RequestLike = {
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  readonly headers: Record<string, string | string[] | undefined>;
  /**
   *  The body as a sequence of text chunks. `node:http` yields `Buffer`s, whose `toString()` is the
   *  text; the Web adapter yields the decoded body as one string. Anything else — a raw byte array,
   *  say — would `toString()` into a comma list and the body cap would measure the wrong thing, so
   *  the requirement is stated in the type instead of left to the reader.
   */
  [Symbol.asyncIterator](): AsyncIterator<{ toString(): string }>;
};

export type ResponseLike = {
  setHeader(name: string, value: string | number | readonly string[]): void;
  writeHead(statusCode: number, headers?: Record<string, string | number | string[]>): void;
  end(chunk?: unknown): void;
};

/**
 *  A deployment may serve this server through exactly one extra origin, such as an SSH or Cloudflare
 *  tunnel, or the deployment host itself. It widens the same-origin definition only.
 */
export type PublicOrigin = { origin: string; hosts: string[] };

/**
 *  `local` binds loopback and owns the disk the run store lives on. `serverless` does neither: its
 *  static files come from the deployment's CDN, and a saved run cannot outlive the instance that
 *  wrote it. The mode is what the route table branches on, so the difference between the two is
 *  stated in code rather than left to whoever notices the 404 first.
 */
export type Deployment =
  | { readonly mode: "local"; readonly port: number }
  | { readonly mode: "serverless" };

export type Answer = { status: number; body: unknown };

/** The lanes are the shape `src/bin/work-lanes.ts` exposes, narrowed to what this table calls. */
export type RouteContext = {
  readonly deployment: Deployment;
  readonly publicOrigin: PublicOrigin | null;
  readonly lanes: { submit(key: string, work: () => Promise<Answer>): Promise<Answer> };
};
