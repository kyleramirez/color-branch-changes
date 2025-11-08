import vscode from 'vscode';
import path from 'path';
import type { GitExtension, API } from './git.d';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

type FileState = 'branch-added' | 'branch-modified';

interface RepoInfo {
  root: vscode.Uri;
  changed: Map<string, FileState>;
  foldersWithChanges: Set<string>;
}

export async function activate(ctx: vscode.ExtensionContext) {
  // Initialize Git extension
  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtension) {
    return;
  }

  const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  const api = git.getAPI(1);

  // Ensure we have a workspace
  const projectRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!projectRoot) {
    return;
  }

  // Get or wait for repository initialization
  const repo = await getOrWaitForRepository(api, projectRoot);
  if (!repo) {
    return;
  }

  const repos = [repo];
  const state = new Map<string, RepoInfo>();
  const onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();

  // File decoration provider
  const provider: vscode.FileDecorationProvider = {
    onDidChangeFileDecorations: onDidChange.event,
    async provideFileDecoration(uri) {
      const repoInfo = Array.from(state.values()).find((r) => uri.fsPath.startsWith(r.root.fsPath));
      if (!repoInfo) {
        return undefined;
      }

      // Decorate individual files
      const fileState = repoInfo.changed.get(uri.fsPath);
      if (fileState) {
        return decorationForKind(fileState);
      }

      // Decorate folders containing changes
      if ((await isDirUri(uri)) && repoInfo.foldersWithChanges.has(uri.fsPath)) {
        const decoration = decorationForKind('branch-modified');
        decoration.propagate = true;
        return decoration;
      }

      return undefined;
    },
  };

  ctx.subscriptions.push(vscode.window.registerFileDecorationProvider(provider), onDidChange);

  // Register commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('colorBranchChanges.refresh', async () => {
      await refreshAll();
      onDidChange.fire(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []);
    })
  );

  // Initial refresh and setup listeners
  await refreshAll();
  setupGitListeners(api, refreshAll, onDidChange);

  // Recompute on config change
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('colorBranchChanges')) {
      refreshAll().then(() => onDidChange.fire(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []));
    }
  });

  async function refreshAll() {
    const config = vscode.workspace.getConfiguration('colorBranchChanges');
    const baseBranch = config.get<string>('baseBranch', '');
    const includeUntracked = config.get<boolean>('includeUntracked', true);

    for (const repo of repos) {
      const repoUri = repo.rootUri;
      const repoPath = repoUri.fsPath;

      // Auto-detect parent branch if not specified
      const effectiveBaseBranch = baseBranch || (await detectBaseBranch(repoUri));

      // Get changed files and compute folder hierarchy
      const changedFiles = await computeChangedFiles(repoUri, effectiveBaseBranch, includeUntracked);
      const foldersWithChanges = computeFoldersWithChanges(changedFiles, repoPath);

      state.set(repoPath, {
        root: repoUri,
        changed: changedFiles,
        foldersWithChanges,
      });
    }
  }

  function computeFoldersWithChanges(changedFiles: Map<string, FileState>, repoPath: string): Set<string> {
    const folders = new Set<string>();

    for (const filePath of changedFiles.keys()) {
      let currentDir = path.dirname(filePath);

      // Walk up the directory tree to the repo root
      while (currentDir && currentDir !== path.dirname(currentDir) && currentDir.length >= repoPath.length) {
        folders.add(currentDir);
        currentDir = path.dirname(currentDir);
      }
    }

    return folders;
  }
}

export function deactivate() {}

async function getOrWaitForRepository(api: API, projectRoot: vscode.Uri) {
  // Check if repository is already available
  const existingRepo = api.getRepository(projectRoot);
  if (existingRepo) {
    return existingRepo;
  }

  // Wait for repository to be discovered (Git might still be initializing)
  return new Promise<ReturnType<typeof api.getRepository>>((resolve) => {
    const disposable = api.onDidOpenRepository((openedRepo) => {
      if (openedRepo.rootUri.fsPath === projectRoot.fsPath) {
        disposable.dispose();
        resolve(openedRepo);
      }
    });

    // Fallback check in case repository was discovered during event registration
    setTimeout(() => {
      const foundRepo = api.getRepository(projectRoot);
      if (foundRepo) {
        disposable.dispose();
        resolve(foundRepo);
      }
    }, 200);
  });
}

async function isDirUri(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

function decorationForKind(state: FileState): vscode.FileDecoration {
  switch (state) {
    case 'branch-modified':
      return new vscode.FileDecoration(
        'M^',
        'Modified on current branch',
        new vscode.ThemeColor('colorBranchChanges.modifiedResourceForeground')
      );
    case 'branch-added':
      return new vscode.FileDecoration(
        'A^',
        'Added on current branch',
        new vscode.ThemeColor('colorBranchChanges.addedResourceForeground')
      );
  }
}

async function detectBaseBranch(root: vscode.Uri): Promise<string> {
  const repoPath = root.fsPath;
  let dec: string;
  try {
    dec = (await runGit(['log', '--pretty=format:%D', 'HEAD^'], repoPath)).trim();
  } catch {
    return 'main';
  }
  const match = dec
    .split(',')
    .map((s) => s.trim())
    .find((s) => s.startsWith('origin/'));
  if (!match) return 'main';
  return match.replace(/^origin\//, '');
}

async function computeChangedFiles(
  root: vscode.Uri,
  baseBranch: string,
  _includeUntracked: boolean
): Promise<Map<string, FileState>> {
  const repoPath = root.fsPath;
  const branchChanges = new Map<string, 'A' | 'M' | 'D' | 'R'>();
  const diffOutput = await runGit(['diff', '--name-status', `${baseBranch}..HEAD`], repoPath);

  for (const line of diffOutput.split('\n')) {
    if (!line.trim()) continue;

    const parts = line.split('\t');
    const status = parts[0];

    if (status.startsWith('R')) {
      // Renamed file: use the new path (parts[2])
      const newPath = parts[2];
      branchChanges.set(path.join(repoPath, newPath), 'R');
    } else {
      // Added, Modified, or Deleted file
      const gitStatus = status as 'A' | 'M' | 'D';
      const relativePath = parts[1];
      branchChanges.set(path.join(repoPath, relativePath), gitStatus);
    }
  }

  // Get working directory status (staged and unstaged changes)
  const statusOutput = await runGit(['status', '--porcelain'], repoPath);
  const workingDirStatus = new Map<string, { staged: string; unstaged: string }>();

  for (const line of statusOutput.split('\n')) {
    if (!line || line.length < 4) continue;

    const staged = line[0]; // Index (staged) status
    const unstaged = line[1]; // Working tree (unstaged) status
    const relativePath = line.substring(3);
    const absolutePath = path.join(repoPath, relativePath);

    workingDirStatus.set(absolutePath, { staged, unstaged });
  }

  // Combine branch changes with working directory status
  const result = new Map<string, FileState>();

  for (const [filePath, branchStatus] of branchChanges.entries()) {
    const wdStatus = workingDirStatus.get(filePath);

    // Skip files that have working directory changes (staged or unstaged modifications)
    const hasWorkingDirChanges = wdStatus?.staged === 'M' || wdStatus?.staged === 'A' || wdStatus?.unstaged === 'M';

    if (hasWorkingDirChanges) {
      continue;
    }

    // Decorate files based on branch status
    if (branchStatus === 'A') {
      result.set(filePath, 'branch-added');
    } else if (branchStatus === 'M' || branchStatus === 'R') {
      result.set(filePath, 'branch-modified');
    }
    // Note: Deleted files (D) are intentionally not decorated
  }

  return result;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function setupGitListeners(
  api: API,
  refreshAll: () => Promise<void>,
  emitter: vscode.EventEmitter<vscode.Uri | vscode.Uri[]>
) {
  const triggerRefresh = async () => {
    await refreshAll();
    emitter.fire(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []);
  };

  // Listen for repository changes
  api.onDidOpenRepository(triggerRefresh);
  api.onDidCloseRepository(triggerRefresh);

  // Listen for changes in existing repositories
  for (const repo of api.repositories) {
    repo.state.onDidChange(triggerRefresh);
    repo.ui.onDidChange(triggerRefresh);
  }
}
