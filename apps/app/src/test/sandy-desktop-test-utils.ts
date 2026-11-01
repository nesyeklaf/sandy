import type {
  SandyDesktopApi,
  SandyDesktopBrowserApi,
  SandyDesktopInfo,
} from "@sandy/desktop-contract";

export function createNoopDesktopBrowserApi(): SandyDesktopBrowserApi {
  return {
    attach() {},
    detach() {},
    navigate() {},
    goBack() {},
    goForward() {},
    reload() {},
    stop() {},
    focus() {},
    setBounds() {},
    setVisible() {},
    setVisibleWithoutFocus() {},
    onState() {
      return () => {};
    },
    onOpenTab() {
      return () => {};
    },
    onFocus() {
      return () => {};
    },
  };
}

export function createSandyDesktopApi(
  info: SandyDesktopInfo,
  browser: SandyDesktopBrowserApi = createNoopDesktopBrowserApi(),
): SandyDesktopApi {
  return {
    ...info,
    browser,
    async getInfo() {
      return info;
    },
    onChange() {
      return () => {};
    },
    setTheme() {},
    openExternalUrl() {},
  };
}
