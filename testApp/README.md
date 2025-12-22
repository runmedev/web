# Test App

A simple app for testing consoles using FakeStreams.

I'm seeing weird issues where in order for changes to renderers package to be picked up by testApp I need to do the following recipe

```
cd ~/git_runmeweb
find ./ -name "node_modules" -exec rm -rf {} ";"
pnpm install
pnpm run build 
```

Namely just running `run build` didn't seem to be enough. 
When you run `pnpm run dev` in `testApp` which version of the dependencies does it pick up?