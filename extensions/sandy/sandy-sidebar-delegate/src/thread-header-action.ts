export interface ThreadHeaderActionProps {
  threadId: string;
  isCompactViewport: boolean;
}

interface ThreadHeaderAction {
  id: string;
  title: string;
  component: (props: ThreadHeaderActionProps) => unknown;
}

type Slots = {
  experimental_threadHeaderAction?: (registration: ThreadHeaderAction) => void;
};

export function registerThreadHeaderAction(slots: object, action: ThreadHeaderAction): boolean {
  const register = (slots as Slots).experimental_threadHeaderAction;
  if (typeof register !== "function") return false;
  register.call(slots, action);
  return true;
}
