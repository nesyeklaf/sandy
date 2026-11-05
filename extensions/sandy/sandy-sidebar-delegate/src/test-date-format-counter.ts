export function countDateTimeFormats(): { count: () => number; restore: () => void } {
  const { count, restore } = recordDateTimeFormats();
  return { count: () => count().length, restore };
}

export function recordDateTimeFormats(): { count: () => (string | undefined)[]; restore: () => void } {
  const Original = Intl.DateTimeFormat;
  const timeZones: (string | undefined)[] = [];
  class Recording extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      super(...args);
      timeZones.push(args[1]?.timeZone);
    }
  }
  Intl.DateTimeFormat = Recording as typeof Intl.DateTimeFormat;
  return {
    count: () => timeZones,
    restore: () => {
      Intl.DateTimeFormat = Original;
    },
  };
}
