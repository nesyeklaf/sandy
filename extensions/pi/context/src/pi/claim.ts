/**
 * Work claims per session file and kind, across pi processes: a file beside the session file, created exclusively, so
 * of two processes on one session (two terminals resuming it) one sends the requests of a kind (the historian's
 * summaries, the keep-warm ping) and the other leaves that work to it. The file names who holds it (pid, host), the
 * work and a heartbeat; a holder whose process is gone, or whose heartbeat stopped, is taken over.
 */
import { randomUUID } from "node:crypto";
import {
	closeSync,
	fstatSync,
	ftruncateSync,
	linkSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { hostname } from "node:os";
import type { WorkClaim } from "../historian/run.ts";

/** How often a holder renews its heartbeat. */
export const CLAIM_HEARTBEAT_MS = 15_000;
/** A heartbeat older than this is a holder that stopped: hung, asleep or on a host whose process cannot be checked. */
export const CLAIM_STALE_MS = 120_000;

interface ClaimRecord {
	readonly pid: number;
	readonly host: string;
	readonly key?: string;
	readonly heartbeat: number;
	readonly nonce: string;
}

/** What a claim is for; each kind has its own file, so a ping never waits for the historian or the other way round. */
export type ClaimKind = "historian" | "keep-warm";

/** The claim file of a session file. */
export function claimFile(sessionFile: string, kind: ClaimKind = "historian"): string {
	return `${sessionFile}.${kind}-claim`;
}

export class FileClaim implements WorkClaim {
	readonly #path: string;
	readonly #host = hostname();
	readonly #now: () => number;
	#fd: number | undefined;
	#record: ClaimRecord | undefined;
	#timer: ReturnType<typeof setInterval> | undefined;

	/** `now` is wall-clock time, which every process on the host shares. */
	constructor(sessionFile: string, now: () => number = Date.now, kind: ClaimKind = "historian") {
		this.#path = claimFile(sessionFile, kind);
		this.#now = now;
	}

	acquire(): boolean {
		if (this.held()) return true;
		this.#drop();
		for (let tries = 0; tries < 3; tries++) {
			if (this.#create()) return true;
			const found = this.#read();
			if (found === "gone") continue;
			if (this.#alive(found)) return false;
			this.#takeOver(found);
		}
		return false;
	}

	working(key: string): void {
		if (!this.held() || !this.#record) return;
		this.#record = { ...this.#record, key };
		this.#write();
	}

	held(): boolean {
		if (this.#fd === undefined) return false;
		try {
			return fstatSync(this.#fd).ino === statSync(this.#path).ino;
		} catch {
			return false;
		}
	}

	release(): void {
		if (this.held()) {
			try {
				unlinkSync(this.#path);
			} catch {
				// Someone took it over meanwhile; theirs stays.
			}
		}
		this.#drop();
	}

	#create(): boolean {
		let fd: number;
		try {
			fd = openSync(this.#path, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw error;
		}
		this.#fd = fd;
		this.#record = { pid: process.pid, host: this.#host, heartbeat: this.#now(), nonce: randomUUID() };
		this.#write();
		this.#timer = setInterval(() => {
			if (!this.held() || !this.#record) return this.#drop();
			this.#record = { ...this.#record, heartbeat: this.#now() };
			this.#write();
		}, CLAIM_HEARTBEAT_MS);
		this.#timer.unref?.();
		return true;
	}

	#write(): void {
		if (this.#fd === undefined || !this.#record) return;
		const text = JSON.stringify(this.#record);
		ftruncateSync(this.#fd, 0);
		writeSync(this.#fd, text, 0);
	}

	/** The holder's record; `unreadable` while it is being written, with the file's own time as its heartbeat. */
	#read(): ClaimRecord | { readonly unreadable: number } | "gone" {
		try {
			const modified = statSync(this.#path).mtimeMs;
			const text = readFileSync(this.#path, "utf8");
			try {
				const record = JSON.parse(text) as ClaimRecord;
				return typeof record.pid === "number" && typeof record.nonce === "string" ? record : { unreadable: modified };
			} catch {
				return { unreadable: modified };
			}
		} catch {
			return "gone";
		}
	}

	#alive(found: ClaimRecord | { readonly unreadable: number }): boolean {
		if ("unreadable" in found) return this.#now() - found.unreadable < CLAIM_STALE_MS;
		if (this.#now() - found.heartbeat >= CLAIM_STALE_MS) return false;
		if (found.host !== this.#host) return true;
		try {
			process.kill(found.pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ESRCH";
		}
	}

	/**
	 * Removes a dead holder's file. It is moved aside first and checked, since another process may have taken it over and
	 * created its own in between: that one is put back.
	 */
	#takeOver(found: ClaimRecord | { readonly unreadable: number }): void {
		const aside = `${this.#path}.${process.pid}.${randomUUID()}`;
		try {
			renameSync(this.#path, aside);
		} catch {
			return;
		}
		const moved = this.#readFile(aside);
		const same = "unreadable" in found ? moved === undefined : moved?.nonce === found.nonce;
		if (!same) {
			try {
				linkSync(aside, this.#path);
			} catch {
				// A third process created one meanwhile; it holds the work now.
			}
		}
		try {
			unlinkSync(aside);
		} catch {
			// Already gone.
		}
	}

	#readFile(path: string): ClaimRecord | undefined {
		try {
			const record = JSON.parse(readFileSync(path, "utf8")) as ClaimRecord;
			return typeof record.nonce === "string" ? record : undefined;
		} catch {
			return undefined;
		}
	}

	#drop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
		if (this.#fd !== undefined) {
			try {
				closeSync(this.#fd);
			} catch {
				// Closed already.
			}
		}
		this.#fd = undefined;
		this.#record = undefined;
	}
}

/** The claim of one kind on the session file in use: a session that moves to another file releases the old claim. */
export class SessionClaim {
	readonly #kind: ClaimKind;
	#held: { readonly file: string; readonly claim: FileClaim } | undefined;

	constructor(kind: ClaimKind) {
		this.#kind = kind;
	}

	/** The claim on `file`; undefined for a session without a file, which no other process can open. */
	claimFor(file: string | undefined): FileClaim | undefined {
		if (file === undefined) return undefined;
		if (this.#held?.file !== file) {
			this.#held?.claim.release();
			this.#held = { file, claim: new FileClaim(file, Date.now, this.#kind) };
		}
		return this.#held.claim;
	}

	release(): void {
		this.#held?.claim.release();
	}
}
