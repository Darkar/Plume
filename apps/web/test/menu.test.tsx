import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Menu } from '../src/components/Menu';

afterEach(cleanup);

describe('menu d’actions', () => {
  it('s’ouvre, se parcourt au clavier, exécute l’action et rend le focus', async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const second = vi.fn();
    render(
      <Menu
        icon="more"
        label="Plus d’actions"
        items={[
          { label: 'Répondre à tous', onSelect: first },
          { label: 'Transférer', onSelect: second },
        ]}
      />,
    );
    const button = screen.getByRole('button', { name: 'Plus d’actions' });
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Répondre à tous' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Transférer' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Répondre à tous' }));
    await user.keyboard('{End}{Enter}');
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('se ferme avec Échap ou un clic à l’extérieur', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Menu icon="more" label="Actions" items={[{ label: 'Un', onSelect: () => undefined }]} />
        <p>Ailleurs</p>
      </>,
    );
    const button = screen.getByRole('button', { name: 'Actions' });
    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.click(button);
    await user.click(screen.getByText('Ailleurs'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
