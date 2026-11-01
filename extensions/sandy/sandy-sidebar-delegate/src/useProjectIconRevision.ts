import { useState } from "react";
import { useRealtime } from "@sandy-sdk/plugin-sdk/app";
import { PROJECT_ICONS_CHANNEL } from "./realtime-channels";

export function useProjectIconRevision() {
  const [projectIconRevision, setProjectIconRevision] = useState(0);
  useRealtime(PROJECT_ICONS_CHANNEL, () => {
    setProjectIconRevision((revision) => revision + 1);
  });
  return projectIconRevision;
}
