/**
 * /autopilot resume: continues the newest unfinished plan-run of this session where it stopped, after pi reloaded or
 * restarted in the middle of it (plan-run.ts, docs/resume.md). Imported fresh like this module, so an edited plan-run
 * runs without restarting pi.
 */
export default async function resume(args: unknown, api: unknown) {
	const planRun = await import(`${new URL("./plan-run.ts", import.meta.url).href}?t=${Date.now()}`);
	return await planRun.resume(args, api);
}
