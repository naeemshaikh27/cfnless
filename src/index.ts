#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import deploy from './lib/deploy';
import info from './lib/info';
import remove from './lib/remove';

const pkgPath = path.join(__dirname, '..', 'package.json');
const VERSION = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version as string;

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  if (args[0] === '--version' || args[0] === '-v') {
    console.log(`cfnless v${VERSION} (CloudFormation-free AWS SDK deployment)`);
    process.exit(0);
  }

  const command = args[0];
  const workdir = process.cwd();

  try {
    switch (command) {
      case 'deploy': {
        const configPath = parseConfigFlag(args);
        const functionFilter = parseFunctionFlag(args);
        await deploy(workdir, configPath, functionFilter);
        break;
      }
      case 'info': {
        const configPath = parseConfigFlag(args);
        await info(workdir, configPath);
        break;
      }
      case 'remove': {
        const configPath = parseConfigFlag(args);
        const removeCfnStack = args.includes('--remove-cfn-stack');
        const removeServerlessS3Artifacts = args.includes('--remove-serverless-s3-artifacts');
        await remove(workdir, configPath, removeCfnStack, removeServerlessS3Artifacts);
        break;
      }
      default: {
        process.stderr.write(`cfnless: unknown command "${command}"\n`);
        printUsage();
        process.exit(1);
      }
    }
  } catch (err) {
    process.stderr.write(`cfnless error: ${(err as Error).message}\n`);
    if (process.env.SLS_SDK_DEBUG) {
      process.stderr.write((err as Error).stack + '\n');
    }
    process.exit(1);
  }
}

function parseConfigFlag(args: string[]): string | null {
  const configIdx = args.indexOf('--config');
  if (configIdx !== -1 && args[configIdx + 1]) {
    return args[configIdx + 1];
  }
  return null;
}

function parseFunctionFlag(args: string[]): string | null {
  let funcIdx = args.indexOf('--function');
  if (funcIdx === -1) {
    funcIdx = args.indexOf('-f');
  }
  if (funcIdx !== -1 && args[funcIdx + 1]) {
    return args[funcIdx + 1];
  }
  return null;
}

function printUsage(): void {
  console.log(`
cfnless v${VERSION} — CloudFormation-free drop-in for the Serverless CLI

Usage: cfnless <command> [options]

Commands:
  cfnless deploy [--config <file>] [--function <name>]  Deploy functions
  cfnless info [--config <file>]                        Print deployed function endpoints as YAML
  cfnless remove [--config <file>] [--remove-cfn-stack] [--remove-serverless-s3-artifacts]
                                                          Remove all functions for a service

Options:
  --config <file>                   Path to config file (JS or YAML). Defaults to cfnless.yml or serverless.yml in cwd.
  --function, -f                    Deploy only the specified function (deploy command only).
  --remove-cfn-stack                Also delete the legacy CloudFormation stack <service>-<stage> (remove command only).
  --remove-serverless-s3-artifacts  Also delete legacy Serverless Framework S3 artifacts under
                                    serverless/<service>/<stage>/<timestamp>/ (remove command only).
  --version           Print version
  --help              Print this help

Environment:
  SLS_SDK_DEBUG=1   Enable debug stack traces on error
`);
}

if (require.main === module) {
  main();
}
