import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { fetchSession, sessionKey, type SessionInfo, type SessionStatus } from './auth/api';
import { destinationFor } from './auth/routing';
import { AppShell } from './components/AppShell';
import { AddAccountPage } from './pages/AddAccountPage';
import { EnrollPage } from './pages/EnrollPage';
import { MailPage, type MailSearch } from './pages/MailPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { GeneralSettingsPage } from './pages/GeneralSettingsPage';
import { RulesPage } from './pages/RulesPage';
import { SecuritySettingsPage } from './pages/SecuritySettingsPage';
import { SettingsLayout } from './pages/SettingsLayout';
import { TotpPage } from './pages/TotpPage';

interface RouterContext {
  queryClient: QueryClient;
}

async function currentSession(queryClient: QueryClient): Promise<SessionInfo | null> {
  return queryClient.fetchQuery({ queryKey: sessionKey, queryFn: fetchSession, staleTime: 30_000 });
}

/** Garde de route : exige une session à l'un des états donnés, sinon redirige. */
function guard(allowed: SessionStatus[]) {
  return async ({ context }: { context: RouterContext }) => {
    const session = await currentSession(context.queryClient);
    if (!session) throw redirect({ to: '/connexion' });
    if (!allowed.includes(session.status)) throw redirect({ to: destinationFor(session.status) });
  };
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  notFoundComponent: NotFoundPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connexion',
  beforeLoad: async ({ context }) => {
    const session = await currentSession(context.queryClient);
    if (session) throw redirect({ to: destinationFor(session.status) });
  },
  component: LoginPage,
});

const totpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connexion/verification',
  beforeLoad: guard(['totp_required']),
  component: TotpPage,
});

const enrollRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/securite/activation',
  beforeLoad: guard(['totp_enrollment_required']),
  component: EnrollPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: guard(['ok']),
  component: AppShell,
});

const FILTERS = ['all', 'unseen', 'flagged', 'attachments'] as const;

/** Paramètres d'URL de la messagerie, validés (toute valeur inattendue est ignorée). */
export function validateMailSearch(search: Record<string, unknown>): MailSearch {
  const result: MailSearch = {};
  if (
    typeof search.folder === 'string' &&
    search.folder.length > 0 &&
    search.folder.length <= 500
  ) {
    result.folder = search.folder;
  }
  const filter = FILTERS.find((f) => f === search.filter);
  if (filter) result.filter = filter;
  if (typeof search.q === 'string' && search.q) result.q = search.q.slice(0, 200);
  if (typeof search.label === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}$/.test(search.label)) {
    result.label = search.label;
  }
  if (typeof search.m === 'string' && /^[A-Za-z0-9_-]{1,1500}$/.test(search.m)) result.m = search.m;
  return result;
}

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  validateSearch: validateMailSearch,
  component: MailPage,
});

const addAccountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/comptes/ajouter',
  component: AddAccountPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/parametres',
  component: SettingsLayout,
});

const generalSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  component: GeneralSettingsPage,
});

const rulesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/regles',
  // « Créer une règle à partir de ce message » : identifiant opaque du message de départ.
  validateSearch: (search: Record<string, unknown>): { depuis?: string } =>
    typeof search.depuis === 'string' && /^[A-Za-z0-9_-]{1,1500}$/.test(search.depuis)
      ? { depuis: search.depuis }
      : {},
  component: RulesPage,
});

const securityRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/securite',
  component: SecuritySettingsPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  totpRoute,
  enrollRoute,
  appRoute.addChildren([
    homeRoute,
    addAccountRoute,
    settingsRoute.addChildren([generalSettingsRoute, rulesRoute, securityRoute]),
  ]),
]);

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: false });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
