import { z } from "zod";

export class AuthError extends Error {}

export function cloudOrigin(value: string): string {
  try {
    const url = new URL(value);
    if ([url.username, url.password, url.search, url.hash].some(Boolean))
      throw new Error();
    if (!["/", ""].includes(url.pathname)) throw new Error();
    if (!secureProtocol(url)) throw new Error();
    return url.origin;
  } catch {
    throw new AuthError(
      "Cloud URL must be an HTTPS origin (HTTP is allowed only on loopback), without credentials, path, query or fragment.",
    );
  }
}

function secureProtocol(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

export const tokensSchema = z.object({
  token_type: z.literal("Bearer"),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().finite(),
});
export type Tokens = z.infer<typeof tokensSchema> & { expiresAt: number };
export const membershipSchema = z.object({
  user: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
  organizations: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      role: z.string(),
      projects: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});

export async function request(
  origin: string,
  endpoint: string,
  signal: AbortSignal,
  options: { form?: Record<string, string>; access?: string } = {},
) {
  try {
    const response = await fetch(`${origin}${endpoint}`, {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      ...requestOptions(options),
    });
    const body = await responseBody(response, endpoint);
    return {
      ok: response.ok,
      status: response.status,
      body,
      retryMs: retryDelay(response.headers.get("retry-after")),
    };
  } catch {
    throw new AuthError(
      signal.aborted
        ? "Authentication cancelled."
        : "Cloud request failed or timed out. Check the instance URL and connection; redirects are not allowed.",
    );
  }
}

async function responseBody(
  response: Response,
  endpoint: string,
): Promise<unknown> {
  const readBody =
    (response.ok && endpoint !== "/api/oauth/revoke") ||
    (response.status === 400 && endpoint === "/api/oauth/token");
  if (readBody) return response.json();
  await response.body?.cancel().catch(() => {});
  return {};
}

function requestOptions({
  form,
  access,
}: {
  form?: Record<string, string>;
  access?: string;
}): RequestInit {
  const headers: Record<string, string> = {};
  if (access) headers.authorization = `Bearer ${access}`;
  if (!form) return { method: "GET", headers };
  headers["content-type"] = "application/x-www-form-urlencoded";
  return {
    method: "POST",
    headers,
    body: new URLSearchParams({ client_id: "sedum-cli", ...form }),
  };
}

function retryDelay(retry: string | null): number {
  if (!retry) return 0;
  const delay = /^\d+$/.test(retry)
    ? Number(retry) * 1000
    : Math.max(0, Date.parse(retry) - Date.now());
  return Number.isFinite(delay) ? delay : 0;
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new AuthError("Cloud returned an invalid authentication response.");
  return result.data;
}

export function tokenResult(body: unknown): Tokens {
  const tokens = parse(tokensSchema, body);
  return { ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000 };
}
