import * as vscode from 'vscode';
import { l10n, ThemeColor, ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'vscode';
import type { DiscoveredSession } from '../core/discover';
import { formatBytes } from '../core/status';
import type { Keeper, SessionView } from '../service/keeper';

export type Node = ProjectNode | SessionNode;

export interface ProjectNode {
  readonly kind: 'project';
  readonly label: string;
  readonly children: SessionView[];
}

export interface SessionNode {
  readonly kind: 'session';
  readonly view: SessionView;
}

const STATE_ICON: Record<string, { icon: string; color?: string; label: string }> = {
  new: { icon: 'circle-outline', color: 'charts.yellow', label: l10n.t('not backed up') },
  pending: { icon: 'cloud-upload', color: 'charts.blue', label: l10n.t('changed since last backup') },
  'backed-up': { icon: 'shield', color: 'charts.green', label: l10n.t('backed up') },
  orphan: { icon: 'archive', color: 'charts.orange', label: l10n.t('only in the vault') },
};

export class SessionsProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  private views: SessionView[] = [];
  private warnings: string[] = [];

  constructor(private readonly keeper: () => Keeper) {}

  refresh(): void {
    const found = this.keeper().discover();
    this.views = found.views;
    this.warnings = found.warnings;
    void vscode.commands.executeCommand('setContext', 'sessionkeeper.hasSessions', this.views.length > 0);
    this.changed.fire(undefined);
  }

  get all(): readonly SessionView[] {
    return this.views;
  }

  get problems(): readonly string[] {
    return this.warnings;
  }

  sessionsNeedingBackup(): DiscoveredSession[] {
    return this.views.filter((v) => v.status.state !== 'backed-up' && v.status.state !== 'orphan').map((v) => v.session);
  }

  getTreeItem(node: Node): TreeItem {
    if (node.kind === 'project') {
      const item = new TreeItem(node.label, TreeItemCollapsibleState.Expanded);
      const pending = node.children.filter((c) => c.status.state !== 'backed-up').length;
      item.description = pending
        ? l10n.t('{0} sessions · {1} to back up', node.children.length, pending)
        : l10n.t('{0} sessions', node.children.length);
      item.iconPath = new ThemeIcon('folder');
      item.contextValue = 'sk.project';
      return item;
    }

    const { session, status } = node.view;
    const meta = STATE_ICON[status.state] ?? STATE_ICON.new;
    const item = new TreeItem(shortTitle(session), TreeItemCollapsibleState.None);
    item.description = `${new Date(session.lastModified).toLocaleDateString()} · ${formatBytes(session.totalBytes)}`;
    item.iconPath = new ThemeIcon(meta.icon, meta.color ? new ThemeColor(meta.color) : undefined);
    item.contextValue = `sk.session.${status.state}`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${session.sessionId}**`,
        '',
        `- ${l10n.t('State')}: ${meta.label}`,
        `- ${l10n.t('Parts')}: ${session.parts.length}`,
        `- ${l10n.t('Size')}: ${formatBytes(session.totalBytes)}`,
        status.pendingBytes
          ? `- ${l10n.t('Pending')}: ${formatBytes(status.pendingBytes)}`
          : `- ${l10n.t('Last backup')}: ${status.lastBackupAt ?? '—'}`,
        status.generations > 1 ? `- ${l10n.t('Versions')}: ${status.generations}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const byProject = new Map<string, SessionView[]>();
      for (const view of this.views) {
        const key = `${view.session.provider}/${view.session.projectSlug}`;
        byProject.set(key, [...(byProject.get(key) ?? []), view]);
      }
      return [...byProject.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([label, children]) => ({ kind: 'project', label: prettyProject(label), children }));
    }
    if (node.kind === 'project') {
      return node.children.map((view) => ({ kind: 'session', view }));
    }
    return [];
  }
}

function prettyProject(key: string): string {
  const [provider, slug] = key.split('/');
  const name = slug.replace(/^[A-Za-z]--/, '').replace(/-/g, '/');
  return `${provider === 'codex' ? 'Codex' : 'Claude Code'} · ${name}`;
}

function shortTitle(session: DiscoveredSession): string {
  return session.sessionId.slice(0, 8);
}
