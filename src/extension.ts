import {
  Uri,
  ExtensionContext,
  window as VSCodeWindow,
  extensions as VSCodeExtensions,
  workspace as VSCodeWorkspace,
  EventEmitter,
  FileDecorationProvider,
  commands as VSCodeCommands,
  FileType,
  FileDecoration,
  ThemeColor,
  Disposable,
} from 'vscode';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GitExtension, API, Repository } from './git.d';
import log from './utils/logger';

type FileState = 'branch-added' | 'branch-modified';
type DirectoryState = 'branch-added' | 'branch-modified';
interface RepoInfo {
  root: Uri;
  changedFiles: Map<string, FileState>;
  changedDirectories: Map<string, DirectoryState>;
}

export async function activate(extensionContext: ExtensionContext) {
  log(extensionContext);
  const gitExtensionBase = VSCodeExtensions.getExtension<GitExtension>('vscode.git');
  if (!gitExtensionBase) {
    log('extension vscode.git not available');
    return;
  }
  let gitExtensionEnabled = false;
  let gitAPIInitialized = false;
  let gitAPIStatusChanges: Disposable | undefined;
  const gitExtension = gitExtensionBase.exports;
  const gitExtensionEnablementChanges = gitExtension.onDidChangeEnablement(handleGitExtensionEnablementChange);
  const fsPathRepoInfoMapping = new Map<string, RepoInfo>();
  const onDidChange = new EventEmitter<Uri | Uri[]>();
  const provider: FileDecorationProvider = {
    onDidChangeFileDecorations: onDidChange.event,
    async provideFileDecoration(uri) {
      const repoInfos = Array.from(fsPathRepoInfoMapping.values());
      const fileRepoInfo = repoInfos.find((repoInfo) => uri.fsPath.startsWith(repoInfo.root.fsPath));
      if (!fileRepoInfo) {
        return undefined;
      }
      const changedFileState = fileRepoInfo.changedFiles.get(uri.fsPath);
      if (changedFileState) {
        return decorationForKind(changedFileState);
      }

      if ((await isDirUri(uri)) && fileRepoInfo.changedDirectories.has(uri.fsPath)) {
        const directoryState = fileRepoInfo.changedDirectories.get(uri.fsPath);
        if (directoryState) {
          const decoration = decorationForKind(directoryState);
          decoration.propagate = true;
          return decoration;
        }
      }
      return undefined;
    },
  };
  function next() {
    if (gitExtensionEnabled) {
      const gitAPI = gitExtension.getAPI(1);
      if (!gitAPIStatusChanges) {
        gitAPIStatusChanges = gitAPI.onDidChangeState(handleGitAPIStatusChange);
        extensionContext.subscriptions.push(gitAPIStatusChanges);
        handleGitAPIStatusChange(gitAPI.state);
      }
      if (gitAPIInitialized) {
        const repositoryStateChanges = new WeakMap<Repository, Disposable>();
        function handleRepositoryOpened(repository: Repository) {
          const disposable = repository.state.onDidChange(() => decorate(repository));
          repositoryStateChanges.set(repository, disposable);
          extensionContext.subscriptions.push(disposable);
          decorate(repository);
          // TODO: handle repository.ui.onDidChange
          // TODO: handle config changes
          // extensionContext.subscriptions.push(VSCodeWorkspace.onDidChangeConfiguration(async (event) => {
          //   if (event.affectsConfiguration('colorBranchChanges')) {
          //     await decorate(repository);
          //     onDidChange.fire(VSCodeWorkspace.workspaceFolders?.map((workspaceFolder) => workspaceFolder.uri) ?? [])
          //   }
          // }));
          // TODO: Register commands
          // extensionContext.subscriptions.push(
          //   VSCodeCommands.registerCommand('colorBranchChanges.refresh', async () => {
          //     decorate(repository);
          //     onDidChange.fire(VSCodeWorkspace.workspaceFolders?.map((f) => f.uri) ?? []);
          //   })
          // );
        }
        function handleRepositoryClosed(repository: Repository) {
          const disposable = repositoryStateChanges.get(repository);
          if (disposable) {
            disposable.dispose();
            repositoryStateChanges.delete(repository);
          }
        }
        extensionContext.subscriptions.push(gitAPI.onDidOpenRepository(handleRepositoryOpened));
        extensionContext.subscriptions.push(gitAPI.onDidCloseRepository(handleRepositoryClosed));
        gitAPI.repositories.forEach(handleRepositoryOpened);
        return;
      }
      return;
    }
    log('Shutting down');
    gitAPIStatusChanges?.dispose();
    gitAPIStatusChanges = undefined;
    gitAPIInitialized = false;
  }
  function handleGitAPIStatusChange(state: API['state']) {
    gitAPIInitialized = state === 'initialized';
    next();
  }
  function handleGitExtensionEnablementChange(enabled: boolean) {
    gitExtensionEnabled = enabled;
    next();
  }
  // TODO: Debounce by repository
  async function decorate(repository: Repository) {
    const config = VSCodeWorkspace.getConfiguration('colorBranchChanges');
    const mergeBaseConfig = config.get<string>('mergeBase', '');
    const includeUntracked = config.get<boolean>('includeUntracked', true);

    const {
      rootUri: { fsPath },
      rootUri: root,
      state: { HEAD: headState },
    } = repository;
    const HEAD = headState?.name;
    if (!HEAD) {
      log('could not find HEAD');
      return;
    }
    const mergeBase = mergeBaseConfig || (await repository.getBranchBase(HEAD))?.name;
    if (!mergeBase) {
      log('could not find merge base');
      return;
    }
    log(`HEAD: ${HEAD}, mergeBase: ${mergeBase}`);
    const changedFiles = await getChangedFiles(root, mergeBase, includeUntracked);
    const changedDirectories = getChangedDirectories(changedFiles, fsPath);
    fsPathRepoInfoMapping.set(fsPath, { root, changedFiles, changedDirectories });
  }
  handleGitExtensionEnablementChange(gitExtension.enabled);
  extensionContext.subscriptions.push(gitExtensionEnablementChanges);
  extensionContext.subscriptions.push(VSCodeWindow.registerFileDecorationProvider(provider), onDidChange);
}

function getChangedDirectories<T extends Map<string, FileState>>(
  changedFiles: T,
  repoPath: string
): Map<string, DirectoryState> {
  const directories = new Map<string, DirectoryState>();
  for (const fsPath of changedFiles.keys()) {
    let currentDirectory = path.dirname(fsPath);
    const fileState = changedFiles.get(fsPath);
    while (
      fileState &&
      currentDirectory &&
      currentDirectory !== path.dirname(currentDirectory) &&
      currentDirectory.length >= repoPath.length
    ) {
      directories.set(currentDirectory, fileState);
      currentDirectory = path.dirname(currentDirectory);
    }
  }
  return directories;
}

export function deactivate() {}

async function isDirUri(uri: Uri): Promise<boolean> {
  try {
    const stat = await VSCodeWorkspace.fs.stat(uri);
    return stat.type === FileType.Directory;
  } catch {
    return false;
  }
}

function decorationForKind(state: FileState): FileDecoration {
  switch (state) {
    case 'branch-modified':
      return new FileDecoration(
        'M^',
        'Modified on current branch',
        new ThemeColor('colorBranchChanges.modifiedResourceForeground')
      );
    case 'branch-added':
      return new FileDecoration(
        'A^',
        'Added on current branch',
        new ThemeColor('colorBranchChanges.addedResourceForeground')
      );
  }
}

async function getChangedFiles(
  root: Uri,
  mergeBase: string,
  _includeUntracked: boolean
): Promise<Map<string, FileState>> {
  // TODO: get away from native git commands and use the methods in https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/api1.ts
  const repoPath = root.fsPath;
  const branchChanges = new Map<string, 'A' | 'M' | 'D' | 'R'>();
  const diffOutput = await runGit(['diff', '--name-status', `${mergeBase}..HEAD`], repoPath);

  for (const line of diffOutput.split('\n')) {
    if (!line.trim()) continue;

    const parts = line.split('\t');
    const status = parts[0];

    if (status.startsWith('R')) {
      const newPath = parts[2];
      branchChanges.set(path.join(repoPath, newPath), 'R');
    } else {
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
    const hasWorkingDirChanges = wdStatus?.staged === 'M' || wdStatus?.staged === 'A' || wdStatus?.unstaged === 'M';

    if (hasWorkingDirChanges) {
      continue;
    }
    if (branchStatus === 'A') {
      result.set(filePath, 'branch-added');
    } else if (branchStatus === 'M' || branchStatus === 'R') {
      result.set(filePath, 'branch-modified');
    }
  }

  return result;
}

const execFileAsync = promisify(execFile);
async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}
