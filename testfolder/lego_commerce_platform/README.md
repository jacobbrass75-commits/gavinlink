# LEGO Commerce Platform

This is the Phase 0 and Phase 1 Django scaffold for the LEGO resale platform described in `../LEGO_COMMERCE_PLATFORM_PLAN.md`.

## Included

- Django 5 project scaffold
- PostgreSQL + Redis + Celery Docker stack
- Django admin
- `catalog`, `inventory`, `purchasing`, `channels`, `sales`, and `ai` apps
- append-only inventory ledger events with idempotency support
- stock balance services and purchase intake workflow

## Quick Start

1. Copy `.env.example` to `.env`.
2. Start the local stack:

```bash
docker compose up --build -d
```

3. Generate and apply migrations:

```bash
docker compose run --rm web python manage.py makemigrations
docker compose run --rm web python manage.py migrate
```

4. Create an admin user:

```bash
docker compose run --rm web python manage.py createsuperuser
```

5. Open:

- app: `http://localhost:8100/`
- admin: `http://localhost:8100/admin/`
- health: `http://localhost:8100/healthz/`
