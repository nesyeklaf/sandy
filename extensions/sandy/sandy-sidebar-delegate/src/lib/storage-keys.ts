// Lower priorities are evicted first. Existing keys and versions are durable.
export const STORAGE_KEYS = {
  // Runtime start stamps for duration labels.
  workingSince: { key: "sandy-sidebar:working-since:v1", evictionPriority: 10 },
  // Last RPC inbox order.
  inboxOrder: { key: "sandy-sidebar:inbox-order-cache:v1", evictionPriority: 20 },
  // Last RPC lifecycle rows.
  lifecycle: { key: "sandy-sidebar:lifecycle-cache:v1", evictionPriority: 30 },
  // Expanded child parent IDs.
  childExpansion: { key: "sandy-sidebar:child-expansion:v1", evictionPriority: 40 },
  // Collapsed project IDs.
  projectCollapse: { key: "sandy-sidebar:project-collapse:v1", evictionPriority: 50 },
  // Selected projects in this window's session storage; empty means all.
  projectScope: { key: "sandy-sidebar:project-scope:v1", evictionPriority: 85 },
  // Project shortcuts saved on this device, in pin order.
  pinnedProjects: { key: "sandy-sidebar:pinned-projects:v1", evictionPriority: 90 },
  environmentCollapse: { key: "sandy-sidebar:environment-collapse:v1", evictionPriority: 55 },
  environmentGrouping: { key: "sandy-sidebar:environment-grouping:v1", evictionPriority: 71 },
  // Shelf disclosure booleans.
  shelfExpansion: { key: "sandy-sidebar:shelf-expansion:v1", evictionPriority: 60 },
  // Flow or Tree layout of the list.
  listView: { key: "sandy-sidebar:list-view:v1", evictionPriority: 70 },
  // Collapsed section and repo headers in the Tree layout.
  treeCollapse: { key: "sandy-sidebar:tree-collapse:v1", evictionPriority: 55 },
  // Active shelf sort mode.
  activeSort: { key: "sandy-sidebar:active-sort:v1", evictionPriority: 70 },
  // Last RPC sidebar settings.
  settings: { key: "sandy-sidebar:settings-cache:v1", evictionPriority: 80 },
  // Read-only legacy project grouping migration.
  activeGrouping: { key: "sandy-sidebar:active-grouping:v1", evictionPriority: 65 },
  // Machine selected for port links on this device.
  portLinkHost: { key: "sandy-sidebar:port-link-host:v1", evictionPriority: 75 },
} as const;

export const PLUGIN_STORAGE_KEYS = Object.values(STORAGE_KEYS)
  .sort((a, b) => a.evictionPriority - b.evictionPriority)
  .map(({ key }) => key);
