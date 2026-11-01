import { useAtom } from "jotai";
import {
  REWRITE_LOCALHOST_LINKS_DEFAULT,
  REWRITE_LOCALHOST_LINKS_STORAGE_KEY,
} from "@sandy/client-core";
import { createBooleanPreferenceAtom } from "./browser-storage";

export { rewriteLocalhostLinkHref } from "@sandy/client-core";

const rewriteLocalhostLinksPreferenceAtom = createBooleanPreferenceAtom(
  REWRITE_LOCALHOST_LINKS_STORAGE_KEY,
  REWRITE_LOCALHOST_LINKS_DEFAULT,
);

export function useRewriteLocalhostLinksPreference() {
  return useAtom(rewriteLocalhostLinksPreferenceAtom);
}
