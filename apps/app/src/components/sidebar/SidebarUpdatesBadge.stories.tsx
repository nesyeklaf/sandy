import { useMemo, useState } from "react";
import { SettingsStoryFixtures } from "../../../.ladle/settings-story-fixtures";
import { HOST_IDS, makeHost } from "../../../.ladle/story-fixtures";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { useLocation } from "react-router-dom";
import { Button } from "@sandy/shared-ui/button";
import { MachinesSettingsSection } from "@/components/settings/MachinesSettingsSection";
import { SettingsStoryChrome } from "../../../.ladle/story-settings-chrome";
import { AppLayoutSidebar } from "@/components/layout/AppLayoutSidebar";

export default { title: "sidebar/Updates badge" };

export function MachineNotices() {
  const [offlineCount, setOfflineCount] = useState(2);
  const [lastSeenAt, setLastSeenAt] = useState(Date.now);
  const { pathname } = useLocation();
  const hosts = useMemo(
    () =>
      ["Work laptop", "Studio desktop"].map((name, index) =>
        makeHost({
          id: index === 0 ? HOST_IDS.local : HOST_IDS.remote,
          name,
          status: offlineCount > index ? "disconnected" : "connected",
          lastSeenAt,
          lastRejectedProtocolVersion:
            index === 0 && offlineCount > 0 ? 1 : null,
        }),
      ),
    [offlineCount, lastSeenAt],
  );

  return (
    <SettingsStoryFixtures hosts={hosts}>
      {pathname === "/settings/machines" ? (
        <SettingsStoryChrome activeSection="machines">
          <MachinesSettingsSection />
        </SettingsStoryChrome>
      ) : (
        <SidebarProvider className="h-screen bg-background">
          <AppLayoutSidebar
            routeSidebar={null}
            isSettingsActive={false}
            isResizing={false}
            onResizeMouseDown={() => {}}
            settingsRoutePath="/settings/machines"
            backToAppRoutePath={null}
          />
          <SidebarInset>
            <main className="space-y-6 p-6">
              <SidebarTrigger />
              <h1 className="text-lg font-semibold">Machine notices</h1>
              <p className="max-w-lg text-sm text-muted-foreground">
                Hover the footer warning, then open it to see the machines.
                Return to the app: the same outage stays acknowledged.
              </p>
              <div className="flex flex-wrap gap-2">
                {[0, 1, 2].map((count) => (
                  <Button
                    key={count}
                    variant={offlineCount === count ? "default" : "outline"}
                    onClick={() => setOfflineCount(count)}
                  >
                    {count === 0
                      ? "All online"
                      : count === 1
                        ? "One offline"
                        : "Two offline"}
                  </Button>
                ))}
                <Button
                  variant="outline"
                  onClick={() => setLastSeenAt(Date.now())}
                >
                  New outage
                </Button>
              </div>
            </main>
          </SidebarInset>
        </SidebarProvider>
      )}
    </SettingsStoryFixtures>
  );
}
