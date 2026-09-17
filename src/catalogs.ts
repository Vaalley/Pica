import { InputError, MAX_FILE_BYTES, readBytes } from "./api.ts";

export type AddonResult = {
  source: "modrinth" | "hangar" | "spiget";
  id: string;
  name: string;
  description: string;
  downloads: number;
  url: string;
};
export type AddonFile = { url: string; filename: string };
export type SoftwareId = "vanilla" | "paper" | "purpur" | "fabric";
export const SOFTWARE: Record<SoftwareId, string> = {
  vanilla: "Vanilla",
  paper: "Paper",
  purpur: "Purpur",
  fabric: "Fabric",
};

const UA = { "User-Agent": "Pica/1.0 (discord bot)" };

function clip(text: unknown): string {
  return String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
}

function sanitize(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return clean || "download.jar";
}

export class Catalogs {
  constructor(private request: typeof fetch = fetch) {}

  private async get(url: string, source: string): Promise<unknown> {
    let res: Response;
    try {
      res = await this.request(url, {
        headers: UA,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new InputError(`${source} is unavailable.`);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new InputError(`${source} is unavailable.`);
    }
    try {
      return await res.json();
    } catch {
      throw new InputError(`${source} is unavailable.`);
    }
  }

  async searchAddons(
    kind: "mod" | "plugin",
    query: string,
  ): Promise<AddonResult[]> {
    if (kind === "mod") return await this.searchModrinth(query);
    const [hangar, spiget] = await Promise.allSettled([
      this.searchHangar(query),
      this.searchSpiget(query),
    ]);
    if (hangar.status === "rejected" && spiget.status === "rejected") {
      throw hangar.reason;
    }
    const results = [
      ...(hangar.status === "fulfilled" ? hangar.value : []),
      ...(spiget.status === "fulfilled" ? spiget.value : []),
    ];
    return results.slice(0, 10);
  }

  private async searchModrinth(query: string): Promise<AddonResult[]> {
    const params = new URLSearchParams({
      query,
      limit: "10",
      facets: JSON.stringify([["project_type:mod"]]),
    });
    const data = await this.get(
      `https://api.modrinth.com/v2/search?${params}`,
      "Modrinth",
    ) as {
      hits?: {
        project_id?: string;
        slug?: string;
        title?: string;
        description?: string;
        downloads?: number;
      }[];
    };
    return (data.hits ?? []).map((hit) => {
      const slug = hit.slug ?? hit.project_id ?? "";
      return {
        source: "modrinth" as const,
        id: hit.project_id ?? slug,
        name: hit.title ?? slug,
        description: clip(hit.description),
        downloads: hit.downloads ?? 0,
        url: `https://modrinth.com/mod/${slug}`,
      };
    });
  }

  private async searchHangar(query: string): Promise<AddonResult[]> {
    const params = new URLSearchParams({ query, limit: "10" });
    const data = await this.get(
      `https://hangar.papermc.io/api/v1/projects?${params}`,
      "Hangar",
    ) as {
      result?: {
        name?: string;
        description?: string;
        namespace?: { owner?: string; slug?: string };
        stats?: { downloads?: number };
      }[];
    };
    return (data.result ?? []).map((p) => {
      const slug = p.namespace?.slug ?? p.name ?? "";
      return {
        source: "hangar" as const,
        id: slug,
        name: p.name ?? slug,
        description: clip(p.description),
        downloads: p.stats?.downloads ?? 0,
        url: `https://hangar.papermc.io/${p.namespace?.owner ?? ""}/${slug}`,
      };
    });
  }

  private async searchSpiget(query: string): Promise<AddonResult[]> {
    const params = new URLSearchParams({
      size: "10",
      fields: "id,name,tag,downloads,external",
      sort: "-downloads",
    });
    const data = await this.get(
      `https://api.spiget.org/v2/search/resources/${
        encodeURIComponent(query)
      }?${params}`,
      "Spiget",
    ) as {
      id?: number;
      name?: string;
      tag?: string;
      downloads?: number;
      external?: boolean;
    }[];
    return (Array.isArray(data) ? data : [])
      .filter((r) => !r.external)
      .map((r) => ({
        source: "spiget" as const,
        id: String(r.id ?? ""),
        name: r.name ?? String(r.id ?? ""),
        description: clip(r.tag),
        downloads: r.downloads ?? 0,
        url: `https://www.spigotmc.org/resources/${r.id}`,
      }));
  }

  async addonFile(
    result: AddonResult,
    gameVersion?: string,
    loader?: string,
  ): Promise<AddonFile> {
    switch (result.source) {
      case "modrinth":
        return await this.modrinthFile(result, gameVersion, loader);
      case "hangar":
        return await this.hangarFile(result);
      case "spiget":
        return await this.spigetFile(result);
    }
  }

  private async modrinthFile(
    result: AddonResult,
    gameVersion?: string,
    loader?: string,
  ): Promise<AddonFile> {
    const params = new URLSearchParams();
    if (loader) params.set("loaders", JSON.stringify([loader]));
    if (gameVersion) params.set("game_versions", JSON.stringify([gameVersion]));
    const suffix = params.size ? `?${params}` : "";
    const versions = await this.get(
      `https://api.modrinth.com/v2/project/${
        encodeURIComponent(result.id)
      }/version${suffix}`,
      "Modrinth",
    ) as { files?: { url?: string; filename?: string; primary?: boolean }[] }[];
    const files = versions[0]?.files ?? [];
    const file = files.find((f) => f.primary) ?? files[0];
    if (!file?.url) {
      throw new InputError(`No compatible file found for ${result.name}.`);
    }
    return { url: file.url, filename: sanitize(file.filename ?? "mod.jar") };
  }

  private async hangarFile(result: AddonResult): Promise<AddonFile> {
    const data = await this.get(
      `https://hangar.papermc.io/api/v1/projects/${
        encodeURIComponent(result.id)
      }/versions?limit=1`,
      "Hangar",
    ) as {
      result?: {
        downloads?: Record<
          string,
          {
            downloadUrl?: string | null;
            externalUrl?: string | null;
            fileInfo?: { name?: string } | null;
          }
        >;
      }[];
    };
    const downloads = data.result?.[0]?.downloads ?? {};
    const download = downloads.PAPER ?? Object.values(downloads)[0];
    const url = download?.downloadUrl ?? download?.externalUrl;
    if (!url) {
      throw new InputError(`No downloadable file found for ${result.name}.`);
    }
    let tail = "";
    try {
      tail = new URL(url).pathname.split("/").pop() ?? "";
    } catch { /* malformed external URL; fall back to the project name */ }
    const filename = download.fileInfo?.name ??
      (tail.includes(".") ? tail : `${result.name}.jar`);
    return { url, filename: sanitize(filename) };
  }

  private async spigetFile(result: AddonResult): Promise<AddonFile> {
    const id = encodeURIComponent(result.id);
    const [resource, version] = await Promise.all([
      this.get(
        `https://api.spiget.org/v2/resources/${id}?fields=id,name,external`,
        "Spiget",
      ) as Promise<{ name?: string; external?: boolean }>,
      this.get(
        `https://api.spiget.org/v2/resources/${id}/versions/latest`,
        "Spiget",
      ) as Promise<{ id?: number }>,
    ]);
    if (resource.external) {
      throw new InputError(`${result.name} is an external download on Spigot.`);
    }
    if (version.id == null) {
      throw new InputError(`No downloadable file found for ${result.name}.`);
    }
    return {
      url:
        `https://api.spiget.org/v2/resources/${id}/versions/${version.id}/download`,
      filename: sanitize(`${resource.name ?? result.name}.jar`),
    };
  }

  async softwareVersions(software: SoftwareId): Promise<string[]> {
    switch (software) {
      case "vanilla": {
        const data = await this.get(
          "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
          "Mojang",
        ) as { versions?: { id?: string; type?: string }[] };
        return (data.versions ?? [])
          .filter((v) => v.type === "release")
          .map((v) => v.id ?? "")
          .filter(Boolean)
          .slice(0, 25);
      }
      case "paper": {
        const data = await this.get(
          "https://fill.papermc.io/v3/projects/paper",
          "PaperMC",
        ) as { versions?: Record<string, string[]> };
        return Object.values(data.versions ?? {})
          .flat()
          .filter((v) => !v.includes("-"))
          .slice(0, 25);
      }
      case "purpur": {
        const data = await this.get(
          "https://api.purpurmc.org/v2/purpur",
          "Purpur",
        ) as { versions?: string[] };
        return (data.versions ?? []).slice().reverse().slice(0, 25);
      }
      case "fabric": {
        const data = await this.get(
          "https://meta.fabricmc.net/v2/versions/game",
          "Fabric",
        ) as { version?: string; stable?: boolean }[];
        return (Array.isArray(data) ? data : [])
          .filter((v) => v.stable)
          .map((v) => v.version ?? "")
          .filter(Boolean)
          .slice(0, 25);
      }
    }
  }

  async softwareJar(
    software: SoftwareId,
    version: string,
  ): Promise<AddonFile> {
    switch (software) {
      case "vanilla": {
        const manifest = await this.get(
          "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json",
          "Mojang",
        ) as { versions?: { id?: string; url?: string }[] };
        const entry = manifest.versions?.find((v) => v.id === version);
        if (!entry?.url) {
          throw new InputError(`Unknown Minecraft version ${version}.`);
        }
        const detail = await this.get(entry.url, "Mojang") as {
          downloads?: { server?: { url?: string } };
        };
        const url = detail.downloads?.server?.url;
        if (!url) {
          throw new InputError(`No server jar for Minecraft ${version}.`);
        }
        return { url, filename: `minecraft_server.${version}.jar` };
      }
      case "paper": {
        const builds = await this.get(
          `https://fill.papermc.io/v3/projects/paper/versions/${
            encodeURIComponent(version)
          }/builds`,
          "PaperMC",
        ) as {
          downloads?: Record<string, { name?: string; url?: string }>;
        }[];
        const downloads = builds[0]?.downloads ?? {};
        const download = downloads["server:default"] ??
          Object.values(downloads)[0];
        if (!download?.url) {
          throw new InputError(`No Paper build for ${version}.`);
        }
        return {
          url: download.url,
          filename: sanitize(download.name ?? `paper-${version}.jar`),
        };
      }
      case "purpur": {
        const data = await this.get(
          `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`,
          "Purpur",
        ) as { builds?: { latest?: string } };
        const build = data.builds?.latest;
        if (!build) throw new InputError(`No Purpur build for ${version}.`);
        return {
          url: `https://api.purpurmc.org/v2/purpur/${
            encodeURIComponent(version)
          }/${encodeURIComponent(build)}/download`,
          filename: `purpur-${version}-${build}.jar`,
        };
      }
      case "fabric": {
        const [loaders, installers] = await Promise.all([
          this.get(
            `https://meta.fabricmc.net/v2/versions/loader/${
              encodeURIComponent(version)
            }`,
            "Fabric",
          ) as Promise<{ loader?: { version?: string; stable?: boolean } }[]>,
          this.get(
            "https://meta.fabricmc.net/v2/versions/installer",
            "Fabric",
          ) as Promise<{ version?: string; stable?: boolean }[]>,
        ]);
        const loader = loaders.find((l) => l.loader?.stable)?.loader ??
          loaders[0]?.loader;
        const installer = installers.find((i) => i.stable) ?? installers[0];
        if (!loader?.version || !installer?.version) {
          throw new InputError(`No Fabric build for ${version}.`);
        }
        return {
          url: `https://meta.fabricmc.net/v2/versions/loader/${
            encodeURIComponent(version)
          }/${loader.version}/${installer.version}/server/jar`,
          filename: `fabric-server-${version}.jar`,
        };
      }
      default:
        throw new InputError(`Unknown server software ${software}.`);
    }
  }

  async download(file: AddonFile): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.request(file.url, {
        headers: UA,
        signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      throw new InputError(
        `The download is unavailable: ${
          error instanceof Error ? error.message : "request failed"
        }`,
      );
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new InputError(`The download failed with HTTP ${res.status}.`);
    }
    return await readBytes(res, MAX_FILE_BYTES);
  }
}
