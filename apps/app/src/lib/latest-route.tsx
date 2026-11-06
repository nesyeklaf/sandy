import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import {
  useLocation,
  useNavigate,
  type Location,
  type NavigateFunction,
  type NavigateOptions,
  type To,
} from "react-router-dom";

interface LatestRoute {
  navigate: NavigateFunction;
  location: Location;
}

const LatestRouteContext = createContext<RefObject<LatestRoute | null> | null>(
  null,
);

function LatestRouteTracker({
  latest,
}: {
  latest: RefObject<LatestRoute | null>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  useLayoutEffect(() => {
    latest.current = { navigate, location };
  });
  return null;
}

export function LatestRouteProvider({ children }: { children: ReactNode }) {
  const latest = useRef<LatestRoute | null>(null);
  return (
    <LatestRouteContext.Provider value={latest}>
      <LatestRouteTracker latest={latest} />
      {children}
    </LatestRouteContext.Provider>
  );
}

function useLatestRoute(): RefObject<LatestRoute | null> {
  const latest = useContext(LatestRouteContext);
  if (latest === null) {
    throw new Error("useStableNavigate needs a LatestRouteProvider");
  }
  return latest;
}

function readLatestRoute(latest: RefObject<LatestRoute | null>): LatestRoute {
  if (latest.current === null) {
    throw new Error("LatestRouteProvider has not mounted yet");
  }
  return latest.current;
}

export function useStableNavigate(): NavigateFunction {
  const latest = useLatestRoute();
  return useCallback<NavigateFunction>(
    (to: To | number, options?: NavigateOptions) =>
      typeof to === "number"
        ? readLatestRoute(latest).navigate(to)
        : readLatestRoute(latest).navigate(to, options),
    [latest],
  );
}

export function useGetLocation(): () => Location {
  const latest = useLatestRoute();
  return useCallback(() => readLatestRoute(latest).location, [latest]);
}
