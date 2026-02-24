---
runme:
  id: test-appkernel-javascript
  version: v3
---
# AppKernel JavaScript Test Notebook

Fixture notebook for the AppKernel browser-JS CUJ.

## Cell A: stdout + JSON

```javascript {"name":"appkernel-stdout-json"}
console.log("appkernel hello");
console.log(JSON.stringify({ ok: true, n: 42 }));
```

## Cell B: helper access

```javascript {"name":"appkernel-helper-access"}
const nb = runme.getCurrentNotebook();
console.log(Boolean(nb));
console.log(nb ? nb.getName() : "no-notebook");
```

## Cell C: failure path

```javascript {"name":"appkernel-failure-path"}
throw new Error("appkernel expected test error");
```
