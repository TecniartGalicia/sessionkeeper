import * as vscode from 'vscode';

/**
 * Vista de sesiones. En F0 está vacía a propósito: el descubrimiento real llega en F1,
 * y hasta entonces la extensión no lee nada del disco del usuario.
 */
export class SessionsProvider implements vscode.TreeDataProvider<SessionNode> {
  private readonly changed = new vscode.EventEmitter<SessionNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: SessionNode): vscode.TreeItem {
    return node.item;
  }

  getChildren(): SessionNode[] {
    return [];
  }
}

export interface SessionNode {
  readonly item: vscode.TreeItem;
}
