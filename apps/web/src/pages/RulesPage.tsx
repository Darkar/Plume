import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import {
  applyRule,
  createRule,
  deleteRule,
  exportRules,
  fetchJob,
  fetchRules,
  importRules,
  reorderRules,
  rulesKey,
  updateRule,
  type RuleDefinition,
  type RulesResponse,
  type StoredRule,
} from '../api/rules';
import { useToast } from '../components/Toast';
import { Alert, Button } from '../components/ui';
import { useT } from '../i18n';
import { formatFullDate } from '../mail/format';
import { fetchMessage } from '../api/mail';
import { EMPTY_RULE, RuleEditor, ruleErrorMessages, ruleFromMessage } from '../rules/RuleEditor';
import styles from '../rules/Rules.module.css';

type Editing =
  { mode: 'new'; initial?: RuleDefinition } | { mode: 'edit'; rule: StoredRule } | null;

function definition(rule: StoredRule): RuleDefinition {
  const { name, enabled, match, conditions, actions, stop_processing } = rule;
  return { name, enabled, match, conditions, actions, stop_processing };
}

/** Suivi de l'application d'une règle aux messages existants (tâche de fond). */
function ApplyProgress({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const t = useT();
  const job = useQuery({
    queryKey: ['rule-job', jobId],
    queryFn: () => fetchJob(jobId),
    refetchInterval: (query) =>
      ['completed', 'failed'].includes(query.state.data?.state ?? '') ? false : 1500,
  });
  const state = job.data?.state;
  useEffect(() => {
    if (state === 'completed' || state === 'failed') onDone();
  }, [state, onDone]);
  const progress = job.data?.progress;
  return (
    <div role="status" className={styles.progress}>
      {state === 'completed'
        ? t('rules.apply.done', { count: job.data?.result?.matched ?? 0 })
        : state === 'failed'
          ? t('rules.apply.failed')
          : progress
            ? t('rules.apply.progress', { done: progress.done, total: progress.total })
            : t('rules.apply.queued')}
      {progress && state !== 'completed' ? (
        <progress value={progress.done} max={Math.max(progress.total, 1)} />
      ) : null}
    </div>
  );
}

export function RulesPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: rulesKey, queryFn: fetchRules });
  const [editing, setEditing] = useState<Editing>(null);
  const { depuis } = useSearch({ from: '/app/parametres/regles' });
  const navigate = useNavigate();
  const source = useQuery({
    queryKey: ['message', depuis],
    queryFn: () => fetchMessage(depuis as string),
    enabled: Boolean(depuis),
  });
  // Ouverture de l'éditeur pré-rempli, une seule fois par message de départ.
  const openedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (!depuis || !source.data || openedFrom.current === depuis) return;
    openedFrom.current = depuis;
    setEditing({
      mode: 'new',
      initial: ruleFromMessage(source.data, (sender) =>
        t('rules.editor.fromMessageName', { sender }),
      ),
    });
  }, [depuis, source.data, t]);
  /** Ferme l'éditeur et retire le message de départ de l'URL. */
  const closeEditor = () => {
    setEditing(null);
    if (depuis) void navigate({ to: '/parametres/regles', search: {}, replace: true });
  };
  const [jobs, setJobs] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: rulesKey });

  const save = useMutation({
    mutationFn: (rule: RuleDefinition) =>
      editing?.mode === 'edit' ? updateRule(editing.rule.id, rule) : createRule(rule),
    onSuccess: () => {
      closeEditor();
      toast(t('rules.list.saved'));
      void refresh();
    },
  });
  const duplicate = useMutation({
    mutationFn: (rule: StoredRule) => {
      const suffix = ` ${t('rules.list.copySuffix')}`;
      return createRule({
        ...definition(rule),
        name: rule.name.slice(0, 100 - suffix.length) + suffix,
      });
    },
    onSuccess: () => {
      toast(t('rules.list.duplicated'));
      void refresh();
    },
    onError: (error) => toast(ruleErrorMessages(error, t).join(' ')),
  });
  // Référence synchrone : dragover et drop peuvent suivre dragstart avant tout nouveau rendu.
  const dragged = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);
  const toggle = useMutation({
    mutationFn: (rule: StoredRule) => updateRule(rule.id, { enabled: !rule.enabled }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: deleteRule,
    onSuccess: () => {
      toast(t('rules.list.deleted'));
      void refresh();
    },
  });
  const reorder = useMutation({
    mutationFn: reorderRules,
    // La réponse ne contient que les règles : les limites déjà connues sont conservées.
    onSuccess: (data) =>
      queryClient.setQueryData<RulesResponse>(rulesKey, (old) =>
        old ? { ...old, rules: data.rules } : old,
      ),
    onError: () => void refresh(),
  });
  const apply = useMutation({
    mutationFn: (rule: StoredRule) => applyRule(rule.id).then((r) => ({ ...r, ruleId: rule.id })),
    onSuccess: ({ jobId, ruleId }) => setJobs((j) => ({ ...j, [ruleId]: jobId })),
    onError: () => toast(t('common.error.generic')),
  });
  const importFile = useMutation({
    mutationFn: async (file: File) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error('invalid_json');
      }
      return importRules(parsed, 'append');
    },
    onSuccess: (data) => {
      toast(t('rules.import.done', { count: data.imported }));
      void refresh();
    },
  });

  const onExport = async () => {
    const data = await exportRules();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'plume-regles.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  const onImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) importFile.mutate(file);
  };

  /** Déplace la règle `from` à la position `to` (glisser-déposer ou boutons ↑ / ↓). */
  const moveTo = (from: number, to: number) => {
    const list = rules.data?.rules ?? [];
    if (from === to || to < 0 || to >= list.length || !rules.data) return;
    const ids = list.map((r) => r.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved as string);
    // Affichage immédiat, confirmé ou corrigé par la réponse du serveur.
    queryClient.setQueryData(rulesKey, {
      ...rules.data,
      rules: ids.map((id) => list.find((r) => r.id === id) as StoredRule),
    });
    reorder.mutate(ids);
  };
  const move = (index: number, delta: number) => moveTo(index, index + delta);

  if (!rules.data) return <p>{t('app.status.loading')}</p>;
  const { limits } = rules.data;

  if (editing) {
    return (
      <RuleEditor
        initial={
          editing.mode === 'edit' ? definition(editing.rule) : (editing.initial ?? EMPTY_RULE)
        }
        onSave={(rule) => save.mutate(rule)}
        onCancel={() => {
          save.reset();
          closeEditor();
        }}
        saving={save.isPending}
        saveError={save.error}
        allowedHeaders={rules.data.limits.allowedHeaders ?? []}
      />
    );
  }

  return (
    <>
      <h1>{t('rules.list.title')}</h1>
      <p className={styles.help}>{t('rules.list.help')}</p>
      {!limits.enabled ? <Alert tone="info">{t('rules.error.disabled')}</Alert> : null}
      {importFile.isError ? (
        <Alert>
          {importFile.error instanceof Error && importFile.error.message === 'invalid_json'
            ? t('rules.import.invalidJson')
            : ruleErrorMessages(importFile.error, t).join(' ')}
        </Alert>
      ) : null}
      <div className={styles.buttons}>
        <Button
          onClick={() => setEditing({ mode: 'new' })}
          disabled={!limits.enabled || rules.data.rules.length >= limits.maxRules}
        >
          {t('rules.list.new')}
        </Button>
        <Button variant="secondary" onClick={() => void onExport()}>
          {t('rules.list.export')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => fileInput.current?.click()}
          disabled={!limits.enabled}
        >
          {t('rules.import.button')}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onChange={onImport}
        />
      </div>
      {rules.data.rules.length === 0 ? (
        <p className={styles.help}>{t('rules.list.empty')}</p>
      ) : null}
      <ol className={styles.list}>
        {rules.data.rules.map((rule, index) => (
          <li
            key={rule.id}
            className={styles.card}
            data-disabled={!rule.enabled || undefined}
            data-drop-target={dropTarget === index && dragged.current !== index ? true : undefined}
            draggable
            onDragStart={(e) => {
              dragged.current = index;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', rule.id);
            }}
            onDragOver={(e) => {
              if (dragged.current === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropTarget(index);
            }}
            onDragLeave={() => setDropTarget((current) => (current === index ? null : current))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragged.current !== null) moveTo(dragged.current, index);
              dragged.current = null;
              setDropTarget(null);
            }}
            onDragEnd={() => {
              dragged.current = null;
              setDropTarget(null);
            }}
          >
            <div className={styles.cardHeader}>
              <span
                className={styles.handle}
                title={t('rules.list.dragHandle', { name: rule.name })}
                aria-hidden="true"
              >
                ⠿
              </span>
              <h2>{rule.name}</h2>
              <label className={styles.switch}>
                <input
                  type="checkbox"
                  role="switch"
                  checked={rule.enabled}
                  onChange={() => toggle.mutate(rule)}
                  aria-label={t('rules.list.toggle', { name: rule.name })}
                />
              </label>
            </div>
            <p className={styles.stats}>
              {t('rules.list.stats', { count: rule.stats.processedCount })}
              {rule.stats.lastRunAt
                ? ` — ${t('rules.list.lastRun', { date: formatFullDate(rule.stats.lastRunAt) })}`
                : ''}
              {rule.stats.errorCount > 0
                ? ` — ${t('rules.list.errors', { count: rule.stats.errorCount })}`
                : ''}
            </p>
            {jobs[rule.id] ? (
              <ApplyProgress jobId={jobs[rule.id] as string} onDone={() => void refresh()} />
            ) : null}
            <div className={styles.buttons}>
              <Button variant="secondary" onClick={() => setEditing({ mode: 'edit', rule })}>
                {t('rules.list.edit')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => duplicate.mutate(rule)}
                disabled={!limits.enabled || rules.data.rules.length >= limits.maxRules}
              >
                {t('rules.list.duplicate')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => apply.mutate(rule)}
                disabled={!limits.enabled}
              >
                {t('rules.apply.button')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => move(index, -1)}
                disabled={index === 0}
                aria-label={t('rules.list.moveUp', { name: rule.name })}
              >
                ↑
              </Button>
              <Button
                variant="secondary"
                onClick={() => move(index, 1)}
                disabled={index === rules.data.rules.length - 1}
                aria-label={t('rules.list.moveDown', { name: rule.name })}
              >
                ↓
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (window.confirm(t('rules.list.confirmDelete', { name: rule.name })))
                    remove.mutate(rule.id);
                }}
              >
                {t('rules.list.delete')}
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
