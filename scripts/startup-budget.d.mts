export type StartupAssetKind = "script" | "modulepreload" | "stylesheet";

export interface StartupAssetReference {
  kind: StartupAssetKind;
  url: string;
}

export interface StartupAssetMeasurement {
  path: string;
  kind: "js" | "css" | "other";
  rawBytes: number;
  gzipBytes: number;
}

export interface StartupClosureReport {
  html: string;
  assets: StartupAssetMeasurement[];
  rawBytes: number;
  gzipBytes: number;
}

export interface StartupBudget {
  name: string;
  html: string;
  gzipLimitBytes: number;
}

export interface StartupBudgetResult extends StartupBudget {
  report: StartupClosureReport;
  exceeded: boolean;
  remainingBytes: number;
  forbiddenAssets: string[];
}

export const STARTUP_BUDGETS: StartupBudget[];
export function collectStartupAssetReferences(
  html: string,
): StartupAssetReference[];
export function measureStartupClosure(
  distDirectory: string,
  htmlName: string,
): StartupClosureReport;
export function evaluateStartupBudget(
  report: StartupClosureReport,
  budget: StartupBudget,
): StartupBudgetResult;
export function runStartupBudgetCheck(
  distDir?: string,
  budgets?: StartupBudget[],
): StartupBudgetResult[];
