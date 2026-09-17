import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { InputError, MAX_FILE_BYTES } from "./api.ts";
import { type AddonResult, Catalogs } from "./catalogs.ts";

function mockCatalogs(handler: (url: string) => unknown) {
  const urls: string[] = [];
  const catalogs = new Catalogs(
    ((input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      const out = handler(url);
      return Promise.resolve(
        out instanceof Response ? out : Response.json(out),
      );
    }) as typeof fetch,
  );
  return { catalogs, urls };
}

function addon(
  source: AddonResult["source"],
  id: string,
  name = "Thing",
): AddonResult {
  return { source, id, name, description: "", downloads: 0, url: "" };
}

Deno.test("mod search queries Modrinth and maps hits", async () => {
  const { catalogs, urls } = mockCatalogs(() => ({
    hits: [{
      project_id: "AANobbMI",
      slug: "sodium",
      title: "Sodium",
      description: "A fast\n rendering   engine",
      downloads: 123,
    }],
  }));
  const results = await catalogs.searchAddons("mod", "sodium");
  deepStrictEqual(results, [{
    source: "modrinth",
    id: "AANobbMI",
    name: "Sodium",
    description: "A fast rendering engine",
    downloads: 123,
    url: "https://modrinth.com/mod/sodium",
  }]);
  const url = new URL(urls[0]);
  equal(url.hostname, "api.modrinth.com");
  equal(url.pathname, "/v2/search");
  equal(url.searchParams.get("query"), "sodium");
  equal(url.searchParams.get("facets"), '[["project_type:mod"]]');
});

Deno.test("plugin search merges Hangar first then Spiget, skipping external resources", async () => {
  const { catalogs } = mockCatalogs((url) => {
    if (url.includes("hangar.papermc.io")) {
      return {
        result: [{
          name: "WorldEdit",
          description: "Edit worlds",
          namespace: { owner: "EngineHub", slug: "WorldEdit" },
          stats: { downloads: 50 },
        }],
      };
    }
    return [
      { id: 1, name: "External", tag: "x", downloads: 999, external: true },
      {
        id: 2,
        name: "LuckPerms",
        tag: "Permissions",
        downloads: 100,
        external: false,
      },
    ];
  });
  const results = await catalogs.searchAddons("plugin", "perm");
  deepStrictEqual(results.map((r) => r.source), ["hangar", "spiget"]);
  deepStrictEqual(results[0], {
    source: "hangar",
    id: "WorldEdit",
    name: "WorldEdit",
    description: "Edit worlds",
    downloads: 50,
    url: "https://hangar.papermc.io/EngineHub/WorldEdit",
  });
  deepStrictEqual(results[1], {
    source: "spiget",
    id: "2",
    name: "LuckPerms",
    description: "Permissions",
    downloads: 100,
    url: "https://www.spigotmc.org/resources/2",
  });
});

Deno.test("plugin search caps merged results at 10", async () => {
  const { catalogs } = mockCatalogs((url) => {
    if (url.includes("hangar.papermc.io")) {
      return {
        result: Array.from({ length: 8 }, (_, i) => ({
          name: `H${i}`,
          namespace: { owner: "o", slug: `h${i}` },
          stats: { downloads: i },
        })),
      };
    }
    return Array.from({ length: 8 }, (_, i) => ({
      id: i,
      name: `S${i}`,
      tag: "t",
      downloads: i,
      external: false,
    }));
  });
  const results = await catalogs.searchAddons("plugin", "x");
  equal(results.length, 10);
  deepStrictEqual(
    results.map((r) => r.source),
    [...Array(8).fill("hangar"), "spiget", "spiget"],
  );
});

Deno.test("modrinth addonFile filters by loader and game version and picks the primary file", async () => {
  const { catalogs, urls } = mockCatalogs(() => [{
    files: [
      {
        url: "https://cdn.modrinth.com/x/extra.jar",
        filename: "extra.jar",
        primary: false,
      },
      {
        url: "https://cdn.modrinth.com/x/main.jar",
        filename: "main file.jar",
        primary: true,
      },
    ],
  }]);
  const file = await catalogs.addonFile(
    addon("modrinth", "AANobbMI", "Sodium"),
    "1.21.4",
    "fabric",
  );
  deepStrictEqual(file, {
    url: "https://cdn.modrinth.com/x/main.jar",
    filename: "main_file.jar",
  });
  const url = new URL(urls[0]);
  equal(url.pathname, "/v2/project/AANobbMI/version");
  equal(url.searchParams.get("loaders"), '["fabric"]');
  equal(url.searchParams.get("game_versions"), '["1.21.4"]');
});

Deno.test("hangar addonFile uses the PAPER download URL and filename", async () => {
  const { catalogs, urls } = mockCatalogs(() => ({
    result: [{
      downloads: {
        PAPER: {
          downloadUrl: "https://hangarcdn.papermc.io/x/Plugin-1.0.jar",
          externalUrl: null,
          fileInfo: { name: "Plugin-1.0.jar" },
        },
      },
    }],
  }));
  const file = await catalogs.addonFile(addon("hangar", "Plugin"));
  deepStrictEqual(file, {
    url: "https://hangarcdn.papermc.io/x/Plugin-1.0.jar",
    filename: "Plugin-1.0.jar",
  });
  match(urls[0], /\/api\/v1\/projects\/Plugin\/versions\?limit=1$/);
});

Deno.test("spiget addonFile builds the download URL and rejects external resources", async () => {
  const { catalogs } = mockCatalogs((url) => {
    if (url.endsWith("/versions/latest")) return { id: 649245 };
    return { id: 2, name: "LuckPerms", external: false };
  });
  const file = await catalogs.addonFile(addon("spiget", "2", "LuckPerms"));
  deepStrictEqual(file, {
    url: "https://api.spiget.org/v2/resources/2/versions/649245/download",
    filename: "LuckPerms.jar",
  });

  const external = new Catalogs(
    (() =>
      Promise.resolve(
        Response.json({ id: 3, name: "Ext", external: true }),
      )) as typeof fetch,
  );
  await rejects(
    () => external.addonFile(addon("spiget", "3", "Ext")),
    InputError,
    "external",
  );
});

Deno.test("softwareVersions returns newest-first release lists per software", async () => {
  const { catalogs } = mockCatalogs((url) => {
    if (url.includes("launchermeta.mojang.com")) {
      return {
        versions: [
          { id: "26.3", type: "release" },
          { id: "26.3-rc-1", type: "snapshot" },
          { id: "1.21.4", type: "release" },
        ],
      };
    }
    if (url.includes("fill.papermc.io")) {
      return {
        versions: {
          "1.21": ["1.21.11", "1.21.11-rc3", "1.21.10"],
          "1.20": ["1.20.6"],
        },
      };
    }
    if (url.includes("purpurmc.org")) {
      return { versions: ["1.20.4", "1.21.4", "1.21.8"] };
    }
    return [
      { version: "26.3", stable: true },
      { version: "26.3-rc-3", stable: false },
      { version: "1.21.4", stable: true },
    ];
  });
  deepStrictEqual(await catalogs.softwareVersions("vanilla"), [
    "26.3",
    "1.21.4",
  ]);
  deepStrictEqual(await catalogs.softwareVersions("paper"), [
    "1.21.11",
    "1.21.10",
    "1.20.6",
  ]);
  deepStrictEqual(await catalogs.softwareVersions("purpur"), [
    "1.21.8",
    "1.21.4",
    "1.20.4",
  ]);
  deepStrictEqual(await catalogs.softwareVersions("fabric"), [
    "26.3",
    "1.21.4",
  ]);
});

Deno.test("softwareJar resolves exact download URLs per software", async () => {
  const { catalogs } = mockCatalogs((url) => {
    if (url.includes("launchermeta.mojang.com")) {
      return {
        versions: [{
          id: "1.21.4",
          url: "https://piston-meta.mojang.com/v1/packages/abc/1.21.4.json",
        }],
      };
    }
    if (url.includes("piston-meta.mojang.com")) {
      return {
        downloads: {
          server: {
            url: "https://piston-data.mojang.com/v1/objects/sha/server.jar",
          },
        },
      };
    }
    if (url.includes("fill.papermc.io")) {
      return [{
        downloads: {
          "server:default": {
            name: "paper-1.21.4-132.jar",
            url:
              "https://fill-data.papermc.io/v1/objects/sha/paper-1.21.4-132.jar",
          },
        },
      }];
    }
    if (url.includes("purpurmc.org")) {
      return { builds: { latest: "2416", all: ["2415", "2416"] } };
    }
    if (url.includes("/versions/loader/")) {
      return [
        { loader: { version: "0.19.6", stable: false } },
        { loader: { version: "0.19.5", stable: true } },
      ];
    }
    if (url.includes("/versions/installer")) {
      return [{ version: "1.1.2", stable: true }];
    }
    throw new Error(`unexpected ${url}`);
  });
  deepStrictEqual(await catalogs.softwareJar("vanilla", "1.21.4"), {
    url: "https://piston-data.mojang.com/v1/objects/sha/server.jar",
    filename: "minecraft_server.1.21.4.jar",
  });
  deepStrictEqual(await catalogs.softwareJar("paper", "1.21.4"), {
    url: "https://fill-data.papermc.io/v1/objects/sha/paper-1.21.4-132.jar",
    filename: "paper-1.21.4-132.jar",
  });
  deepStrictEqual(await catalogs.softwareJar("purpur", "1.21.4"), {
    url: "https://api.purpurmc.org/v2/purpur/1.21.4/2416/download",
    filename: "purpur-1.21.4-2416.jar",
  });
  deepStrictEqual(await catalogs.softwareJar("fabric", "1.21.4"), {
    url:
      "https://meta.fabricmc.net/v2/versions/loader/1.21.4/0.19.5/1.1.2/server/jar",
    filename: "fabric-server-1.21.4.jar",
  });
});

Deno.test("download returns bytes and rejects failures and oversized files", async () => {
  const { catalogs } = mockCatalogs(() =>
    new Response(new Uint8Array([1, 2, 3]))
  );
  deepStrictEqual(
    await catalogs.download({ url: "https://x/f.jar", filename: "f.jar" }),
    new Uint8Array([1, 2, 3]),
  );

  const big = new Catalogs(
    (() =>
      Promise.resolve(
        new Response("x", {
          headers: { "content-length": String(MAX_FILE_BYTES + 1) },
        }),
      )) as typeof fetch,
  );
  await rejects(
    () => big.download({ url: "https://x/big.jar", filename: "big.jar" }),
    InputError,
  );

  const down = new Catalogs(
    (() =>
      Promise.resolve(new Response("nope", { status: 503 }))) as typeof fetch,
  );
  await rejects(
    () => down.download({ url: "https://x/f.jar", filename: "f.jar" }),
    InputError,
  );
});

Deno.test("upstream failures surface as InputError naming the source", async () => {
  const { catalogs } = mockCatalogs(() =>
    new Response("down", { status: 503 })
  );
  const err = await catalogs.searchAddons("mod", "x").then(
    () => null,
    (e) => e,
  );
  ok(err instanceof InputError);
  match(err.message, /Modrinth/);
});
