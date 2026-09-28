/**
 * Recharge l'application sur la boîte de réception : après un changement de compte, aucun état
 * (cache, flux temps réel, apparence) du compte précédent ne subsiste.
 */
export function reloadApp(): void {
  window.location.assign('/');
}
