// Session-token helpers: generation, hashing, bearer parsing, GitHub verification.

export const TOKEN_HEX_RE = /^[0-9a-f]{64}$/;
/** sessions.last_used_at is bumped at most once per hour. */
export const LAST_USED_BUMP_MS = 60 * 60 * 1000;

export function newSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Returns the raw bearer token, `null` when the header is absent, `""` when malformed. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header === null) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!m) return "";
  return m[1];
}

export interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string | null;
}

export type GitHubLookup =
  | { status: "ok"; user: GitHubUser }
  | { status: "invalid" }
  | { status: "unavailable"; detail: string };

/** GET https://api.github.com/user with the user's OAuth token. */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubLookup> {
  let res: Response;
  try {
    res = await fetch("https://api.github.com/user", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "codeburn-leaderboard",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (err) {
    return { status: "unavailable", detail: `fetch failed: ${(err as Error).message}` };
  }

  if (res.status === 401 || res.status === 403) return { status: "invalid" };
  if (!res.ok) return { status: "unavailable", detail: `GitHub responded ${res.status}` };

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { status: "unavailable", detail: "GitHub returned non-JSON body" };
  }
  if (
    typeof data !== "object" ||
    data === null ||
    typeof (data as { id?: unknown }).id !== "number" ||
    typeof (data as { login?: unknown }).login !== "string"
  ) {
    return { status: "unavailable", detail: "GitHub user payload malformed" };
  }
  const d = data as { id: number; login: string; avatar_url?: unknown };
  return {
    status: "ok",
    user: {
      id: d.id,
      login: d.login,
      avatar_url: typeof d.avatar_url === "string" ? d.avatar_url : null,
    },
  };
}
