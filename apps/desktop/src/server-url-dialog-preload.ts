import { ipcRenderer } from "electron";
import {
  SANDY_DESKTOP_SERVER_URL_DIALOG_CANCEL_CHANNEL,
  SANDY_DESKTOP_SERVER_URL_DIALOG_SUBMIT_CHANNEL,
  serverUrlDialogSubmitResponseSchema,
} from "./server-url-dialog-ipc.js";

window.addEventListener("DOMContentLoaded", () => {
  const form = document.querySelector("form");
  const input = document.querySelector<HTMLInputElement>("input[name=url]");
  const nameInput =
    document.querySelector<HTMLInputElement>("input[name=name]");
  const error = document.querySelector<HTMLElement>("[data-error]");
  const cancel = document.querySelector<HTMLButtonElement>(
    "button[data-cancel]",
  );
  if (
    form === null ||
    input === null ||
    nameInput === null ||
    error === null ||
    cancel === null
  ) {
    return;
  }

  const focused = input.readOnly ? nameInput : input;
  focused.focus();
  focused.select();

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const payload: unknown = await ipcRenderer.invoke(
        SANDY_DESKTOP_SERVER_URL_DIALOG_SUBMIT_CHANNEL,
        { name: nameInput.value, url: input.value },
      );
      const parsed = serverUrlDialogSubmitResponseSchema.safeParse(payload);
      if (parsed.success && !parsed.data.ok) {
        error.textContent = parsed.data.message;
      }
    })();
  });

  cancel.addEventListener("click", () => {
    ipcRenderer.send(SANDY_DESKTOP_SERVER_URL_DIALOG_CANCEL_CHANNEL);
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      ipcRenderer.send(SANDY_DESKTOP_SERVER_URL_DIALOG_CANCEL_CHANNEL);
    }
  });
});
