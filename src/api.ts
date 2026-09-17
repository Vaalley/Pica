export const MAX_FILE_BYTES = 128 * 1024 * 1024;
export const INSTANCE_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export type Instance = {
  id: string;
  hostname: string;
  memoryMiB: number;
  cpus: number;
  connections: number;
  eulaAccepted: boolean;
  usedBytes: number;
  storageBlocked: boolean;
  restartRequired: boolean;
  storageLimitBytes: number;
  diskBytes: number;
};
export type InstanceList = {
  instances: Instance[];
  total: number;
  maxInstances: number;
};
export type FileEntry = {
  name: string;
  size: number;
  directory: boolean;
  mode: number;
  modified: string;
  symlink: boolean;
};
export type Mutation = { ok: true; path: string; restartRequired: boolean };
export class InputError extends Error {}
export class PicaApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function validateId(id: string): string {
  if (!INSTANCE_ID.test(id)) {
    throw new InputError(
      "Server ID must be 1–32 lowercase letters, digits, or internal hyphens.",
    );
  }
  return id;
}

export function validatePath(path: string, allowRoot = false): string {
  if (
    /[\\:]/.test(path) || [...path].some((c) => c.charCodeAt(0) < 32) ||
    path.startsWith("/") ||
    path.split("/").includes("..")
  ) {
    throw new InputError(
      "Use a relative path with / separators and no parent (..) segments.",
    );
  }
  const normalized = path.split("/").filter((p) => p && p !== ".").join("/");
  if (!normalized && !allowRoot) {
    throw new InputError("Choose a file or directory, not the server root.");
  }
  return normalized;
}

export function validateCommand(command: string): string {
  if (
    !command.trim() || command.length > 4096 || /[\r\n]/.test(command) ||
    command.trimStart().startsWith("/")
  ) {
    throw new InputError(
      "Enter one console command (1–4,096 characters), without a leading / or newlines.",
    );
  }
  return command;
}

/** Bound actual streamed bytes as well as declared sizes. */
export async function readBytes(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new InputError("File exceeds the allowed transfer size.");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new InputError("File exceeds the allowed transfer size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export class PicaApi {
  private url: string;
  constructor(
    url: string,
    private secret: string,
    private request: typeof fetch = fetch,
  ) {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) || parsed.username ||
      parsed.password || parsed.search || parsed.hash
    ) {
      throw new Error(
        "PICA_URL must be an HTTP(S) URL without credentials, query, or fragment.",
      );
    }
    this.url = url.replace(/\/+$/, "");
    if (secret.length < 32) {
      throw new Error("PICA_SECRET must contain at least 32 characters.");
    }
  }

  redact(text: string): string {
    return text.replaceAll(this.secret, "[redacted]");
  }

  private route(id: string, action: string): string {
    return `/instance/${encodeURIComponent(validateId(id))}/${action}`;
  }

  private async post(
    path: string,
    fields: Record<string, unknown> = {},
    form?: FormData,
    timeoutMs = 180_000,
  ): Promise<Response> {
    const response = await this.request(`${this.url}${path}`, {
      method: "POST",
      headers: form ? undefined : { "Content-Type": "application/json" },
      body: form ?? JSON.stringify({ ...fields, secret: this.secret }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new PicaApiError(
        response.status,
        this.redact(
          typeof payload?.error === "string"
            ? payload.error
            : "Pica request failed",
        ),
      );
    }
    return response;
  }
  private async json<T>(
    path: string,
    fields: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return await (await this.post(path, fields, undefined, timeoutMs)).json();
  }
  list(): Promise<InstanceList> {
    return this.json("/instance/list");
  }
  create(id: string, eulaAccepted: boolean): Promise<Instance> {
    validateId(id);
    if (eulaAccepted !== true) {
      throw new InputError(
        "You must explicitly accept the Minecraft EULA to create a server.",
      );
    }
    return this.json("/instance/create", { id, eulaAccepted: true });
  }
  instance(
    id: string,
    action: "status" | "start" | "stop" | "restart" | "delete",
    timeoutMs?: number,
  ): Promise<Instance> {
    return this.json(this.route(id, action), {}, timeoutMs);
  }
  tail(id: string, timeoutMs?: number): Promise<{ lines: string[] }> {
    return this.json(this.route(id, "tail"), {}, timeoutMs);
  }
  run(id: string, command: string): Promise<{ ok: true; response?: string }> {
    return this.json(this.route(id, "run"), {
      command: validateCommand(command),
    });
  }
  files(
    id: string,
    path = "",
  ): Promise<{ path: string; entries: FileEntry[] }> {
    return this.json(this.route(id, "fs/list"), {
      path: validatePath(path, true),
    });
  }
  stat(id: string, path: string): Promise<FileEntry> {
    return this.json(this.route(id, "fs/stat"), {
      path: validatePath(path, true),
    });
  }
  async read(
    id: string,
    path: string,
    limit = MAX_FILE_BYTES,
  ): Promise<Uint8Array> {
    const response = await this.post(this.route(id, "fs/read"), {
      path: validatePath(path),
    });
    return readBytes(response, Math.min(limit, MAX_FILE_BYTES));
  }
  async write(
    id: string,
    path: string,
    file: Blob,
    filename: string,
  ): Promise<{ path: string; bytes: number; restartRequired: boolean }> {
    const route = this.route(id, "fs/write");
    path = validatePath(path);
    if (file.size > MAX_FILE_BYTES) {
      throw new InputError("Uploads cannot exceed 128 MiB.");
    }
    const form = new FormData();
    form.append("secret", this.secret);
    form.append("path", path);
    form.append("file", file, filename);
    return await (await this.post(route, {}, form)).json();
  }
  mutate(
    id: string,
    action: "mkdir" | "rename" | "copy" | "delete" | "chmod",
    path: string,
    options: { destination?: string; recursive?: boolean; mode?: number } = {},
  ): Promise<Mutation> {
    const fields: Record<string, unknown> = { path: validatePath(path) };
    if (action === "rename" || action === "copy") {
      fields.destination = validatePath(options.destination ?? "");
    }
    if (action === "copy" || action === "delete") {
      fields.recursive = options.recursive ?? false;
    }
    if (action === "chmod") {
      if (
        !Number.isInteger(options.mode) || options.mode! < 0 ||
        options.mode! > 0o777
      ) {
        throw new InputError(
          "Permissions must be an octal value from 000 to 777.",
        );
      }
      fields.mode = options.mode;
    }
    return this.json(this.route(id, `fs/${action}`), fields);
  }
}
