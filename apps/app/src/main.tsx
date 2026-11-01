import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ApplicationUrlDialog } from "./components/ApplicationUrlDialog";
import { AppToaster } from "./components/AppToaster";
import { initializePreferredTheme } from "./hooks/useTheme";
import { initializeFavicon } from "./lib/favicon-color-preference";
import { installForeignDomMutationGuard } from "./lib/foreign-dom-mutation-guard";
import { installAppQueryClientBrowserEvents } from "./lib/query-client";
import { appQueryClient } from "./lib/app-query-client";
import { applyAppFrameGeometry, getSandyDesktopInfo } from "./lib/sandy-desktop";
import { applyCachedAppThemeCss } from "./lib/themes";
import { installStaleChunkRecovery } from "./lib/stale-chunk-recovery";
import {
  createClientErrorReporter,
  installClientErrorListeners,
} from "./lib/client-error-reporting";
import { sdk } from "./lib/sdk";
import { installThreadSwitchTrace } from "./lib/thread-switch-trace";
import { moveStylesheetPropertiesToRegistry } from "./lib/stylesheet-property-registry";
import "./app.css";

const clientErrorReporter = createClientErrorReporter({
  send: (report) => sdk.system.experimental_reportClientError(report),
  readPath: () => window.location.pathname,
});
installClientErrorListeners(window, clientErrorReporter);
installStaleChunkRecovery();
installForeignDomMutationGuard();
installThreadSwitchTrace(window);

Error.stackTraceLimit = 50;

installAppQueryClientBrowserEvents(appQueryClient);

initializePreferredTheme();
applyCachedAppThemeCss();
initializeFavicon();
applyAppFrameGeometry(document.documentElement, getSandyDesktopInfo());
if (typeof CSS.registerProperty === "function") {
  moveStylesheetPropertiesToRegistry(document.styleSheets, CSS);
}

createRoot(document.getElementById("root")!, {
  onCaughtError: (error, errorInfo) => {
    console.error(error);
    clientErrorReporter.report(
      "react-caught",
      error,
      errorInfo.componentStack ?? null,
    );
  },
  onUncaughtError: (error, errorInfo) => {
    console.error(
      "[sandy] uncaught render error — the app root was torn down",
      error,
      errorInfo.componentStack,
    );
    clientErrorReporter.report(
      "react-uncaught",
      error,
      errorInfo.componentStack ?? null,
    );
  },
}).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={appQueryClient}>
        <BrowserRouter>
          <App />
          <AppToaster />
          <ApplicationUrlDialog />
        </BrowserRouter>
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
