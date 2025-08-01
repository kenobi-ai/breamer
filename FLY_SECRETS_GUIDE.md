# Fly.io Secrets Management Guide

## Quick Start - Dynamic Secret Passing

Pass secrets to build without declaring them in files:

```bash
# Pass Fly secrets to Docker build
fly deploy --build-secret SECRET_NAME=SECRET_NAME

# Pass multiple secrets
fly deploy --build-secret NPM_TOKEN=NPM_TOKEN --build-secret API_KEY=API_KEY

# Pass from local environment to build
fly deploy --build-arg MY_SECRET=$MY_SECRET

# Or use remote builders with secrets
fly deploy --remote-only --build-secret NPM_TOKEN=NPM_TOKEN
```

## Setting Secrets

Set secrets using the Fly CLI:
```bash
fly secrets set SECRET_NAME=secret_value
fly secrets set DATABASE_URL=postgres://... REDIS_URL=redis://...
```

## Runtime Secrets (Automatically Available)

All secrets set via `fly secrets set` are automatically available as environment variables when your application starts. Your app already handles this with:
```javascript
dotenv.config(); // This loads from process.env
```

## Build-Time Secrets

If you need secrets during the Docker build process (e.g., private npm packages, API keys for build tools):

1. **Update fly.toml** to expose specific secrets as build args:
```toml
[build]
  [build.args]
    NPM_TOKEN = "NPM_TOKEN"
    PRIVATE_API_KEY = "PRIVATE_API_KEY"
```

2. **Update Dockerfile** to receive and use build args:
```dockerfile
# In the build stage
FROM base AS build

# Receive build args
ARG NPM_TOKEN
ARG PRIVATE_API_KEY

# Use them (example for private npm registry)
RUN npm config set //registry.npmjs.org/:_authToken $NPM_TOKEN

# Or set as environment variable for build scripts
ENV PRIVATE_API_KEY=$PRIVATE_API_KEY
RUN pnpm run build
```

## Important Notes

1. **Build args are NOT available at runtime** - they're only for the build process
2. **Runtime secrets are NOT available during build** - unless explicitly passed as build args
3. **Never commit secrets** to your repository
4. **Use different secrets** for development (.env file) and production (Fly secrets)

## Common Patterns

### Private NPM Packages
```toml
[build]
  [build.args]
    NPM_TOKEN = "NPM_TOKEN"
```

### API Keys for Build Tools
```toml
[build]
  [build.args]
    SENTRY_AUTH_TOKEN = "SENTRY_AUTH_TOKEN"
```

### Database Migrations During Deploy
Use a release command instead of build-time:
```toml
[deploy]
  release_command = "pnpm run migrate"
```

## Viewing Current Secrets

```bash
fly secrets list
```

## Removing Secrets

```bash
fly secrets unset SECRET_NAME
```