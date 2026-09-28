# Raccourcis de développement. `make test` est le critère de validation d'un jalon.
.PHONY: install lint typecheck test test-unit test-integration coverage build config up down logs e2e check

install:
	pnpm install --frozen-lockfile

lint:
	pnpm run lint
	pnpm run format:check

typecheck:
	pnpm run typecheck

test: lint typecheck
	pnpm run test

test-unit:
	pnpm run test:unit

test-integration:
	pnpm run test:integration

coverage:
	pnpm run test:coverage

build:
	pnpm run build

config:
	@test -f config/plume.yaml || cp config/plume.example.yaml config/plume.yaml

up: config
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f --tail=100

e2e:
	pnpm --filter @plume/e2e test
