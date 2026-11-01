import { describe, expect, it } from "vitest";
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";
import { readFileSync } from "node:fs";
import { loadGalleryAsset, loadThreadAudio, loadThreadFile, loadThreadImage, MAX_AUDIO_BYTES, MAX_DATA_BYTES, MAX_IMAGE_BYTES } from "./data-source";

const WORKSPACE = "/work/repo";
const STORAGE = "/home/u/.sandy/thread-storage/thr_1";

/** A file as `files.read` returns it: text as UTF-8, binary as base64. */
interface FakeFile {
  content: string;
  encoding?: "utf8" | "base64";
  sizeBytes?: number;
}

/** Just the SDK calls the loader makes, over an in-memory file table. */
function fakeSandy(files: Record<string, string | FakeFile>, reads: string[] = []): SandyPluginApi {
  const sdk = {
    threads: {
      get: async () => ({ id: "thr_1", environment: { id: "env_1", path: WORKSPACE, hostId: "host_1" } }),
      storageLocation: async () => ({ storageRootPath: STORAGE, hostId: "host_1" }),
    },
    files: {
      read: async ({ path, rootPath, hostId }: { path: string; rootPath?: string; hostId?: string }) => {
        reads.push(rootPath === undefined ? `host:${hostId}|${path}` : `${rootPath}|${path}`);
        const entry = files[path];
        if (entry === undefined) throw Object.assign(new Error("missing"), { status: 404 });
        const file = typeof entry === "string" ? { content: entry } : entry;
        return {
          path,
          content: file.content,
          contentEncoding: file.encoding ?? "utf8",
          sizeBytes: file.sizeBytes ?? file.content.length,
          sha256: "x",
        };
      },
    },
  };
  return { sdk } as unknown as SandyPluginApi;
}

describe("loadThreadFile", () => {
  it("reads workspace-relative paths inside the workspace root", async () => {
    const reads: string[] = [];
    const sandy = fakeSandy({ [`${WORKSPACE}/bench/results.json`]: '[{"name":"a","ms":12}]' }, reads);
    expect(await loadThreadFile(sandy, "thr_1", "bench/results.json")).toEqual({
      ok: true,
      value: [{ name: "a", ms: 12 }],
    });
    expect(reads).toEqual([`${WORKSPACE}|${WORKSPACE}/bench/results.json`]);
  });

  it("reads $SANDY_THREAD_STORAGE paths from the thread storage root", async () => {
    const sandy = fakeSandy({ [`${STORAGE}/sizes.csv`]: "file,lines\ncore.ts,652\n" });
    expect(await loadThreadFile(sandy, "thr_1", "$SANDY_THREAD_STORAGE/sizes.csv")).toEqual({
      ok: true,
      value: [{ file: "core.ts", lines: 652 }],
    });
  });

  it("reads absolute paths through their root, or as a host file outside the workspace, thread storage and /tmp", async () => {
    const reads: string[] = [];
    const sandy = fakeSandy(
      { [`${STORAGE}/a.json`]: "1", "/tmp/report.json": "2", "/home/u/other-checkout/shots/b.json": "3" },
      reads,
    );
    expect(await loadThreadFile(sandy, "thr_1", `${STORAGE}/a.json`)).toEqual({ ok: true, value: 1 });
    expect(await loadThreadFile(sandy, "thr_1", "/tmp/report.json")).toEqual({ ok: true, value: 2 });
    expect(await loadThreadFile(sandy, "thr_1", "/home/u/other-checkout/shots/b.json")).toEqual({ ok: true, value: 3 });
    expect(reads).toEqual([
      `${STORAGE}|${STORAGE}/a.json`,
      "/private/tmp|/private/tmp/report.json",
      "/tmp|/tmp/report.json",
      "host:host_1|/home/u/other-checkout/shots/b.json",
    ]);
    expect(await loadThreadFile(sandy, "thr_1", "/home/u/missing.json")).toEqual({ ok: false, error: "file not found" });
  });

  it("refuses an absolute path when the thread has no environment", async () => {
    const sandy = fakeSandy({ "/home/u/a.json": "1" });
    sandy.sdk.threads.get = (async () => ({ id: "thr_1", environment: null })) as unknown as typeof sandy.sdk.threads.get;
    sandy.sdk.threads.storageLocation = (async () => {
      throw new Error("no storage");
    }) as unknown as typeof sandy.sdk.threads.storageLocation;
    expect(await loadThreadFile(sandy, "thr_1", "/home/u/a.json")).toEqual({
      ok: false,
      error: "this thread has no environment to read the file from",
    });
  });

  it("refuses paths that climb out of their root", async () => {
    const reads: string[] = [];
    const sandy = fakeSandy({ "/work/secrets.json": "{}" }, reads);
    expect(await loadThreadFile(sandy, "thr_1", "../secrets.json")).toMatchObject({ ok: false });
    expect(await loadThreadFile(sandy, "thr_1", "$SANDY_THREAD_STORAGE/../../secret.json")).toMatchObject({ ok: false });
    expect(reads).toEqual([]);
  });

  it("reports a missing file as a value, not a throw", async () => {
    expect(await loadThreadFile(fakeSandy({}), "thr_1", "nope.json")).toEqual({ ok: false, error: "file not found" });
  });
});

describe("loadThreadFile raw", () => {
  it("returns the text unparsed, without a byte-order mark", async () => {
    const sandy = fakeSandy({ [`${WORKSPACE}/cfg.json`]: '\uFEFF{"a": 1}\n' });
    expect(await loadThreadFile(sandy, "thr_1", "cfg.json", { raw: true })).toEqual({ ok: true, value: '{"a": 1}\n' });
    expect(await loadThreadFile(sandy, "thr_1", "cfg.json")).toEqual({ ok: true, value: { a: 1 } });
  });

  it("keeps the confinement, text-only rule and size cap", async () => {
    const reads: string[] = [];
    const sandy = fakeSandy(
      {
        [`${WORKSPACE}/logo.png`]: { content: "iVBORw0KGgo=", encoding: "base64" },
        [`${WORKSPACE}/huge.ts`]: { content: "x", sizeBytes: MAX_DATA_BYTES + 1 },
      },
      reads,
    );
    expect(await loadThreadFile(sandy, "thr_1", "../secrets.ts", { raw: true })).toMatchObject({ ok: false });
    expect(reads).toEqual([]);
    expect(await loadThreadFile(sandy, "thr_1", "logo.png", { raw: true })).toEqual({ ok: false, error: "not a text file" });
    expect(await loadThreadFile(sandy, "thr_1", "huge.ts", { raw: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining("limit"),
    });
  });
});

describe("loadThreadImage", () => {
  it("returns workspace and thread-storage images as data URLs typed by extension", async () => {
    const sandy = fakeSandy({
      [`${WORKSPACE}/docs/shot.PNG`]: { content: "iVBORw0KGgo=", encoding: "base64" },
      [`${STORAGE}/chart.jpg`]: { content: "/9j/4AAQ", encoding: "base64" },
    });
    expect(await loadThreadImage(sandy, "thr_1", "docs/shot.PNG")).toEqual({
      ok: true,
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
    expect(await loadThreadImage(sandy, "thr_1", "$SANDY_THREAD_STORAGE/chart.jpg")).toEqual({
      ok: true,
      dataUrl: "data:image/jpeg;base64,/9j/4AAQ",
    });
  });

  it("encodes SVG that arrives as text", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const sandy = fakeSandy({ [`${WORKSPACE}/icon.svg`]: svg });
    expect(await loadThreadImage(sandy, "thr_1", "icon.svg")).toEqual({
      ok: true,
      dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    });
  });

  it("shows absolute host images and refuses relative paths that climb out", async () => {
    const reads: string[] = [];
    const sandy = fakeSandy({ "/etc/logo.png": { content: "AA==", encoding: "base64" } }, reads);
    expect(await loadThreadImage(sandy, "thr_1", "/etc/logo.png")).toEqual({ ok: true, dataUrl: "data:image/png;base64,AA==" });
    reads.length = 0;
    expect(await loadThreadImage(sandy, "thr_1", "../../etc/logo.png")).toMatchObject({ ok: false });
    expect(await loadThreadImage(sandy, "thr_1", "$SANDY_THREAD_STORAGE/../../logo.png")).toMatchObject({ ok: false });
    expect(reads).toEqual([]);
  });

  // Agents and their tools (Playwright, simulators) save screenshots to /tmp.
  // SANDY refuses a symlinked root, and macOS's /tmp links to /private/tmp.
  it("shows screenshots from /tmp through its real path on macOS", async () => {
    const reads: string[] = [];
    const sandy = fakeSandy({ "/private/tmp/rs/shot.png": { content: "AA==", encoding: "base64" } }, reads);
    const read = sandy.sdk.files.read;
    sandy.sdk.files.read = async (args) => {
      if (args.rootPath === "/tmp") throw Object.assign(new Error('Root path "/tmp" must not be a symlink'), { status: 400 });
      return read(args);
    };
    expect(await loadThreadImage(sandy, "thr_1", "/tmp/rs/shot.png")).toEqual({ ok: true, dataUrl: "data:image/png;base64,AA==" });
    expect(await loadThreadImage(sandy, "thr_1", "/tmp/rs/gone.png")).toEqual({ ok: false, error: "file not found" });
    expect(reads).toEqual(["/private/tmp|/private/tmp/rs/shot.png", "/private/tmp|/private/tmp/rs/gone.png"]);
  });

  it("falls back to /tmp as written where there is no /private/tmp", async () => {
    const reads: string[] = [];
    const sandy = fakeSandy({ "/tmp/rs/shot.png": { content: "AA==", encoding: "base64" } }, reads);
    expect(await loadThreadImage(sandy, "thr_1", "/tmp/rs/shot.png")).toMatchObject({ ok: true });
    expect(reads).toEqual(["/private/tmp|/private/tmp/rs/shot.png", "/tmp|/tmp/rs/shot.png"]);
  });

  it("only reads allowed image types", async () => {
    const reads: string[] = [];
    const sandy = fakeSandy({ [`${WORKSPACE}/page.html`]: "<script></script>", [`${WORKSPACE}/x.bmp`]: "BM" }, reads);
    for (const path of ["page.html", "x.bmp", "logo"]) {
      expect(await loadThreadImage(sandy, "thr_1", path)).toMatchObject({ ok: false, error: expect.stringContaining("png") });
    }
    expect(reads).toEqual([]);
  });

  it("caps images at 5 MB and reports missing files", async () => {
    const sandy = fakeSandy({ [`${WORKSPACE}/big.webp`]: { content: "AA==", encoding: "base64", sizeBytes: MAX_IMAGE_BYTES + 1 } });
    expect(await loadThreadImage(sandy, "thr_1", "big.webp")).toMatchObject({
      ok: false,
      error: expect.stringContaining("limit"),
    });
    expect(await loadThreadImage(sandy, "thr_1", "gone.avif")).toEqual({ ok: false, error: "file not found" });
  });
});

describe("loadThreadAudio", () => {
  it("reads recordings typed by extension, refuses other files without reading them, and caps at 25 MB", async () => {
    const reads: string[] = [];
    const sandy = fakeSandy(
      {
        [`${STORAGE}/take.wav`]: { content: "UklGRg==", encoding: "base64" },
        [`${WORKSPACE}/long.m4a`]: { content: "AA==", encoding: "base64", sizeBytes: MAX_AUDIO_BYTES + 1 },
      },
      reads,
    );
    expect(await loadThreadAudio(sandy, "thr_1", "$SANDY_THREAD_STORAGE/take.wav")).toEqual({ ok: true, dataUrl: "data:audio/wav;base64,UklGRg==" });
    expect(await loadThreadAudio(sandy, "thr_1", "long.m4a")).toMatchObject({ ok: false, error: expect.stringContaining("limit") });
    const before = reads.length;
    expect(await loadThreadAudio(sandy, "thr_1", "clip.png")).toMatchObject({ ok: false, error: expect.stringContaining("wav") });
    expect(reads.length).toBe(before);
  });
});

describe("loadGalleryAsset", () => {
  it("returns a model's and an environment's bytes unchanged", async () => {
    for (const [file, type] of [["3d/pawn.glb", "model/gltf-binary"], ["3d/studio.hdr", "image/vnd.radiance"]]) {
      const loaded = await loadGalleryAsset(file);
      expect(loaded).toEqual({ ok: true, dataUrl: `data:${type};base64,${readFileSync(`gallery/${file}`).toString("base64")}` });
    }
  });
});
