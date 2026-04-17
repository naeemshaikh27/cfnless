import path from 'path';
import yaml from 'js-yaml';
import { loadConfig, resolveConfigPath } from './config-loader';
import { LambdaManager } from './lambda-manager';

// Outputs YAML to stdout.
// Single function: outputs `endpoint: <url>`.
// Multiple functions: outputs `endpoints: { functionKey: <url>, ... }`.
export default async function info(
  workdir: string,
  configPath: string | null = null
): Promise<void> {
  const resolvedConfig = resolveConfigPath(workdir, configPath);
  const config = loadConfig(resolvedConfig);

  const { service, stage, provider, functions } = config;
  const functionKeys = Object.keys(functions);

  if (functionKeys.length === 0) {
    process.stderr.write('No functions defined\n');
    outputYaml({ service, stage, region: provider.region });
    return;
  }

  const lambdaMgr = new LambdaManager(provider.region);

  const urlResults = await Promise.all(
    functionKeys.map(async (functionKey) => {
      const functionName = `${service}-${stage}-${functionKey}`;
      try {
        const url = await lambdaMgr.getFunctionUrl(functionName);
        if (!url) {
          process.stderr.write(`  Warning: no URL found for function ${functionName}\n`);
        }
        return { functionKey, url };
      } catch (err) {
        process.stderr.write(
          `  Warning: could not get URL for function ${functionName}: ${err.message}\n`
        );
        return { functionKey, url: null as string | null };
      }
    })
  );

  const infoObj: Record<string, unknown> = {
    service,
    stage,
    region: provider.region,
    stack: `${service}-${stage}`,
  };

  if (urlResults.length === 1) {
    infoObj.endpoint = urlResults[0].url ?? '';
  } else {
    const endpoints: Record<string, string> = {};
    for (const { functionKey, url } of urlResults) {
      endpoints[functionKey] = url ?? '';
    }
    infoObj.endpoints = endpoints;
  }

  const functionsMap: Record<string, string> = {};
  for (const functionKey of functionKeys) {
    functionsMap[functionKey] = `${service}-${stage}-${functionKey}`;
  }
  infoObj.functions = functionsMap;

  outputYaml(infoObj);
}

function outputYaml(obj: Record<string, unknown>): void {
  process.stdout.write(yaml.dump(obj, { lineWidth: -1 }));
}
