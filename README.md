# Documentation PDF Scraper

A professional web scraper and PDF generator that converts documentation websites into high-quality PDF files. It supports both **live website scraping** and **local Markdown-to-PDF conversion**, featuring modular architecture and device-optimized output (Kindle/Tablets).

## Features

- **Dual Modes**:
    - 🕷️ **Web Scraper**: Intelligent crawling of documentation sites using Puppeteer.
    - 📄 **Batch Markdown**: Direct high-fidelity PDF generation from local Markdown files.
- **Device Optimization**: Specialized layout presets for Kindle (7", Paperwhite, Oasis, Scribe).
- **Level-aware English Annotations**: Keeps English source text and adds restrained Chinese learning notes through subscription OAuth CLIs.
- **Multi-Target Support**: Built-in configs for common docs (OpenAI, Claude, Anthropic) + custom targets.
- **Smart Formatting**:
    - Preserves original styling while ensuring readability.
    - Handles wide tables, code blocks, and complex layouts.
    - **LaTeX-enhanced** PDF generation (via Pandoc) for professional typography.
- **Modular Architecture**: Dependency injection, parallel processing, and robust error handling.

## Quick Start

### Environment choices

- **Windows host (recommended):** use Docker Desktop + the repo's `devcontainer`. This keeps the runtime in a Linux container even when the host is Windows. The workspace is mounted at `/workspace`, while `node_modules` and `.venv` live on named volumes to avoid slow NTFS bind-mount writes.
- **macOS (recommended):** develop directly on the host. Docker is optional on macOS and mainly useful when reproducing a container-specific issue.

### Windows host with Docker Desktop / devcontainer

1. Install Docker Desktop.
2. Open the repository in VS Code and run **Dev Containers: Reopen in Container**.
3. Wait for the container's `postCreateCommand` to finish `make install`.
4. Run the normal workflow inside the container:

```bash
npm run docs:openai
make clean && make run
```

### macOS host installation

```bash
# Install all dependencies (Node.js + Python via uv)
make install
```

### macOS host prerequisites
- Node.js >= 24 (Node 24 LTS recommended)
- Python >= 3.10 (for PDF processing)
- uv (Python package/environment manager)
- Pandoc 3.10.2 (the version pinned in CI)
- Poppler (`brew install poppler`) for PDF verification previews
- A LaTeX engine that provides `xelatex`
- DejaVu fonts (`brew install --cask font-dejavu`) plus Noto Sans CJK SC and Noto Serif CJK SC
  for code and Chinese text. A small licensed symbol font is bundled under `assets/fonts`.
- Cairo (`brew install cairo`) for SVG diagrams in generated PDFs

## Reliability and repeatable runs

Run `make doctor` before a large job. The CLI also checks Node, Python/PyMuPDF,
Pandoc/XeLaTeX and Poppler before acquisition. CI and the devcontainer use Node 24.

- `DOC_TARGET=claude-code-curated PDF_PROFILE=kindle-scribe make run` selects a
  target and device for one run without editing `config.json`. `make kindle-all`
  runs the profiles sequentially and reuses validated Markdown artifacts.
- Resume checks the ordered URLs, acquisition configuration and SHA-256 of each
  artifact. Changed selections invalidate the checkpoint. Missing or modified
  files are reacquired. Batch assembly uses this checkpoint, never all files
  found in the output directory. Final checkpoint write failures fail the run.
- `make clean && make run` starts fresh acquisition. HTTP cache in `.cache/http`
  survives this cleanup and uses ETag/Last-Modified revalidation; an HTTP failure
  never silently returns stale bytes. `make clean-cache` clears the default HTTP
  cache too. Custom `network.cacheDirectory` locations must be cleared explicitly.
- User configuration rejects unknown fields. Use `concurrency` instead of the
  removed `queue.maxConcurrent`; `queue.maxRetries`, `queue.retryDelay` and
  `state.backupCount` were unused and now produce migration errors.
- Native Markdown downloads are limited to 5 MiB and images to 20 MiB by default.
  `network` controls timeouts, redirect count, rate limiting, 429 retries, byte
  limits and image concurrency (default 3). `network.resourceDomains` optionally
  restricts image hosts; `allowedDomains` restricts native source hosts.

MDX cards retain their titles, destinations and bodies. Static literal expressions
are retained, but unsupported dynamic expressions or empty custom components fail
with a diagnostic. JavaScript from MDX is never evaluated. Markdown code examples
keep their indentation and literal URLs/tables.

Run `make pdf-smoke`, `node scripts/pdf-smoke.js A5`, and
`PDF_PROFILE=kindle-scribe make pdf-smoke` for the layout matrix. Verification checks
page size, margins, links, body content and TOC destinations; inspect the generated
PNGs as well. Text bounds use glyph-height boxes with typography tolerance; images
and physical page boundaries retain strict checks.

For a book-like 5×8 inch reading edition, use the trusted layout pack profile:

```bash
PDF_PROFILE=reading-5x8 make pdf-smoke
DOC_TARGET=claude-code-curated PDF_PROFILE=reading-5x8 make run
```

The pack owns page geometry, fonts, line spacing, running furniture and verification
expectations as one versioned unit. Do not add direct `fontSize`, `margin`, `format` or
`markdownPdf.pdfOptions` fields beside `layoutPreset` in the same profile; ambiguous
layout configuration fails before acquisition. Runs without `layoutPreset` retain the
existing A4/Kindle behavior.

### Security boundary

Only use trusted documentation sources. HTTP acquisition rejects credentials in
URLs, private/loopback/link-local destinations and disallowed redirect hosts.
DNS checks do not pin the subsequent connection and are not a DNS-rebinding
sandbox. Benchmark-range addresses used by local proxy fake-IP resolvers are
supported. XeLaTeX runs with shell escape disabled in its render directory, but
raw TeX and local file access are not fully sandboxed. This is not a service for
rendering arbitrary untrusted uploads.

## Usage

### Mode 1: Web Scraping

Scrape a documentation website and convert it to PDF.

```bash
# 1. Select a target (e.g., OpenAI docs)
npm run docs:openai

# 2. Run the scraper
make clean && make run
```

### Source and rendering modes

`make run` always collects the selected target first. `markdownPdf.batchMode=true`
means one final Pandoc PDF is built after collection; it does not skip scraping.

- `markdownSource.enabled=true`: fetch the official source directly. Explicit URL
  lists need no Chromium; navigation discovery may still use a browser.
- `markdownSource.enabled=false`: extract content from the browser DOM.
- `markdownSource.format`: `markdown` or `mdx`, selected to match the source grammar.
- `markdown.enabled=true` and `markdownPdf.enabled=true`: use Pandoc/XeLaTeX.
  With both disabled, use Puppeteer printing and Python merging.

Source, parser, translation, annotation, image conversion and renderer errors are reported;
the workflow never switches to another source or PDF engine. A failed page stops
final PDF generation after configured retries. The original Markdown is always
retained. Translation selects `_translated.md`; English learning annotations select
`_annotated.md` and preserve the original paragraph text.

### English learning annotations

Annotations require the Markdown/Pandoc workflow and are mutually exclusive with
full translation in V1. They use existing subscription OAuth sessions: AGY with
Gemini Flash `medium` is primary. AGY is retried once only when its successful
envelope omits structured output; Codex Luna `xhigh` remains the fallback for a
primary process or deterministic response validation failure. No API key is stored.

```json
{
  "annotations": {
    "enabled": true,
    "level": "high-school",
    "density": "standard",
    "provider": "agy",
    "model": "gemini-3.7-flash-medium",
    "includeIPA": true,
    "ipaAccent": "uk",
    "fallback": {
      "provider": "codex",
      "model": "gpt-5.6-luna",
      "reasoningEffort": "xhigh"
    }
  }
}
```

`level` accepts `junior-high`, `high-school`, or `university`; `density` accepts
`light`, `standard`, or `dense`. Paragraphs, code, links, tables, headings and
frontmatter remain byte-for-byte unchanged; generated notes are adjacent Markdown
fenced divs. Valid empty annotations are accepted and do not invoke the fallback.
Density is a ceiling rather than a quota. Besides words and phrases, notes may cover
grammar patterns, discourse logic, register and usage, reusable writing patterns,
and critical concepts. The model prioritizes comprehension blockers and transferable
patterns, skips transparent or repeated targets, and writes a contextual Chinese gloss
plus a new English example sentence.

Validated source anchors use a neutral dotted underline in PDF output so they read as
“supplemental explanation available,” not as spelling or grammar errors. Adjacent
annotations and end-of-article active-recall questions use distinct, breakable grayscale
boxes for A4 and Kindle layouts. At most three why/how/compare/what-if questions are
shown per article, with higher-order language and concept questions selected first,
so retrieval practice does not overwhelm the source text.

`includeIPA` is opt-in (`false` by default). `ipaAccent` accepts `uk` (default),
`us`, or `both`; the rendered note labels each pronunciation as “英式 IPA” or
“美式 IPA”. British pronunciations come from checksum-pinned
[Britfone](https://github.com/JoseLlarena/Britfone), while American pronunciations
come from checksum-pinned [ipa-dict](https://github.com/open-dict-data/ipa-dict).
Both are normalized to familiar broad learner notation. For example, strict or
narrow source symbols are presented as STRUT `/ʌ/`, phonemic `/l/`, and the
conventional learner `/r/`; `bundle` is `/ˈbʌndəl/` in both dictionaries.
Sources are downloaded lazily and cached. Phrases, unknown words, and entries
with multiple pronunciations are omitted rather than guessed; selecting `both`
still shows one accent when only that source has an unambiguous entry. The model
never generates pronunciation text. See
`THIRD_PARTY_NOTICES.md` for provenance and licensing.

### PDF verification

Every `make run` checks the final PDF and writes `qa/<PDF name>/report.json` plus
Poppler page previews beside the PDF. Missing titles/glyphs, overflow, invalid
bookmarks and mismatched printed TOC numbers fail the command. Review the PNGs
for spacing, hierarchy, overlap and legibility; automated checks cannot certify
visual quality.

```bash
make pdf-smoke                         # Fixed local layout fixture, no website
make verify-pdf PDF=path/to/file.pdf   # Recheck using the current profile
```

The CI `PDF Layout Smoke` job generates the fixture and uploads its PDF, report
and previews. The repository skill at
[documentation-pdf-workflow](.agents/skills/documentation-pdf-workflow/SKILL.md)
describes the evidence and review order for agent-assisted work.

### device Optimization (Kindle)

Generate PDFs optimized for specific e-readers:

```bash
make kindle7           # Kindle 7-inch
make kindle-paperwhite # Kindle Paperwhite
make kindle-oasis      # Kindle Oasis
make kindle-scribe     # Kindle Scribe
```

## Configuration

### Base Configuration (`config.json`)

The core configuration file. `docTarget` determines which target-specific config is merged in.

```json
{
  "docTarget": "claude-code-curated",
  "pdfDir": "pdfs",
  "concurrency": 5,
  "markdown": { "enabled": true, "outputDir": "markdown" },
  "markdownPdf": { "enabled": true, "batchMode": true }
}
```

### Documentation Targets (`doc-targets/*.json`)

Target-specific configurations (URLs, selectors, etc.) are stored in `doc-targets/`.

**Example (official MDX source with an explicit selection):**
```json
{
  "rootURL": "https://code.claude.com/docs/en/overview",
  "baseUrl": "https://code.claude.com/docs/en/",
  "allowedDomains": ["code.claude.com"],
  "contentSelector": "#content-area",
  "navLinksSelector": "nav a",
  "targetUrls": ["https://code.claude.com/docs/en/overview"],
  "markdownSource": { "enabled": true, "format": "mdx", "urlSuffix": ".md" }
}
```

**Manage Targets via CLI:**
```bash
npm run docs:openai      # Switch to OpenAI config
npm run docs:claude      # Switch to Claude Code config
npm run docs:claude-curated # Switch to 16 curated Claude Code pages in four sections
npm run docs:claude-dev-blog # Switch to the claude.dev blog (native Markdown, no browser)
npm run docs:current     # Show current target info
npm run docs:list        # List all available targets
```

For a focused Claude Code handbook with a hierarchical table of contents:

```bash
make docs-claude-curated
make clean && make run
```

Curated targets use `targetSections` (ordered `title`, `entryUrl`, and `urls` groups)
to keep the document structure reproducible without manual metadata edits.

## Architecture

The project uses a **Dependency Injection (DI)** container for modularity:

- **Core**: `Application`, shared `ProcessRunner`
- **Services**:
    - `Scraper`: explicit Markdown or DOM acquisition, ordering and resume state.
    - `PandocPdfService`: rendering and batch assembly; content normalization and LaTeX typography live in `src/services/pdf/`.
    - `PythonMergeService`: Merges multiple PDFs using PyMuPDF.

## Development

```bash
# Run tests
make test

# Lint code
make lint

# Check Python environment
make python-info
```

## License

ISC License
