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
npm run version-packages
```

```sh {"terminalRows":"24"}
npm run clean
runme run setup
npm run build
```

```sh {"terminalRows":"24"}
npm run publish-packages
```
