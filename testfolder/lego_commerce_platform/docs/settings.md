# Django Settings

This scaffold uses a single Django settings module:

- `config.settings`

Environment variables expected by the scaffold:

- `DJANGO_SECRET_KEY`
- `DJANGO_DEBUG`
- `DJANGO_ALLOWED_HOSTS`
- `POSTGRES_HOST`
- `POSTGRES_PORT`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `REDIS_URL`
- `DJANGO_SETTINGS_MODULE`

Defaults are set so the Docker Compose stack can run without extra edits.
