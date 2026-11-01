import { enrollMachine } from "../../../../apps/cli/src/commands/machine-enrollment.ts";

const env = {
  SANDY_DATA_DIR: process.env.SANDY_DATA_DIR,
  SANDY_ENROLLMENT: process.env.SANDY_ENROLLMENT,
  PATH: "/nonexistent",
};

await enrollMachine(
  { bootstrapEnv: "SANDY_ENROLLMENT" },
  {
    env,
    fetchFn: async () =>
      Response.json(
        { hostId: "host_synthetic", hostKey: "synthetic-host-key" },
        { status: 201 },
      ),
    homeDir: process.env.SANDY_DATA_DIR,
  },
);
