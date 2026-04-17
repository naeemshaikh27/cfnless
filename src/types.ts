export interface URLConfig {
  authorizer?: string | null;
  invokeMode?: string | null;
}

export interface FunctionConfig {
  image?: string;
  handler?: string;
  artifact?: string;           // cfnless shorthand
  package?: { artifact?: string }; // Serverless Framework-compatible form
  role?: string;
  timeout?: number;
  memorySize?: number;
  runtime?: string;
  environment?: Record<string, string>;
  url?: URLConfig | boolean | Record<string, never>;
  tags?: Record<string, string>;
}

export interface EsbuildConfig {
  tsconfig?: string;
  minify?: boolean;
  sourcemap?: boolean | 'inline' | 'external' | 'linked' | 'both';
  exclude?: string[]; // serverless-esbuild name → passed to esbuild as `external`
  external?: string[]; // esbuild-native alias; merged with exclude
}

export interface CustomConfig {
  esbuild?: EsbuildConfig;
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
  custom?: CustomConfig;
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
