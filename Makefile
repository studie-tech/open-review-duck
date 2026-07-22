SHELL := bash

.DEFAULT_GOAL := help

PORT ?= 3666
AGENT_PORT ?= 3100

ifneq (,$(findstring xterm,$(TERM)))
	CYAN   := $(shell tput -Txterm setaf 6)
	GREEN  := $(shell tput -Txterm setaf 2)
	YELLOW := $(shell tput -Txterm setaf 3)
	RESET  := $(shell tput -Txterm sgr0)
else
	CYAN   :=
	GREEN  :=
	YELLOW :=
	RESET  :=
endif

## List of available commands:
---------------General------------------: # -------------------------------------------------------
.PHONY: help
help: # Print this command reference
	@awk 'BEGIN {FS = ":.*# "}; /^[a-zA-Z][a-zA-Z_-]*:.*# / {printf "$(CYAN)%-24s$(RESET) %s\n", $$1, $$2}' $(MAKEFILE_LIST)

-----------Local Development------------: # -------------------------------------------------------
.PHONY: install
install: # Install dependencies with the repository-pinned pnpm version
	@echo "$(GREEN)Installing dependencies$(RESET)"
	pnpm install

.PHONY: start
start: check-ports check-dependencies # Start the web app and AI service; override with PORT=4000 AGENT_PORT=3101
	@echo "$(YELLOW)Checking database connectivity$(RESET)"
	@set -euo pipefail; \
		set -a; source .env; set +a; \
		node scripts/check-database-connection.mjs; \
		echo "$(YELLOW)Applying pending database migrations$(RESET)"; \
		node scripts/migrate.mjs; \
		echo "$(GREEN)Starting ReviewDuck on http://localhost:$(PORT)$(RESET)"; \
		echo "$(GREEN)Starting the AI service on http://localhost:$(AGENT_PORT)$(RESET)"; \
		web_pid=""; agent_pid=""; \
		cleanup() { \
			trap - EXIT INT TERM; \
			[[ -z "$$web_pid" ]] || kill "$$web_pid" 2>/dev/null || true; \
			[[ -z "$$agent_pid" ]] || kill "$$agent_pid" 2>/dev/null || true; \
			[[ -z "$$web_pid" ]] || wait "$$web_pid" 2>/dev/null || true; \
			[[ -z "$$agent_pid" ]] || wait "$$agent_pid" 2>/dev/null || true; \
		}; \
		trap cleanup EXIT INT TERM; \
		FLUE_DATABASE_URL="$$DATABASE_URL" \
			FLUE_CONTROL_PLANE_URL=http://localhost:$(PORT) \
			./node_modules/.bin/flue dev --port $(AGENT_PORT) & agent_pid=$$!; \
		PORT=$(PORT) \
			./node_modules/.bin/next dev --turbo --port $(PORT) & web_pid=$$!; \
		while kill -0 "$$web_pid" 2>/dev/null && kill -0 "$$agent_pid" 2>/dev/null; do \
			sleep 1; \
		done; \
		echo "$(YELLOW)A ReviewDuck development service stopped unexpectedly.$(RESET)"; \
		exit 1

.PHONY: build
build: check-dependencies # Create an optimized production build
	@echo "$(GREEN)Building ReviewDuck$(RESET)"
	@./node_modules/.bin/next build

----------------Quality------------------: # -------------------------------------------------------
.PHONY: check
check: check-dependencies # Run formatting, linting, type checking, and tests
	@echo "$(YELLOW)Running project checks$(RESET)"
	@node scripts/check-docstrings.mjs
	@./node_modules/.bin/biome check .
	@./node_modules/.bin/tsc --noEmit
	@./node_modules/.bin/vitest run

.PHONY: format
format: check-dependencies # Format the project with Biome
	@echo "$(YELLOW)Formatting project$(RESET)"
	@./node_modules/.bin/biome format --write .

--------------Database------------------: # -------------------------------------------------------
.PHONY: migrate
migrate: check-dependencies # Apply committed Drizzle migrations
	@echo "$(YELLOW)Applying database migrations$(RESET)"
	@set -a; source .env; set +a; node scripts/migrate.mjs

.PHONY: migrations
migrations: check-dependencies # Generate a Drizzle migration from schema changes
	@echo "$(YELLOW)Generating database migration$(RESET)"
	@./node_modules/.bin/drizzle-kit generate

---------------Internal-----------------: # -------------------------------------------------------
.PHONY: check-ports
check-ports:
	@if ! [[ "$(PORT)" =~ ^[0-9]+$$ ]] || (( $(PORT) < 1 || $(PORT) > 65535 )); then \
		echo "PORT must be an integer between 1 and 65535."; \
		exit 1; \
	fi
	@if ! [[ "$(AGENT_PORT)" =~ ^[0-9]+$$ ]] || (( $(AGENT_PORT) < 1 || $(AGENT_PORT) > 65535 )); then \
		echo "AGENT_PORT must be an integer between 1 and 65535."; \
		exit 1; \
	fi
	@if [[ "$(PORT)" == "$(AGENT_PORT)" ]]; then \
		echo "PORT and AGENT_PORT must be different."; \
		exit 1; \
	fi

.PHONY: check-dependencies
check-dependencies:
	@if [[ ! -x ./node_modules/.bin/next || ! -x ./node_modules/.bin/flue ]]; then \
		echo "Dependencies are missing. Run 'make install' first."; \
		exit 1; \
	fi
	@if [[ ! -f .env ]]; then \
		echo "The local .env file is missing."; \
		exit 1; \
	fi
