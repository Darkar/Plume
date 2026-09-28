import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useT } from '../i18n';
import { Icon, type IconName } from './Icon';
import styles from './Composer.module.css';

export interface EditorHandle {
  getHtml(): string;
  focus(): void;
}

const COMMANDS: {
  command: string;
  key:
    | 'mail.compose.editor.bold'
    | 'mail.compose.editor.italic'
    | 'mail.compose.editor.underline'
    | 'mail.compose.editor.bullets'
    | 'mail.compose.editor.numbers';
  icon: IconName;
}[] = [
  { command: 'bold', key: 'mail.compose.editor.bold', icon: 'bold' },
  { command: 'italic', key: 'mail.compose.editor.italic', icon: 'italic' },
  { command: 'underline', key: 'mail.compose.editor.underline', icon: 'underline' },
  { command: 'insertUnorderedList', key: 'mail.compose.editor.bullets', icon: 'bullets' },
  { command: 'insertOrderedList', key: 'mail.compose.editor.numbers', icon: 'numbers' },
];

/**
 * Éditeur de texte enrichi minimal. Le HTML produit est nettoyé par le serveur avant envoi ;
 * le collage insère du texte brut uniquement.
 */
export const RichTextEditor = forwardRef<EditorHandle, { initialHtml: string; label: string }>(
  function RichTextEditor({ initialHtml, label }, ref) {
    const t = useT();
    const area = useRef<HTMLDivElement>(null);

    useEffect(() => {
      // Contenu initial : signature (nettoyée par le serveur) et citation (texte échappé).
      if (area.current) area.current.innerHTML = initialHtml;
    }, [initialHtml]);

    useImperativeHandle(ref, () => ({
      getHtml: () => area.current?.innerHTML ?? '',
      focus: () => area.current?.focus(),
    }));

    const run = (command: string, value?: string) => {
      area.current?.focus();
      document.execCommand(command, false, value);
    };

    const addLink = () => {
      const url = window.prompt(t('mail.compose.editor.linkPrompt'), 'https://');
      if (url && /^(https?:\/\/|mailto:)/i.test(url.trim())) run('createLink', url.trim());
    };

    return (
      <div className={styles.editor}>
        <div
          className={styles.editorToolbar}
          role="toolbar"
          aria-label={t('mail.compose.editor.toolbar')}
        >
          {COMMANDS.map((c) => (
            <button
              key={c.command}
              type="button"
              className={styles.tool}
              aria-label={t(c.key)}
              title={t(c.key)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => run(c.command)}
            >
              <Icon name={c.icon} size={16} />
            </button>
          ))}
          <button
            type="button"
            className={styles.tool}
            aria-label={t('mail.compose.editor.link')}
            title={t('mail.compose.editor.link')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={addLink}
          >
            <Icon name="link" size={16} />
          </button>
        </div>
        <div
          ref={area}
          className={styles.editable}
          contentEditable
          role="textbox"
          aria-multiline="true"
          aria-label={label}
          tabIndex={0}
          onPaste={(event) => {
            event.preventDefault();
            document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
          }}
          onDrop={(event) => event.preventDefault()}
          suppressContentEditableWarning
        />
      </div>
    );
  },
);
