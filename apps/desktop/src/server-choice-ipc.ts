import {
  sandyDesktopServerChoiceSchema,
  type SandyDesktopServerChoice,
} from "@sandy/desktop-contract";
import { ipcMain } from "electron";
import {
  SANDY_DESKTOP_GET_SERVER_CHOICES_CHANNEL,
  SANDY_DESKTOP_SELECT_SERVER_CHANNEL,
} from "./desktop-window-command-ipc.js";

export function registerServerChoiceIpc({
  applicationWindowWebContentsIds,
  list,
  select,
  onError,
}: {
  applicationWindowWebContentsIds: ReadonlySet<number>;
  list(): SandyDesktopServerChoice[];
  select(id: string): Promise<void>;
  onError(error: unknown): void;
}): void {
  ipcMain.handle(SANDY_DESKTOP_GET_SERVER_CHOICES_CHANNEL, (event) => {
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error("Server choices are limited to sandy windows");
    }
    return list();
  });
  ipcMain.on(SANDY_DESKTOP_SELECT_SERVER_CHANNEL, (event, payload: unknown) => {
    const parsed = sandyDesktopServerChoiceSchema.shape.id.safeParse(payload);
    if (
      !applicationWindowWebContentsIds.has(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame ||
      !parsed.success
    )
      return;
    if (!list().some((choice) => choice.id === parsed.data && !choice.active))
      return;
    void select(parsed.data).catch(onError);
  });
}
