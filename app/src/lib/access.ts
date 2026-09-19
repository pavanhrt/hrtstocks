import type { Viewer } from "./db/visibility.ts";

/**
 * Resolves the verified viewer for the current request. The default resolver
 * loads the server-side session (lib/auth.ts, Identity Platform token verified
 * with the Admin SDK); tests inject their own. Repositories call this -- they
 * never accept a role from callers or from the browser -- and it throws when
 * nobody is signed in, so an unauthenticated code path cannot read data.
 */
export class UnauthenticatedError extends Error {
  constructor() {
    super("Authentication required");
    this.name = "UnauthenticatedError";
  }
}

export type ViewerResolver = () => Promise<Viewer | null>;

let resolver: ViewerResolver | undefined;

export function setViewerResolverForTests(r: ViewerResolver | undefined) {
  resolver = r;
}

export async function currentViewer(): Promise<Viewer> {
  const resolve: ViewerResolver =
    resolver ??
    (async () => {
      const { getCurrentUser } = await import("./auth.ts");
      const user = await getCurrentUser();
      return user ? { userId: user.id, role: user.role } : null;
    });
  const viewer = await resolve();
  if (!viewer) throw new UnauthenticatedError();
  return viewer;
}
