---
cwd: ..
---

# Changesets

You can find the full documentation for changesets [here](https://github.com/changesets/changesets).

```sh
npm install
```

```sh
npm run clean
npm run build
```

## Publish

We currently publish the packages manually following these steps. Be sure to complete the previous steps before running this command.

```sh {"terminalRows":"22"}
npx changeset
```

```sh
npm run version-packages
```

```sh {"terminalRows":"33"}
npm run publish-packages
```
