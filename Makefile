.PHONY: install setup dev dev-backend dev-frontend docker-up docker-down db-generate db-push build clean

install:
	npm install

setup: install docker-up db-generate db-push

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

db-push:
	cd backend && npx prisma db push

build:
	cd backend && npm run build
	cd frontend && npm run build

clean:
	rm -rf backend/dist backend/node_modules frontend/.next frontend/node_modules node_modules
