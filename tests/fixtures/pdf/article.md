# ARTICLE_TITLE

This fixture checks a repeatable documentation layout, including mixed language text: 中文排版检查。

The verifier works <span class="english-annotation-source">under the hood</span> to <span class="english-annotation-source">bundle</span> checks and <span class="english-annotation-source">surface</span> issues while the visible English wording remains unchanged.

::: english-annotation
**英语批注 · 高中**

- **under the hood**（惯用语）：表示系统内部实际发生的事情。

  **例句：** Under the hood, the app validates every file.
- **bundle**（生词 · 英式 IPA /ˈbʌndəl/ · 美式 IPA /ˈbʌndəl/）：表示一组、一捆，或把内容打包在一起。

  **例句：** The build tool bundles all scripts into one file.
- **surface**（生词 · 英式 IPA /ˈsɜːfɪs/ · 美式 IPA /ˈsɜːrfəs/）：表示表面或显现出来。

  **例句：** The problem may surface during verification.
:::

Use `⏸ plan mode on` to pause; ✅ Include and ❌ Exclude must remain visible.
Offsets such as 0.18 × 56 ≈ 10 px must keep the almost-equal sign.

```text
project/
├── 📊 summary
├── 📁 folder
├── src/
│   └── app.js
└── tests/
```

## Configure a reproducible environment with clear defaults

The source, content normalization, renderer and verification stages have distinct responsibilities.

```javascript
const configuration = { requestTimeout: 30000, selectedSource: "markdown", outputMode: "batch" };
const longConfigurationKey = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
```

## Read configuration fields without clipping the descriptions

| Field | Required | Description |
| --- | --- | --- |
| `permissions.defaultMode` | Yes | Select the explicit permission mode for every operation. Keep this explanation readable even when a narrow page forces the description to wrap over several lines. |
| `environment.longConfigurationPropertyNameForDocumentationTesting` | No | A long configuration key must wrap without extending outside the text area. |

## Inspect images and resume the following paragraph cleanly

![Pipeline diagram](IMAGE_PATH){width=100%}

The paragraph after the diagram must remain below the image with a clear gap.

## Preserve nested code examples and meaningful indentation

````markdown
```python
def example():
    if True:
        return "indented code must remain indented"
```
````

## Verify chapter navigation and linked table of contents

Every printed table-of-contents number must agree with the destination page label. The first content page starts at 1, after the Roman-numbered contents pages.

- Parent item
  - Nested child keeps its parent

Indented code remains code:

    indented_literal = "preserved"

```markdown
| A | B |
| --- | --- |
| x | y |
```

::: english-learning-review
**学习回顾 · 先不看批注**

用自己的话回答；答不出时，再回看上方对应批注。

1. **under the hood**：为什么这个表达适合描述用户看不到的内部实现？
2. **bundle**：你会如何用这个词描述构建工具的行为？
:::
