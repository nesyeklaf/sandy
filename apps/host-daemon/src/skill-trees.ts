import type { HostDaemonSkillTreeManifest } from "@sandy/host-daemon-contract";

export interface SkillTreeTransport {
  fetchManifest(treeHash: string): Promise<HostDaemonSkillTreeManifest>;
  fetchContent(
    treeHash: string,
    paths: readonly string[],
  ): Promise<AsyncIterable<Uint8Array>>;
}
