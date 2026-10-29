.PHONY: install setup dev dev-backend dev-frontend docker-up docker-down db-generate db-migrate db-push build clean

install:
	npm install

setup: install docker-up db-generate db-migrate

dev:
	npx concurrently "make dev-backend" "make dev-frontend"

dev-backend:
	cd backend && npm run dev

dev-frontend:
	cd frontend && npm run dev

docker-up:
	docker compose up -d

docker-down:
	docker compose down

db-generate:
	cd backend && npx prisma generate

# Applies the committed migrations (backend/prisma/migrations) with prisma
# migrate deploy, the same script the backend container runs at start. Needs
# DATABASE_URL exported (make does not load .env). Never db push: it would
# change the schema without a migration.
db-migrate:
	sh backend/scripts/migrate.sh

# Deprecated name, kept so older notes (docker-compose.yml comment) still work.
db-push: db-migrate

build:
	cd backend && npm run build
	cd frontend && npm run build

clean:
	rm -rf backend/dist backend/node_modules frontend/.next frontend/node_modules node_modules
