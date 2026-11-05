export function countDateTimeFormats(): { count: () => number; restore: () => void } {
  const Original = Intl.DateTimeFormat;
  let constructed = 0;
  class Counting extends Original {
    constructor(...args: ConstructorParameters<typeof Original>) {
      super(...args);
      constructed += 1;
    }
  }
  Intl.DateTimeFormat = Counting as typeof Intl.DateTimeFormat;
  return {
    count: () => constructed,
    restore: () => {
      Intl.DateTimeFormat = Original;
    },
  };
}
