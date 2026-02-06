---
runme:
  id: test-ui
  version: v3
---
# UI Test Notebook

Designed for visual and UX testing of the notebook renderer.

## Heading Level 2

### Heading Level 3

This tests the heading hierarchy rendering. Each level should be visually distinct.

## Multi-line Output Test

```bash {"name":"multiline-output"}
echo "Line 01: Start of output"
echo "Line 02: Testing scroll behavior"
echo "Line 03: The quick brown fox jumps over the lazy dog"
echo "Line 04: ABCDEFGHIJKLMNOPQRSTUVWXYZ"
echo "Line 05: 0123456789"
echo "Line 06: More content to test scrolling"
echo "Line 07: Still going..."
echo "Line 08: Almost there"
echo "Line 09: One more line"
echo "Line 10: Double digits now"
echo "Line 11: Continuing past 10 lines"
echo "Line 12: This should require scrolling"
echo "Line 13: In a reasonably sized terminal"
echo "Line 14: Final line of output"
```

## Special Characters Test

```bash {"name":"special-chars"}
echo "HTML entities: &amp; &lt; &gt; &quot;"
echo "Angle brackets: <div> </div> <span class='test'>"
echo "Quotes: 'single' \"double\" \`backtick\`"
echo "Ampersands: AT&T, R&D, Q&A"
echo "Math: 2 + 2 = 4, 10 > 5, 3 < 7"
echo "Paths: /usr/local/bin C:\\Windows\\System32"
echo "Currency: \$100 EUR50 GBP30"
```

## Unicode Characters Test

```bash {"name":"unicode-chars"}
echo "Arrows: → ⇒ ← ⇐ ↑ ↓ ↔ ⇔"
echo "Box drawing:"
echo "  ┌───┬───┐"
echo "  │ A │ B │"
echo "  ├───┼───┤"
echo "  │ C │ D │"
echo "  └───┴───┘"
echo "Math symbols: ∑ ∏ √ ∞ ≠ ≤ ≥ ± × ÷ π"
echo "Greek: α β γ δ ε θ λ μ σ φ ω"
echo "Accented: Héllo Wörld café résumé naïve"
echo "CJK: 日本語テスト 中文测试 한국어"
echo "Emoji: 🚀 ✅ ❌ ⚡ 🔧 📝 🎯"
echo "Misc: © ® ™ § ¶ † ‡ • … — –"
```

## Environment Info

```bash {"name":"env-info"}
echo "=== Environment ==="
echo "Date: $(date)"
echo "Hostname: $(hostname)"
echo "OS: $(uname -s)"
echo "Arch: $(uname -m)"
echo "PWD: $(pwd)"
```

## Edge Case: Empty Output

```bash {"name":"empty-output"}
true
```

## Edge Case: Single Character

```bash {"name":"single-char"}
echo "x"
```
