import { InputError, MAX_FILE_BYTES, PicaApiError, readBytes } from "./api.ts";

export class OperationLocks {
  private active = new Set<string>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.active.has(key)) {
      throw new InputError(
        "Your server is already working on another action. Please wait for it to finish.",
      );
    }
    this.active.add(key);
    try {
      return await operation();
    } finally {
      this.active.delete(key);
    }
  }
}
export function bytes(value: number): string {
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(2)} GiB`
    : `${(value / 1024 ** 2).toFixed(2)} MiB`;
}
export function code(value: string): string {
  return `\`${value.replaceAll("`", "ˋ").replace(/[\r\n]/g, " ")}\``;
}
export function errorMessage(error: unknown): string {
  if (error instanceof InputError) return error.message;
  if (error instanceof PicaApiError) {
    switch (error.status) {
      case 400:
        return `Check the supplied options: ${error.message}`;
      case 401:
        return "Pica authentication failed. Please contact a server administrator.";
      case 404:
        return "This server or file could not be found. Refresh your server panel or file list.";
      case 409:
        return `Pica could not complete this action: ${error.message}`;
      case 413:
        return "This file exceeds Pica's 128 MiB upload limit.";
      case 502:
        return "Minecraft console is unavailable. Start your server and try again.";
      case 503:
        return "All server slots are busy. Try again shortly.";
      default:
        return "Pica could not complete this action. Try again or contact an administrator.";
    }
  }
  if (
    error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
  ) {
    return "Pica is taking longer than expected. The action may still finish. Refresh before retrying.";
  }
  return "The action could not be completed. Please try again or contact an administrator.";
}
export async function downloadAttachment(
  url: string,
  declaredSize: number,
  request: typeof fetch = fetch,
): Promise<Uint8Array> {
  if (declaredSize > MAX_FILE_BYTES) {
    throw new InputError("Uploads cannot exceed 128 MiB.");
  }
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(parsed.hostname) ||
    parsed.port || parsed.username || parsed.password ||
    !parsed.pathname.startsWith("/attachments/")
  ) {
    throw new InputError("Use a Discord file attachment for uploads.");
  }
  const response = await request(url, {
    signal: AbortSignal.timeout(180_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new InputError(
      "Could not download your attachment. Attach the file again and retry.",
    );
  }
  return readBytes(response, MAX_FILE_BYTES);
}
