SHELL := bash

.DEFAULT_GOAL := help

PORT ?= 3666
DEV_DATABASE_PORT ?= 55433
DEV_DATABASE_MANAGED ?= 1
DEV_DATABASE_URL ?= postgresql://reviewduck:reviewduck@127.0.0.1:$(DEV_DATABASE_PORT)/reviewduck
DEV_STATE_DIR ?= $(CURDIR)/.reviewduck-dev
DEV_COMPOSE_PROJECT ?= open-review-duck-dev
DEV_ENVIRONMENT_FILE := $(DEV_STATE_DIR)/environment

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
start: check-ports check-dependencies start-database prepare-local-development # Start the complete local development environment
	@set -euo pipefail; \
		set -a; source "$(DEV_ENVIRONMENT_FILE)"; set +a; \
		echo "$(YELLOW)Checking database connectivity$(RESET)"; \
		node scripts/check-database-connection.mjs; \
		echo "$(YELLOW)Applying pending database migrations$(RESET)"; \
		node scripts/migrate.mjs; \
		echo "$(YELLOW)Initializing the durable workflow database$(RESET)"; \
		node scripts/setup-workflow.mjs; \
		echo "$(YELLOW)Preparing Tree-sitter grammar assets$(RESET)"; \
		node scripts/prepare-tree-sitter.mjs; \
		echo "$(YELLOW)Initializing the local owner workspace$(RESET)"; \
		PORT=$(PORT) node scripts/local-bootstrap.mjs; \
		echo "$(GREEN)Starting ReviewDuck on http://localhost:$(PORT)$(RESET)"; \
		web_pid=""; \
		cleanup() { \
			trap - EXIT INT TERM; \
			[[ -z "$$web_pid" ]] || kill "$$web_pid" 2>/dev/null || true; \
			[[ -z "$$web_pid" ]] || wait "$$web_pid" 2>/dev/null || true; \
		}; \
		trap cleanup EXIT INT TERM; \
		PORT=$(PORT) \
			./node_modules/.bin/next dev --turbo --hostname 127.0.0.1 --port $(PORT) & web_pid=$$!; \
		wait "$$web_pid"; \
		echo "$(YELLOW)A ReviewDuck development service stopped unexpectedly.$(RESET)"; \
		exit 1

.PHONY: stop
stop: # Stop the managed local development database
	@if [[ "$(DEV_DATABASE_MANAGED)" == "1" ]]; then \
		echo "$(YELLOW)Stopping the local PostgreSQL database$(RESET)"; \
		REVIEWDUCK_DEV_DATABASE_PORT="$(DEV_DATABASE_PORT)" \
			docker compose --project-name "$(DEV_COMPOSE_PROJECT)" \
				--file compose.dev.yml stop database; \
	else \
		echo "DEV_DATABASE_MANAGED=0; no managed database to stop."; \
	fi

.PHONY: bootstrap
bootstrap: check-ports check-dependencies start-database prepare-local-bootstrap # Revoke local sessions and print a new owner link
	@set -euo pipefail; \
		set -a; source "$(DEV_ENVIRONMENT_FILE)"; set +a; \
		node scripts/check-database-connection.mjs; \
		node scripts/migrate.mjs; \
		PORT=$(PORT) node scripts/local-admin.mjs bootstrap

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
	@if ! [[ "$(DEV_DATABASE_PORT)" =~ ^[0-9]+$$ ]] || (( $(DEV_DATABASE_PORT) < 1 || $(DEV_DATABASE_PORT) > 65535 )); then \
		echo "DEV_DATABASE_PORT must be an integer between 1 and 65535."; \
		exit 1; \
	fi

.PHONY: check-dependencies
check-dependencies:
	@if [[ ! -x ./node_modules/.bin/next || ! -x ./node_modules/.bin/workflow ]]; then \
		echo "Dependencies are missing. Run 'make install' first."; \
		exit 1; \
	fi

.PHONY: start-database
start-database:
	@if [[ "$(DEV_DATABASE_MANAGED)" == "1" ]]; then \
		if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then \
			echo "Docker is required for the managed local PostgreSQL database."; \
			echo "Start Docker, or set DEV_DATABASE_MANAGED=0 and DEV_DATABASE_URL to your PostgreSQL 18 database."; \
			exit 1; \
		fi; \
		echo "$(YELLOW)Starting the local PostgreSQL 18 database$(RESET)"; \
		REVIEWDUCK_DEV_DATABASE_PORT="$(DEV_DATABASE_PORT)" \
			docker compose --project-name "$(DEV_COMPOSE_PROJECT)" \
				--file compose.dev.yml up --detach --wait database; \
	fi

.PHONY: prepare-local-development
prepare-local-development:
	@LOCAL_DEV_STATE_DIR="$(DEV_STATE_DIR)" \
		LOCAL_DEV_DATABASE_URL="$(DEV_DATABASE_URL)" \
		LOCAL_DEV_APP_URL="http://localhost:$(PORT)" \
		node scripts/prepare-local-development.mjs

.PHONY: prepare-local-bootstrap
prepare-local-bootstrap:
	@LOCAL_DEV_STATE_DIR="$(DEV_STATE_DIR)" \
		LOCAL_DEV_DATABASE_URL="$(DEV_DATABASE_URL)" \
		LOCAL_DEV_APP_URL="http://localhost:$(PORT)" \
		LOCAL_DEV_SKIP_NEXT_CACHE=1 \
		node scripts/prepare-local-development.mjs
