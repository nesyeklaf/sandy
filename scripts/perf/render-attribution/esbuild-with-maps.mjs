import { copyFileSync } from "node:fs";

const real = await import(process.env.RA_REAL_ESBUILD);

export const build = async (options) => {
  const result = await real.build({ ...options, sourcemap: "external" });
  copyFileSync(options.outfile + ".map", process.env.RA_MAP_OUT);
  return result;
};

export default { ...real.default, build };
