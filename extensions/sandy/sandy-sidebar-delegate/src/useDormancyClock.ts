import { useQuantizedNow } from "./useQuantizedNow";

export function useDormancyClock(): number {
  return useQuantizedNow();
}
