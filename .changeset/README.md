---
cwd: ..
---

# Changesets

You can find the full documentation for changesets [here](https://github.com/changesets/changesets).

```sh
runme run setup
```

## Publish

We currently publish the packages manually following these steps. Be sure to complete the previous steps before running this command.

```sh {"terminalRows":"24"}
npx changeset
```

```sh
pnpm run version-packages
```

```sh {"terminalRows":"24"}
pnpm run clean
runme run setup
pnpm run build
```

```sh {"terminalRows":"24"}
/usr/local/bin/pnpm run publish-packages
```
