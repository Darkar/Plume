import { matchAccount, matchDomain } from '@plume/config';
import type { Services } from '../context.js';

/**
 * Suspend les comptes dont le domaine n'est plus dans la liste blanche, ou qui ne figurent plus
 * dans la liste des comptes autorisés de leur domaine, et révoque leurs sessions.
 * Appelé au démarrage et après chaque rechargement de la configuration.
 */
export async function enforceWhitelist(
  services: Services,
): Promise<{ domain: string; accounts: number }[]> {
  const removed: { domain: string; accounts: number }[] = [];
  const domains = services.config().domains;
  for (const domain of await services.users.activeDomains()) {
    const entry = matchDomain(domains, domain);
    let userIds: string[];
    let reason: 'domain_removed' | 'account_not_allowed';
    if (!entry) {
      reason = 'domain_removed';
      userIds = await services.users.suspendDomain(domain);
    } else if (entry.accounts) {
      reason = 'account_not_allowed';
      const accounts = await services.users.activeAccounts(domain);
      userIds = await services.users.suspendUsers(
        accounts.filter((a) => !matchAccount(domains, a.email)).map((a) => a.id),
      );
    } else {
      continue;
    }
    if (userIds.length === 0) continue;
    for (const userId of userIds) {
      await services.sessions.destroyAllForUser(userId);
      await services.audit.record({
        event: 'account_suspended',
        userId,
        metadata: { reason, domain },
      });
    }
    services.logger.warn(
      { domain, accounts: userIds.length, reason },
      reason === 'domain_removed'
        ? 'domaine retiré : comptes suspendus'
        : 'comptes retirés de la liste autorisée : comptes suspendus',
    );
    removed.push({ domain, accounts: userIds.length });
  }
  return removed;
}
