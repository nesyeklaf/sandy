let unsavedSkill: string | null = null;

export function parseSkillPath(subPath: string): string | null | undefined {
  const [first, second] = subPath.split("/");
  if (first !== "skills") return undefined;
  return second === undefined || second === "" ? null : decodeURIComponent(second);
}

export function skillSubPath(name: string | null): string {
  return name === null ? "skills" : "skills/" + encodeURIComponent(name);
}

export function setUnsavedSkill(name: string | null) {
  unsavedSkill = name;
}

export function confirmLeaveSkill(): boolean {
  if (unsavedSkill === null) return true;
  const leave = window.confirm("Discard your unsaved changes to " + unsavedSkill + "?");
  if (leave) unsavedSkill = null;
  return leave;
}
