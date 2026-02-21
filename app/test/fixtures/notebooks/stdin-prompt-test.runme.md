---
runme:
  id: stdin-prompt-test
  version: v3
---

# Stdin Prompt Test

## Echo then prompt

```bash {"name":"echo-then-prompt"}
echo "Before prompt"
read -p "Enter your name: " name
echo "Hello, $name"
```

## Password-style prompt (no echo)

```bash {"name":"password-prompt"}
read -sp "Password: " pass
echo ""
echo "Got password of length ${#pass}"
```

## Simple y/n confirmation

```bash {"name":"yn-confirm"}
echo "About to do something"
read -p "Continue? [y/n] " answer
echo "You said: $answer"
```
