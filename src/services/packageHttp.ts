import { ipc, isTauri } from "./ipc";

interface NativePackageHttpResponse {
  status: number;
  contentType: string;
  bodyB64: string;
}

export interface PackageHttpResponse {
  status: number;
  contentType: string;
  bytes: Uint8Array;
}

export function packageBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Public package download boundary.
 *
 * Desktop requests run in Rust because the webview's CSP deliberately cannot
 * reach external hosts. Plain-browser mock mode retains fetch so the UI and
 * service tests remain usable without Tauri.
 */
export async function packageHttpGet(url: string): Promise<PackageHttpResponse> {
  if (isTauri) {
    const response = await ipc<NativePackageHttpResponse>("package_http_get", {
      url,
    });
    return {
      status: response.status,
      contentType: response.contentType,
      bytes: packageBase64ToBytes(response.bodyB64),
    };
  }

  const response = await fetch(url, {
    headers: {
      Accept:
        "application/vnd.github+json, application/json, image/*;q=0.9, */*;q=0.5",
    },
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

export function packageHttpText(response: PackageHttpResponse): string {
  return new TextDecoder().decode(response.bytes);
}

export function packageBytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
