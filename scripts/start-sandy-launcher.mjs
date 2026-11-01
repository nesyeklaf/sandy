import { runNativeModulePreflight } from "./start-sandy.mjs";

const { runSandyApp, runLauncherEntry } =
  await import("../packages/sandy-app/src/launcher.ts");

runLauncherEntry(() =>
  runSandyApp(process.argv.slice(2), {
    beforeServerStart: () => runNativeModulePreflight({ checkOnly: true }),
    worktreePolicy: null,
  }),
);
