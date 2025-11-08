# install dependencies

    pnpm i

# compile once

    pnpm compile

# VSCode / Cursor install

# temporary local
Use this to make changes to the extension and have it load in the editor after ">Developer: Reload Window"

    pnpm start

Then launch the editor of your choice

    code --extensionDevelopmentPath="$PWD" ./Directory/To/Project

# persistent local
First authenticate vsce with a:
  - personal access token from an Azure DevOps account
  - publisher ID from marketplace.visualstudio.com

    npx vsce login KyleRamirez

Build package color-branch-changes-#.#.#.vsix

    pnpm package

Then install it

    code --install-extension color-branch-changes-#.#.#.vsix --force

# publish it

    npx vsce publish major|minor|patch
