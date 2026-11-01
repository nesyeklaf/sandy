import {
  checkThemeCss,
  type AppTheme,
  type AppThemeSelection,
  type ThemeIssue,
  type ThemeKitInput,
} from "@sandy/domain";
import type {
  CreateThemeResponse,
  ThemeCatalogResponse,
} from "@sandy/server-contract";
import { signalRequestArgs, type CreateSdkAreaArgs } from "./common.js";

export type ThemeGetResult = AppTheme;
export type ThemeCatalogResult = ThemeCatalogResponse;
export type ThemeSetInput = AppThemeSelection;
export type ThemeSetResult = AppTheme;
export type ThemeResolveResult = AppTheme;

export type ThemeCreateResult = CreateThemeResponse;
export type ThemeCheckResult = ThemeIssue[];

export interface ThemeCreateArgs {
  name: string;
  kit: ThemeKitInput;
  overwrite?: boolean;
  signal?: AbortSignal;
}

export interface ThemeCatalogArgs {
  signal?: AbortSignal;
}

export interface ThemeGetArgs {
  signal?: AbortSignal;
}

export interface ThemeResolveArgs {
  themeId: string;
  signal?: AbortSignal;
}

export interface ThemeArea {
  get(args?: ThemeGetArgs): Promise<ThemeGetResult>;
  catalog(args?: ThemeCatalogArgs): Promise<ThemeCatalogResult>;
  resolve(args: ThemeResolveArgs): Promise<ThemeResolveResult>;
  set(selection: ThemeSetInput): Promise<ThemeSetResult>;
  set(themeId: string): Promise<ThemeSetResult>;
  /**
   * Generate a full custom theme from three anchor colors per mode and write
   * it into the custom theme directory. Rejects with a 409 when the name
   * exists and `overwrite` is not set.
   */
  experimental_create(args: ThemeCreateArgs): Promise<ThemeCreateResult>;
  /** Check theme CSS for contrast, missing tokens and eye comfort. Runs locally. */
  experimental_check(css: string): ThemeCheckResult;
}

export function createThemeArea(args: CreateSdkAreaArgs): ThemeArea {
  const { transport } = args;
  return {
    async get(input = {}) {
      const config = await transport.readJson(
        transport.api.v1.system.config.$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
      return config.appearance;
    },
    async catalog(input = {}) {
      return transport.readJson(
        transport.api.v1.settings.themes.$get(
          {},
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async resolve(input) {
      return transport.readJson(
        transport.api.v1.settings.themes[":id"].$get(
          { param: { id: input.themeId } },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    async experimental_create(input) {
      return transport.readJson(
        transport.api.v1.settings.themes.$post(
          {
            json: {
              name: input.name,
              kit: input.kit,
              overwrite: input.overwrite ?? false,
            },
          },
          ...signalRequestArgs(input.signal),
        ),
      );
    },
    experimental_check(css) {
      return checkThemeCss(css);
    },
    async set(input) {
      if (typeof input === "string") {
        const appearance = (
          await transport.readJson(transport.api.v1.system.config.$get())
        ).appearance;
        return transport.readJson(
          transport.api.v1.settings.appearance.$put({
            json: {
              themeId: input,
              faviconColor: appearance.faviconColor,
            },
          }),
        );
      }
      return transport.readJson(
        transport.api.v1.settings.appearance.$put({ json: input }),
      );
    },
  };
}
