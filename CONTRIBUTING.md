# Contributing to cfnless

## Development setup

```bash
git clone https://github.com/naeemshaikh27/cfnless.git
cd cfnless
nvm use        # uses .nvmrc (Node 20)
npm install
```

## Running tests

### Unit tests (no Docker required)

```bash
npm test
```

All AWS calls are mocked with Jest. No credentials or live AWS services needed.

### Integration tests (requires Docker)

Integration tests run against [LocalStack](https://localstack.cloud/) (Lambda, CloudWatch Logs, Resource Groups Tagging API) and [Minio](https://min.io/) (S3).

```bash
# Start services
docker compose -f __tests__/integration/docker-compose.yml up -d --wait

# Run integration tests
npm run test:integration:run

# Tear down
docker compose -f __tests__/integration/docker-compose.yml down -v
```

> Integration tests run in CI (Docker services are started automatically). Run them locally before submitting changes to deploy, remove, or any AWS client wrapper.

### All tests

```bash
npm run test:all
```

## Code style

- TypeScript — compiled to CommonJS via `tsc` (`npm run build`)
- No code comments unless the logic is genuinely non-obvious
- No added dependencies without discussion — keep the dependency footprint small
- AWS calls use `@aws-sdk/client-*` v3 with `maxAttempts: 3`

## Testing conventions

- Unit tests mock all AWS SDK clients with `jest.mock('@aws-sdk/client-*')`
- When a Command class is mocked, read constructor args via `CommandClass.mock.calls[0][0]` (not `.input` — it is undefined when the class is mocked)
- Follow the AAA pattern (Arrange / Act / Assert) with one logical assertion per test
- Do not add `aws-sdk-client-mock` — plain `jest.fn()` keeps the pattern consistent

## Pull request expectations

- All unit tests must pass: `npm test`
- New behaviour must have a corresponding test
- Keep PRs focused — one bug fix or feature per PR
- Commit message format: `<scope> | <subject>` (e.g., `lambda-manager | fix URL config update logic`)
