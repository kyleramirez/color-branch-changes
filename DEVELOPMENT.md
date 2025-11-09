# install dependencies

    pnpm i

# compile once

    pnpm compile

# editor install
## temporary local-only install
Use this to make changes to the extension and have it load in the editor after ">Developer: Reload Window"

    pnpm watch

Launch an editor.

    pnpm host:code ./Directory/To/Project
    pnpm host:cursor ./Directory/To/Project

## persisted local-only install
First authenticate vsce with:
  - a personal access token from an Azure DevOps account
  - a publisher ID from marketplace.visualstudio.com

    npx vsce login <publisher-id>

Build package package-name-#.#.#.vsix

    pnpm package
    code --install-extension package-name-#.#.#.vsix

# publish to marketplace

    npx vsce publish <major|minor|patch>
