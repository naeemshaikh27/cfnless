# cfnless

A drop-in replacement for the [Serverless Framework](https://www.serverless.com/) CLI for simpler deployment configs (like Lambda with required CloudWatch log groups). It deploys AWS Lambda functions **directly via the AWS SDK** — no CloudFormation, no framework overhead.

```
cfnless deploy    # deploys your functions directly
cfnless info      # prints function URLs
cfnless remove    # deletes functions by tag
```

## When to use `cfnless` vs `oss-serverless`

If your application has complex infrastructure where a CloudFormation stack would actually be beneficial (such as managing API Gateway, DynamoDB tables, Step Functions, etc.), `cfnless` is **not** the right tool. For those cases, if you want to stick to Serverless Framework version 3 while getting security updates and support for new runtimes, you should rather use [oss-serverless](https://github.com/oss-serverless/serverless).

`cfnless` is specifically built for cases where you have simpler Lambda function deployments (either image-based or zip-based) and you want to avoid CloudFormation stacks for speed and simplicity.

## Why avoid CloudFormation?

The Serverless Framework routes all deployments through CloudFormation stacks. For simple Lambda deployments, this adds minutes of unnecessary latency to every deploy, introduces a hard dependency on stack state, and makes parallel deployments fragile. `cfnless` calls the Lambda, CloudWatch Logs, and S3 APIs directly — deploys complete in seconds.

It was built as a zero-friction swap-in for simpler setups: keep your existing `serverless.yml` (or rename to `cfnless.yml`), swap `serverless` for `cfnless` in your scripts, and stop waiting on CloudFormation.

## Installation

```bash
npm install -g cfnless
```

This installs the `cfnless` binary in your PATH.

## Requirements

- Node.js 18+
- AWS credentials in the environment (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`, or an IAM role)
- AWS region resolvable from credentials or set in `cfnless.yml` or `serverless.yml`

## Usage

### Deploy

```bash
cfnless deploy
cfnless deploy --config path/to/cfnless.yml
cfnless deploy --function api
```

Reads `cfnless.yml` (or `serverless.yml`, or their `.js` variants) from the current directory and deploys all defined functions. If `--function` is passed, only that specific function is deployed. Container image functions are updated in-place; handler functions are bundled with esbuild, uploaded to S3, and deployed as zip functions.

Bundled JS (`<functionName>.js`) and the resulting zip (`<functionName>.zip`) are written to `.cfnless/` in the project directory (analogous to Serverless Framework's `.serverless/`). Artifacts persist after deploy so you can inspect what was shipped; the folder is safe to delete at any time.

Zips are uploaded to `s3://<deploymentBucket>/<deploymentPrefix>/<service>/<stage>/<functionName>.zip`. `deploymentPrefix` defaults to `serverless` (matching the Serverless Framework) so an existing `serverless.yml` gives identical S3 paths out of the box; override it via `provider.deploymentPrefix: cfnless` (or any other value) if you want cfnless-managed artifacts under a different prefix.

### Info

```bash
cfnless info
cfnless info --config path/to/cfnless.yml
```

Prints deployed function endpoint URLs as YAML to stdout:

```yaml
service: my-service
stage: dev
region: us-east-1
stack: my-service-dev
endpoint: https://abc123.lambda-url.us-east-1.on.aws/
```

For multiple functions, `endpoint` becomes `endpoints` with a map of function keys to URLs.

### Remove

```bash
cfnless remove
cfnless remove --config path/to/cfnless.yml
cfnless remove --remove-cfn-stack
cfnless remove --remove-serverless-s3-artifacts
cfnless remove --remove-cfn-stack --remove-serverless-s3-artifacts   # full legacy teardown
```

Finds all Lambda functions tagged with `ServerlessService=<service>` and deletes them along with their CloudWatch log groups. Cfnless's own zip artifacts (flat keys directly under `s3://<deploymentBucket>/<deploymentPrefix>/<service>/<stage>/<functionName>.zip`) are always cleaned up when `provider.deploymentBucket` is configured — even if no tagged functions are found (handles half-cleaned state). Only the current stage's artifacts are removed. `<deploymentPrefix>` defaults to `serverless` and is controlled by `provider.deploymentPrefix`.

Two independent opt-in flags handle legacy Serverless Framework artifacts:

- `--remove-cfn-stack` — also deletes the legacy `<service>-<stage>` CloudFormation stack.
- `--remove-serverless-s3-artifacts` — also deletes Serverless Framework's timestamped S3 zips under `s3://<deploymentBucket>/<deploymentPrefix>/<service>/<stage>/<timestamp>-<iso>/…`. Cfnless's own flat zips are not affected by this flag (they're handled by the default cleanup).

Both flags are additive; combine them on the same invocation to fully tear down a service that was previously deployed by the Serverless Framework. Auto-created deployment buckets (Serverless's default when `provider.deploymentBucket` isn't set) are out of scope — this tool only cleans user-provided buckets declared in the config.

> **Note:** Run `cfnless remove` from the same directory and with the same config file used for deployment. The `provider.deploymentBucket` value is used to locate and clean up S3 zip artifacts — if it differs from the original deployment config, those zip files will be left in the bucket.

## Configuration

`cfnless` reads standard `cfnless.yml` or `serverless.yml` (or their `.js` variants) files. Only the fields it uses are required — everything else is ignored.

For a full working example of both container image functions and handler (zip) functions, see [`examples/cfnless.yml`](examples/cfnless.yml).

Handler functions are bundled with esbuild (TypeScript supported). A `.env` file in the project root is loaded and passed as Lambda environment variables.

### Supported fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `service` | yes | | Used as a prefix for function names and tags |
| `provider.name` | yes | | Must be `aws` |
| `provider.region` | yes | | |
| `provider.stage` | no | `dev` | Used in function names and CloudFormation stack fallback |
| `provider.runtime` | no | `nodejs18.x` | Used as esbuild target for zip functions |
| `provider.logRetentionInDays` | no | `14` | |
| `provider.deploymentBucket.name` | no | | Required for zip functions |
| `provider.deploymentPrefix` | no | `serverless` | S3 key prefix under the bucket. Matches the Serverless Framework option of the same name |
| `functions.<key>.image` | one of | | Container image URI |
| `functions.<key>.handler` | one of | | `<file>.<export>` — resolves to `<file>.ts` |
| `functions.<key>.role` | yes | | Lambda execution role ARN |
| `functions.<key>.timeout` | no | `30` | Seconds |
| `functions.<key>.memorySize` | no | `1024` | MB |
| `functions.<key>.url` | no | | `true` or `{ authorizer, invokeMode }` |
| `functions.<key>.tags` | no | | Merged with `ServerlessService` tag |

## Function naming

Functions are named `{service}-{stage}-{functionKey}`. The stage defaults to `dev` but can be configured via `provider.stage` in your config file.

## Tagging

Every deployed function receives a `ServerlessService: <service>` tag. This is how `cfnless remove` finds functions — it queries the Resource Groups Tagging API rather than relying on stack state.

## IAM permissions

The AWS principal running `cfnless` needs specific permissions for the *deployment caller* (not the Lambda execution role). 

A full, least-privilege IAM policy can be found at [`examples/iam-policy.json`](examples/iam-policy.json).

The `cloudformation:*` actions are only needed when running `cfnless remove --remove-cfn-stack` to clean up a legacy stack from the Serverless Framework.

## Environment variables

| Variable | Description |
|---|---|
| `SLS_SDK_DEBUG=1` | Print full stack traces on error instead of just the message |
| `AWS_PROFILE` | AWS credentials profile to use (passed through to the SDK) |
| `AWS_REGION` | Override region (the SDK resolves this automatically from credentials or `serverless.yml`) |

## Known limitations

- **No VPC support** — functions cannot be placed inside a VPC.
- **No custom domains** — no API Gateway or CloudFront integration.
- **No Lambda@Edge** — only standard regional Lambda functions.
- **No plugin ecosystem** — Serverless Framework plugins are not supported or loaded.
- **esbuild bundling only** — zip functions must be TypeScript/JavaScript compatible with esbuild. Webpack or other bundlers are not supported.

## Local testing

To test the full build → link → AWS round-trip locally:

```bash
npm run test:local
```

This script (`scripts/test-local.sh`):
1. Builds the project (`tsc`)
2. Links the package globally so `cfnless` is available in PATH
3. Looks for a `local-test.yml` in the project root and runs `cfnless info` against it

**First-time setup:**

```bash
cp examples/cfnless.yml cfnless.yml
# edit cfnless.yml with your real AWS values (ECR image URI, IAM role ARN, region)
```

Then set your AWS credentials and run:

```bash
export AWS_PROFILE=my-profile   # or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION
npm run test:local
```

`cfnless.yml` is gitignored — it stays local to your machine.

## Contributing

Pull requests are welcome! See [`CONTRIBUTING.md`](CONTRIBUTING.md) for details on running tests and code style.

## License

MIT
