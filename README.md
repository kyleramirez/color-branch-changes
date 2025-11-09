# Color Branch Changes: A merge-base–aware diff
The built-in Git extension decorates files in the VS Code Explorer using icons and colors that reflect the **working directory** state—such as added (`A`), modified (`M`), deleted (`D`), and untracked files. These decorations only show how the working tree differs from **HEAD**.

This extension extends that idea by adding decorations to show how the **current branch** differs from its **parent (or configured) base branch**.

This enables you to see, directly in the Explorer:
* which files your branch has **added**
* which files your branch has **modified**
* and the size or scope of the work your branch introduces.

Equivalent to:
```
git diff --name-status base-branch...HEAD
```
Files with committed changes on the current branch are decorated using markers such as `A^` and `M^` to distinguish them from normal working-tree decorations. This helps monitor branch drift and gives immediate feedback on the size of an upcoming merge or pull request.

## Configuration
### `colorBranchChanges.mergeBase` (string)
Specifies the base (parent) branch to compare against.
Leave blank to auto-detect the upstream tracking branch.
```json
{
  "colorBranchChanges.mergeBase": "another-branch"
}
```

### `colorBranchChanges.includeUntracked` (boolean)
If `true`, untracked files that exist only on the current branch are also highlighted. Defaults to `true`.
```json
{
  "colorBranchChanges.includeUntracked": true
}
```

## Recommended colors for User Settings (JSON)
All colors are exposed as theme keys so you can override them in `settings.json`. By default, they inherit from VS Code's built-in Git decoration colors. The below color scheme is recommended for **funsies** and is totally optional.
```json
{
  "workbench.colorCustomizations": {
    "gitDecoration.untrackedResourceForeground": "#a3f5b5aa",
    "gitDecoration.modifiedResourceForeground": "#a3f5f2aa",
    "gitDecoration.addedResourceForeground": "#a3f5b5",
    "gitDecoration.stageModifiedResourceForeground": "#a3f5f2"
  }
}
```
To override this extension's colors specifically, use:
- `"colorBranchChanges.modifiedResourceForeground"`
- `"colorBranchChanges.addedResourceForeground"`
- `"colorBranchChanges.unknownForeground"`

## Note
- If no upstream branch is set and no base branch is configured, the extension falls back to `main`.
