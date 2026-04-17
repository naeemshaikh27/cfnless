export interface URLConfig {
  authorizer?: string | null;
  invokeMode?: string | null;
}

export interface FunctionConfig {
  image?: string;
  handler?: string;
  role?: string;
  timeout?: number;
  memorySize?: number;
  url?: URLConfig | boolean | Record<string, never>;
  tags?: Record<string, string>;
}

export interface ProviderConfig {
  region: string;
  runtime: string;
  deploymentBucket: string | null;
  deploymentPrefix: string;
  logRetentionInDays: number;
}

export interface Config {
  service: string;
  stage: string;
  provider: ProviderConfig;
  functions: Record<string, FunctionConfig>;
}

export interface NormalizedURLConfig {
  authorizer?: string | null;
  invokeMode?: string | null;
}

export interface ContainerFunctionParams {
  image: string;
  role: string;
  timeout: number;
  memorySize: number;
  urlConfig: NormalizedURLConfig | null | undefined;
  tags: Record<string, string>;
}

export interface ZipFunctionParams {
  image?: string;
  s3Bucket: string;
  s3Key: string;
  handler: string;
  role: string;
  timeout: number;
  memorySize: number;
  runtime: string;
  environment: Record<string, string>;
  urlConfig: NormalizedURLConfig | null | undefined;
  tags: Record<string, string>;
}

export interface BundleResult {
  zipFile: string;
}
