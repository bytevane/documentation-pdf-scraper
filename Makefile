# Makefile for the documentation PDF scraper

UV = uv
UV_ENV_DIR = .venv
UV_PYTHON = $(UV_ENV_DIR)/bin/python
NODE_MODULES = node_modules

.PHONY: help install install-python install-node venv clean-venv clean clean-all clean-cache run run-clean test lint lint-fix ci verify-openclaw verify-openclaw-ci check-venv python-info kindle7 kindle-paperwhite kindle-oasis kindle-scribe kindle-all reset-config list-configs clean-kindle docs-current docs-list docs-use

DOC_TARGET_SCRIPT = scripts/use-doc-target.js

# One docs-<name> shortcut per doc-targets/<name>.json, plus the legacy short names.
DOCS_ALIAS_claude = claude-code
DOCS_ALIAS_cloudflare = cloudflare-blog
DOCS_ALIAS_anthropic = anthropic-research
DOCS_ALIAS_openclaw = openclaw-zh-cn
DOC_TARGET_NAMES := $(sort $(basename $(notdir $(wildcard doc-targets/*.json))) openai claude cloudflare anthropic openclaw)
DOC_TARGET_SHORTCUTS := $(addprefix docs-,$(DOC_TARGET_NAMES))

.PHONY: $(DOC_TARGET_SHORTCUTS)

help:
	@echo "Available commands:"
	@echo "  install        - Install all dependencies (Python + Node.js)"
	@echo "  install-python - Create uv virtual environment and install Python dependencies"
	@echo "  install-node   - Install Node.js dependencies"
	@echo "  venv          - Create uv-managed Python virtual environment"
	@echo "  clean-venv    - Remove and recreate uv Python virtual environment"
	@echo "  run           - Generate PDF documentation"
	@echo "  run-clean     - Clean output and generate PDF documentation"
	@echo "  test          - Run tests"
	@echo "  pdf-smoke     - Generate and verify the fixed PDF layout fixture"
	@echo "  verify-pdf PDF=<path> - Check a PDF and render review previews"
	@echo "  lint          - Run linter"
	@echo "  verify-openclaw - Verify openclaw zh-CN targetUrls coverage against sitemap"
	@echo "  ci            - Run CI checks (test + lint + verify-openclaw-ci)"
	@echo "  clean         - Clean generated PDFs and metadata"
	@echo "  clean-cache   - Clean HTTP/translation/annotation caches and metadata (keep PDFs)"
	@echo "  clean-all     - Clean everything including dependencies"
	@echo ""
	@echo "Kindle PDF optimization:"
	@echo "  kindle7           - Generate PDFs for Kindle 7-inch"
	@echo "  kindle-paperwhite - Generate PDFs for Kindle Paperwhite"
	@echo "  kindle-oasis      - Generate PDFs for Kindle Oasis"
	@echo "  kindle-scribe     - Generate PDFs for Kindle Scribe"
	@echo "  kindle-all        - Generate PDFs for all Kindle devices"
	@echo "  reset-config      - Check config.json holds no device settings (read-only)"
	@echo "  list-configs      - List available PDF profiles"
	@echo "  clean-kindle      - Clean Kindle PDF files"
	@echo ""
	@echo "Doc targets:"
	@echo "  docs-<name>       - Set docTarget to doc-targets/<name>.json"
	@echo "                      ($(DOC_TARGET_NAMES))"
	@echo "  docs-use TARGET=<name|path> - Set docTarget to any target"
	@echo "  docs-list         - List available doc targets"
	@echo "  docs-current      - Show current doc configuration"

# Create Python virtual environment with uv
venv:
	@echo "\033[0;34m=== Creating uv Python Virtual Environment ===\033[0m"
	@if ! command -v $(UV) >/dev/null 2>&1; then \
		echo "\033[0;31mError: uv not found\033[0m"; \
		echo "\033[1;33mInstall uv from https://github.com/astral-sh/uv\033[0m"; \
		exit 1; \
	fi
	@if [ ! -f "pyproject.toml" ]; then \
		echo "\033[0;31mError: pyproject.toml not found in current directory\033[0m"; \
		exit 1; \
	fi
	@if [ -d "$(UV_ENV_DIR)" ]; then \
		echo "\033[1;33mVirtual environment already exists at $(UV_ENV_DIR)\033[0m"; \
		echo "\033[1;33mRun 'make clean-venv' first to recreate it\033[0m"; \
	else \
		echo "\033[0;34mCreating virtual environment at $(UV_ENV_DIR)...\033[0m"; \
		$(UV) venv $(UV_ENV_DIR) || (echo "\033[0;31mFailed to create virtual environment\033[0m"; exit 1); \
		echo "\033[0;32m✅ Virtual environment created successfully!\033[0m"; \
	fi

# Install Python dependencies in virtual environment
install-python: venv
	@echo "\033[0;34m=== Installing Python Dependencies ===\033[0m"
	@echo "\033[0;34mSyncing dependencies with uv...\033[0m"
	@$(UV) sync --locked
	@echo "\033[0;32m✅ Python dependencies installed successfully!\033[0m"
	@echo "\033[0;34m=== Usage Instructions ===\033[0m"
	@echo "\033[1;33m1. Activate virtual environment:\033[0m source .venv/bin/activate"
	@echo "\033[1;33m2. Run the project:\033[0m make run"
	@echo "\033[1;33m3. Deactivate virtual environment:\033[0m deactivate"

# Install Node.js dependencies
install-node:
	@echo "Installing Node.js dependencies..."
	npm install
	@echo "Node.js dependencies installed successfully"

# Install all dependencies
install: install-python install-node
	@echo "All dependencies installed successfully"

# Generate PDF documentation
run:
	@echo "Generating PDF documentation..."
	npm start

# Clean output and generate PDF documentation
run-clean:
	@echo "Cleaning output and generating PDF documentation..."
	npm run start:clean

# Run tests
test:
	@echo "Running tests..."
	npm test
	$(UV_PYTHON) -m unittest discover -s tests/python -v

.PHONY: pdf-smoke verify-pdf doctor
doctor:
	node scripts/doctor.js

pdf-smoke:
	node scripts/pdf-smoke.js

verify-pdf:
	node scripts/verify-pdf.js "$(PDF)"

# Run linter
lint:
	@echo "Running linter..."
	npm run lint

# Verify OpenClaw zh-CN target URLs coverage
verify-openclaw:
	@echo "Verifying OpenClaw zh-CN target URL coverage..."
	npm run docs:openclaw:verify

# Verify OpenClaw zh-CN target URLs coverage (allow network fetch failures in CI)
verify-openclaw-ci:
	@echo "Verifying OpenClaw zh-CN target URL coverage (CI mode)..."
	OPENCLAW_VERIFY_ALLOW_FETCH_FAILURE=1 npm run docs:openclaw:verify

# CI checks
ci: test lint verify-openclaw-ci
	@echo "✅ CI checks passed"

# Fix linting issues
lint-fix:
	@echo "Fixing linting issues..."
	npm run lint:fix

# Clean and recreate Python virtual environment
clean-venv:
	@echo "\033[1;33mRemoving existing Python virtual environment...\033[0m"
	@rm -rf $(UV_ENV_DIR)
	@echo "\033[0;32mVirtual environment removed\033[0m"
	@$(MAKE) install-python

# Clean generated files
clean:
	@echo "Cleaning generated PDFs and metadata..."
	npm run clean

# Clean caches and metadata without removing generated PDFs
clean-cache:
	@echo "Cleaning default HTTP/translation/annotation caches and metadata (keeping PDFs)..."
	rm -rf .cache/http
	rm -rf .temp
	rm -rf pdfs/metadata/*

# Clean all generated files and dependencies
clean-all: clean
	@echo "Removing Python virtual environment..."
	rm -rf $(UV_ENV_DIR)
	@echo "Removing Node.js dependencies..."
	rm -rf $(NODE_MODULES)
	@echo "All dependencies and generated files removed"

# Check if virtual environment exists
check-venv:
	@if [ ! -d "$(UV_ENV_DIR)" ]; then \
		echo "Virtual environment not found. Run 'make install-python' first."; \
		exit 1; \
	fi

# Show Python environment info
python-info: check-venv
	@echo "Python virtual environment info (uv):"
	@echo "uv version: $$($(UV) --version)"
	@echo "Python executable: $(UV_PYTHON)"
	@echo "Python version: $$($(UV_PYTHON) --version)"
	@echo "Installed packages:"
	@$(UV) pip list --python $(UV_PYTHON)

# Kindle PDF optimization commands
CONFIG_SCRIPT = scripts/use-kindle-config.js

# Per-run profiles preserve config.json and reuse validated acquisition artifacts.
kindle7:
	PDF_PROFILE=kindle7 node src/app.js

kindle-paperwhite:
	PDF_PROFILE=kindle-paperwhite node src/app.js

kindle-oasis:
	PDF_PROFILE=kindle-oasis node src/app.js

kindle-scribe:
	PDF_PROFILE=kindle-scribe node src/app.js

# Shared checkpoints must not be rewritten by concurrent profile runs.
kindle-all:
	$(MAKE) kindle7
	$(MAKE) kindle-paperwhite
	$(MAKE) kindle-oasis
	$(MAKE) kindle-scribe

# Reset to base configuration
# Profiles are chosen per run with PDF_PROFILE; config.json is never rewritten.
reset-config:
	@node $(CONFIG_SCRIPT) reset

# List all configurations
list-configs:
	@node $(CONFIG_SCRIPT) list

# Clean Kindle PDF files
clean-kindle:
	@echo "🧹 清理所有Kindle PDF文件..."
	@rm -rf pdfs/finalPdf-kindle7
	@rm -rf pdfs/finalPdf-paperwhite
	@rm -rf pdfs/finalPdf-oasis
	@rm -rf pdfs/finalPdf-scribe
	@echo "✅ 清理完成"

# Doc target selection (writes docTarget to config.json)
$(DOC_TARGET_SHORTCUTS): docs-%:
	@node $(DOC_TARGET_SCRIPT) use $(or $(DOCS_ALIAS_$*),$*)

docs-use:
	@test -n "$(TARGET)" || (echo "Usage: make docs-use TARGET=<name|doc-targets/file.json>"; exit 1)
	@node $(DOC_TARGET_SCRIPT) use "$(TARGET)"

docs-list:
	@node $(DOC_TARGET_SCRIPT) list

docs-current:
	@node $(DOC_TARGET_SCRIPT) current
