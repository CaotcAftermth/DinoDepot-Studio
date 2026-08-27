export type AssetDiagnosticCode =
  | "malformed-key"
  | "registry-failure"
  | "legacy-reference"
  | "hash-failure"
  | "cache-invalidation"
  | "revocation-purge";

export interface AssetDiagnostic {
  code: AssetDiagnosticCode;
  key: string;
  detail: string;
}

const seen = new Set<string>();

/** One warning per stable code/key/detail tuple, avoiding render-loop noise. */
export function assetDiagnostic(event: AssetDiagnostic): void {
  const fingerprint = `${event.code}\0${event.key}\0${event.detail}`;
  if (seen.has(fingerprint)) return;
  seen.add(fingerprint);
  console.warn(`[assets:${event.code}] ${event.key}: ${event.detail}`);
}

export function resetAssetDiagnosticsForTests(): void {
  seen.clear();
}
