// \0rolldown/runtime.js
var e = Object.defineProperty, t = (e, t, n) => () => {
	if (n) throw n[0];
	try {
		return e && (t = e(e = 0)), t;
	} catch (e) {
		throw n = [e], e;
	}
}, n = (t, n) => {
	let r = {};
	for (var i in t) e(r, i, {
		get: t[i],
		enumerable: !0
	});
	return n || e(r, Symbol.toStringTag, { value: "Module" }), r;
}, r = {}, i = () => r;
function a(e) {
	try {
		return new URL(e, globalThis.location?.href).href;
	} catch {
		return e;
	}
}
// node_modules/.pnpm/libavoid-js@0.5.0-beta.5/node_modules/libavoid-js/dist/index.js
var o = /* @__PURE__ */ n({ AvoidLib: () => c }), s, c, l = t((() => {
	s = (e) => ({
		avoidLib: void 0,
		async load(t = void 0) {
			if (this.avoidLib) console.log("Avoid library is already initialized");
			else {
				let n = function(e, n) {
					return t !== void 0 && e.endsWith(".wasm") ? t : n + e;
				};
				this.avoidLib = await e({ locateFile: n });
			}
		},
		getInstance() {
			if (!this.avoidLib) throw Error("Avoid library should be initialized before using");
			return this.avoidLib;
		}
	}), c = s((() => {
		var e = import.meta.url;
		return async function(t = {}) {
			var n, r = t, i, a, o = new Promise((e, t) => {
				i = e, a = t;
			}), s = "./this.program", c = "", l;
			if (typeof document < "u" && document.currentScript && (c = document.currentScript.src), e && (c = e), c = c.startsWith("blob:") ? "" : c.slice(0, c.replace(/[?#].*/, "").lastIndexOf("/") + 1), typeof window != "object" && typeof WorkerGlobalScope > "u") throw Error("not compiled for this environment (did you build to HTML and try to run it not on the web, or set ENVIRONMENT to something - like node - and run it someplace else - like on the web?)");
			l = async (e) => {
				if (g(!re(e), "readAsync does not work with file:// URLs"), e = await fetch(e, { credentials: "same-origin" }), e.ok) return e.arrayBuffer();
				throw Error(e.status + " : " + e.url);
			};
			var u = console.log.bind(console), d = console.error.bind(console);
			g(!0, "worker environment detected but not enabled at build time.  Add `worker` to `-sENVIRONMENT` to enable."), g(!0, "node environment detected but not enabled at build time.  Add `node` to `-sENVIRONMENT` to enable."), g(!0, "shell environment detected but not enabled at build time.  Add `shell` to `-sENVIRONMENT` to enable.");
			var f;
			typeof WebAssembly != "object" && d("no native wasm support detected");
			var p, m = !1, h;
			function g(e, t) {
				e || A("Assertion failed" + (t ? ": " + t : ""));
			}
			var _, v, y, b, x, S, ee, C, te, ne, w = !1, T = !1, re = (e) => e.startsWith("file://");
			function ie() {
				var e = Qt();
				g(!(e & 3)), e == 0 && (e += 4), S[e >> 2] = 34821223, S[e + 4 >> 2] = 2310721022, S[0] = 1668509029;
			}
			function E() {
				if (!m) {
					var e = Qt();
					e == 0 && (e += 4);
					var t = S[e >> 2], n = S[e + 4 >> 2];
					t == 34821223 && n == 2310721022 || A(`Stack overflow! Stack cookie has been overwritten at ${P(e)}, expected hex dwords 0x89BACDFE and 0x2135467, but received ${P(n)} ${P(t)}`), S[0] != 1668509029 && A("Runtime error: The application has corrupted its heap memory area (address zero)!");
				}
			}
			var ae = /* @__PURE__ */ new Int16Array(1), oe = new Int8Array(ae.buffer);
			if (ae[0] = 25459, oe[0] !== 115 || oe[1] !== 99) throw "Runtime error: expected the system to be little-endian! (Run with -sSUPPORT_BIG_ENDIAN to bypass)";
			function D(e) {
				Object.getOwnPropertyDescriptor(r, e) || Object.defineProperty(r, e, {
					configurable: !0,
					set() {
						A(`Attempt to set \`Module.${e}\` after it has already been processed.  This can happen, for example, when code is injected via '--post-js' rather than '--pre-js'`);
					}
				});
			}
			function se(e) {
				return e === "FS_createPath" || e === "FS_createDataFile" || e === "FS_createPreloadedFile" || e === "FS_unlink" || e === "addRunDependency" || e === "FS_createLazyFile" || e === "FS_createDevice" || e === "removeRunDependency";
			}
			function ce(e, t) {
				typeof globalThis > "u" || Object.getOwnPropertyDescriptor(globalThis, e) || Object.defineProperty(globalThis, e, {
					configurable: !0,
					get() {
						t();
					}
				});
			}
			function le(e, t) {
				ce(e, () => {
					F(`\`${e}\` is not longer defined by emscripten. ${t}`);
				});
			}
			le("buffer", "Please use HEAP8.buffer or wasmMemory.buffer"), le("asm", "Please use wasmExports instead");
			function ue(e) {
				Object.getOwnPropertyDescriptor(r, e) || Object.defineProperty(r, e, {
					configurable: !0,
					get() {
						var t = `'${e}' was not exported. add it to EXPORTED_RUNTIME_METHODS (see the Emscripten FAQ)`;
						se(e) && (t += ". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you"), A(t);
					}
				});
			}
			function de() {
				var e = p.buffer;
				_ = new Int8Array(e), y = new Int16Array(e), v = new Uint8Array(e), b = new Uint16Array(e), x = new Int32Array(e), S = new Uint32Array(e), ee = new Float32Array(e), ne = new Float64Array(e), C = new BigInt64Array(e), te = new BigUint64Array(e);
			}
			g(typeof Int32Array < "u" && typeof Float64Array < "u" && Int32Array.prototype.subarray != null && Int32Array.prototype.set != null, "JS engine does not provide full typed array support");
			var O = 0, fe = null, pe = {}, k = null;
			function me() {
				O++, r.monitorRunDependencies?.(O), g(!pe["wasm-instantiate"]), pe["wasm-instantiate"] = 1, k === null && typeof setInterval < "u" && (k = setInterval(() => {
					if (m) clearInterval(k), k = null;
					else {
						var e = !1, t;
						for (t in pe) e || (e = !0, d("still waiting on run dependencies:")), d(`dependency: ${t}`);
						e && d("(end of list)");
					}
				}, 1e4));
			}
			function A(e) {
				throw r.onAbort?.(e), e = "Aborted(" + e + ")", d(e), m = !0, w && en(), e = new WebAssembly.RuntimeError(e), a(e), e;
			}
			function he() {
				A("Filesystem support (FS) was not included. The problem is that you are using files from JS, but files were not used from C/C++, so filesystem support was not auto-included. You can force-include filesystem support with -sFORCE_FILESYSTEM");
			}
			function j(e, t) {
				return (...n) => {
					g(w, `native function \`${e}\` called before runtime initialization`), g(!T, `native function \`${e}\` called after runtime exit (use NO_EXIT_RUNTIME to keep it alive after main() exits)`);
					var r = Q[e];
					return g(r, `exported native function \`${e}\` not found`), g(n.length <= t, `native function \`${e}\` called with ${n.length} args but expects ${t}`), r(...n);
				};
			}
			var ge = 0;
			function _e(e) {
				return (...t) => {
					if (m) throw "program has already aborted!";
					ge++;
					try {
						return e(...t);
					} catch (e) {
						if (m || 1 < ge || e === "unwind") throw e;
						A("unhandled exception: " + [e, e.stack]);
					} finally {
						ge--;
					}
				};
			}
			function ve() {
				var e = I.get, t = {};
				I.get = (n) => {
					var r = e.call(I, n), i = t[n];
					return i && i.S === r || (i = t[n] = {
						S: r,
						ca: _e(r)
					}), i.ca;
				};
			}
			var M;
			async function ye(e) {
				if (!f) try {
					var t = await l(e);
					return new Uint8Array(t);
				} catch {}
				if (e == M && f) e = new Uint8Array(f);
				else throw "both async and sync fetching of the wasm failed";
				return e;
			}
			async function be(e, t) {
				try {
					var n = await ye(e);
					return await WebAssembly.instantiate(n, t);
				} catch (e) {
					d(`failed to asynchronously prepare wasm: ${e}`), re(M) && d(`warning: Loading from a file URI (${M}) is not supported in most browsers. See https://emscripten.org/docs/getting_started/FAQ.html#how-do-i-run-a-local-webserver-for-testing-why-does-my-program-stall-in-downloading-or-preparing`), A(e);
				}
			}
			async function xe(e) {
				var t = M;
				if (!f && typeof WebAssembly.instantiateStreaming == "function") try {
					var n = fetch(t, { credentials: "same-origin" });
					return await WebAssembly.instantiateStreaming(n, e);
				} catch (e) {
					d(`wasm streaming compile failed: ${e}`), d("falling back to ArrayBuffer instantiation");
				}
				return be(t, e);
			}
			class Se {
				name = "ExitStatus";
				constructor(e) {
					this.message = `Program terminated with exit(${e})`, this.status = e;
				}
			}
			var Ce = (e) => {
				for (; 0 < e.length;) e.shift()(r);
			}, we = [], Te = [], Ee = () => {
				var e = r.preRun.shift();
				Te.push(e);
			}, N = !1, P = (e) => (g(typeof e == "number"), "0x" + (e >>> 0).toString(16).padStart(8, "0")), F = (e) => {
				F.M ||= {}, F.M[e] || (F.M[e] = 1, d(e));
			}, I, De = typeof TextDecoder < "u" ? new TextDecoder() : void 0, Oe = (e, t = 0, n = NaN) => {
				var r = t + n;
				for (n = t; e[n] && !(n >= r);) ++n;
				if (16 < n - t && e.buffer && De) return De.decode(e.subarray(t, n));
				for (r = ""; t < n;) {
					var i = e[t++];
					if (i & 128) {
						var a = e[t++] & 63;
						if ((i & 224) == 192) r += String.fromCharCode((i & 31) << 6 | a);
						else {
							var o = e[t++] & 63;
							(i & 240) == 224 ? i = (i & 15) << 12 | a << 6 | o : ((i & 248) != 240 && F("Invalid UTF-8 leading byte " + P(i) + " encountered when deserializing a UTF-8 string in wasm memory to a JS string!"), i = (i & 7) << 18 | a << 12 | o << 6 | e[t++] & 63), 65536 > i ? r += String.fromCharCode(i) : (i -= 65536, r += String.fromCharCode(55296 | i >> 10, 56320 | i & 1023));
						}
					} else r += String.fromCharCode(i);
				}
				return r;
			}, L = (e, t) => (g(typeof e == "number", `UTF8ToString expects a number (got ${typeof e})`), e ? Oe(v, e, t) : ""), ke = (e) => (e = e.getArg(Q.__cpp_exception, 0), cn(e)), Ae = (e) => {
				var t = ke(e);
				e = an();
				var n = rn(4), r = rn(4);
				if (ln(t, n, r), t = S[n >> 2], r = S[r >> 2], n = L(t), $(t), r) {
					var i = L(r);
					$(r);
				}
				return nn(e), [n, i];
			}, R = (e) => {
				if (e === null) return "null";
				var t = typeof e;
				return t === "object" || t === "array" || t === "function" ? e.toString() : "" + e;
			}, je, z = (e) => {
				for (var t = ""; v[e];) t += je[v[e++]];
				return t;
			}, B = {}, V = {}, Me = {}, H = r.BindingError = class extends Error {
				constructor(e) {
					super(e), this.name = "BindingError";
				}
			}, Ne = (e) => {
				throw new H(e);
			};
			function Pe(e, t, n = {}) {
				var r = t.name;
				if (!e) throw new H(`type "${r}" must have a positive integer typeid pointer`);
				if (V.hasOwnProperty(e)) {
					if (n.V) return;
					throw new H(`Cannot register type '${r}' twice`);
				}
				V[e] = t, delete Me[e], B.hasOwnProperty(e) && (t = B[e], delete B[e], t.forEach((e) => e()));
			}
			function U(e, t, n = {}) {
				if (t.o === void 0) throw TypeError("registerType registeredInstance requires argPackAdvance");
				return Pe(e, t, n);
			}
			var Fe = (e, t, n) => {
				switch (t) {
					case 1: return n ? (e) => _[e] : (e) => v[e];
					case 2: return n ? (e) => y[e >> 1] : (e) => b[e >> 1];
					case 4: return n ? (e) => x[e >> 2] : (e) => S[e >> 2];
					case 8: return n ? (e) => C[e >> 3] : (e) => te[e >> 3];
					default: throw TypeError(`invalid integer width (${t}): ${e}`);
				}
			}, Ie = (e) => {
				throw new H(e.g.j.h.name + " instance already deleted");
			}, Le = !1, Re = () => {}, ze = (e, t, n) => t === n ? e : n.m === void 0 ? null : (e = ze(e, t, n.m), e === null ? null : n.R(e)), Be = {}, Ve = {}, He = (e, t) => {
				if (t === void 0) throw new H("ptr should not be undefined");
				for (; e.m;) t = e.H(t), e = e.m;
				return Ve[t];
			}, Ue = r.InternalError = class extends Error {
				constructor(e) {
					super(e), this.name = "InternalError";
				}
			}, We = (e, t) => {
				if (!t.j || !t.i) throw new Ue("makeClassHandle requires ptr and ptrType");
				if (!!t.v != !!t.l) throw new Ue("Both smartPtrType and smartPtr must be specified");
				return t.count = { value: 1 }, W(Object.create(e, { g: {
					value: t,
					writable: !0
				} }));
			};
			function Ge(e) {
				function t() {
					return this.K ? We(this.h.A, {
						j: this.Y,
						i: n,
						v: this,
						l: e
					}) : We(this.h.A, {
						j: this,
						i: e
					});
				}
				var n = this.U(e);
				if (!n) return this.N(e), null;
				var r = He(this.h, n);
				if (r !== void 0) return r.g.count.value === 0 ? (r.g.i = n, r.g.l = e, r.clone()) : (r = r.clone(), this.N(e), r);
				if (r = this.h.T(n), r = Be[r], !r) return t.call(this);
				r = this.J ? r.P : r.pointerType;
				var i = ze(n, this.h, r.h);
				return i === null ? t.call(this) : this.K ? We(r.h.A, {
					j: r,
					i,
					v: this,
					l: e
				}) : We(r.h.A, {
					j: r,
					i
				});
			}
			var W = (e) => typeof FinalizationRegistry > "u" ? (W = (e) => e, e) : (Le = new FinalizationRegistry((e) => {
				console.warn(e.X), e = e.g, --e.count.value, e.count.value === 0 && (e.l ? e.v.B(e.l) : e.j.h.B(e.i));
			}), W = (e) => {
				var t = e.g;
				if (t.l) {
					var n = { g: t };
					t = Error(`Embind found a leaked C++ instance ${t.j.h.name} <${P(t.i)}>.
We'll free it automatically in this case, but this functionality is not reliable across various environments.
Make sure to invoke .delete() manually once you're done with the instance instead.
Originally allocated`), "captureStackTrace" in Error && Error.captureStackTrace(t, Ge), n.X = t.stack.replace(/^Error: /, ""), Le.register(e, n, e);
				}
				return e;
			}, Re = (e) => {
				Le.unregister(e);
			}, W(e)), Ke = [];
			function qe() {}
			var Je = (e, t) => Object.defineProperty(t, "name", { value: e }), Ye = (e, t, n) => {
				if (e[t].u === void 0) {
					var r = e[t];
					e[t] = function(...r) {
						if (!e[t].u.hasOwnProperty(r.length)) throw new H(`Function '${n}' called with an invalid number of arguments (${r.length}) - expects one of (${e[t].u})!`);
						return e[t].u[r.length].apply(this, r);
					}, e[t].u = [], e[t].u[r.C] = r;
				}
			}, Xe = (e, t) => {
				if (r.hasOwnProperty(e)) throw new H(`Cannot register public name '${e}' twice`);
				r[e] = t, r[e].C = void 0;
			}, Ze = (e) => {
				g(typeof e == "string"), e = e.replace(/[^a-zA-Z0-9_]/g, "$");
				var t = e.charCodeAt(0);
				return 48 <= t && 57 >= t ? `_${e}` : e;
			};
			function Qe(e, t, n, r, i, a, o, s) {
				this.name = e, this.constructor = t, this.A = n, this.B = r, this.m = i, this.T = a, this.H = o, this.R = s, this.Z = [];
			}
			var $e = (e, t, n) => {
				for (; t !== n;) {
					if (!t.H) throw new H(`Expected null or instance of ${n.name}, got an instance of ${t.name}`);
					e = t.H(e), t = t.m;
				}
				return e;
			};
			function et(e, t) {
				if (t === null) {
					if (this.L) throw new H(`null is not a valid ${this.name}`);
					return 0;
				}
				if (!t.g) throw new H(`Cannot pass "${R(t)}" as a ${this.name}`);
				if (!t.g.i) throw new H(`Cannot pass deleted object as a pointer of type ${this.name}`);
				return $e(t.g.i, t.g.j.h, this.h);
			}
			function tt(e, t) {
				if (t === null) {
					if (this.L) throw new H(`null is not a valid ${this.name}`);
					if (this.K) {
						var n = this.$();
						return e !== null && e.push(this.B, n), n;
					}
					return 0;
				}
				if (!t || !t.g) throw new H(`Cannot pass "${R(t)}" as a ${this.name}`);
				if (!t.g.i) throw new H(`Cannot pass deleted object as a pointer of type ${this.name}`);
				if (!this.J && t.g.j.J) throw new H(`Cannot convert argument of type ${t.g.v ? t.g.v.name : t.g.j.name} to parameter type ${this.name}`);
				if (n = $e(t.g.i, t.g.j.h, this.h), this.K) {
					if (t.g.l === void 0) throw new H("Passing raw pointer to smart pointer is illegal");
					switch (this.ba) {
						case 0:
							if (t.g.v === this) n = t.g.l;
							else throw new H(`Cannot convert argument of type ${t.g.v ? t.g.v.name : t.g.j.name} to parameter type ${this.name}`);
							break;
						case 1:
							n = t.g.l;
							break;
						case 2:
							if (t.g.v === this) n = t.g.l;
							else {
								var r = t.clone();
								n = this.aa(n, yt(() => r.delete())), e !== null && e.push(this.B, n);
							}
							break;
						default: throw new H("Unsupporting sharing policy");
					}
				}
				return n;
			}
			function nt(e, t) {
				if (t === null) {
					if (this.L) throw new H(`null is not a valid ${this.name}`);
					return 0;
				}
				if (!t.g) throw new H(`Cannot pass "${R(t)}" as a ${this.name}`);
				if (!t.g.i) throw new H(`Cannot pass deleted object as a pointer of type ${this.name}`);
				if (t.g.j.J) throw new H(`Cannot convert argument of type ${t.g.j.name} to parameter type ${this.name}`);
				return $e(t.g.i, t.g.j.h, this.h);
			}
			function rt(e) {
				return this.fromWireType(S[e >> 2]);
			}
			function it(e, t, n, r, i, a, o, s, c, l, u) {
				this.name = e, this.h = t, this.L = n, this.J = r, this.K = i, this.Y = a, this.ba = o, this.O = s, this.$ = c, this.aa = l, this.B = u, i || t.m !== void 0 ? this.toWireType = tt : (this.toWireType = r ? et : nt, this.s = null);
			}
			var at = (e, t) => {
				if (!r.hasOwnProperty(e)) throw new Ue("Replacing nonexistent public symbol");
				r[e] = t, r[e].C = void 0;
			}, ot = [], G = (e, t, n = !1) => {
				if (g(!n, "Async bindings are only supported with JSPI."), e = z(e), (n = ot[t]) || (ot[t] = n = I.get(t)), g(I.get(t) == n, "JavaScript-side Wasm function table mirror is out of date!"), typeof n != "function") throw new H(`unknown function pointer with signature ${e}: ${t}`);
				return n;
			};
			class st extends Error {}
			var ct = (e) => {
				e = Jt(e);
				var t = z(e);
				return $(e), t;
			}, K = (e, t) => {
				function n(e) {
					i[e] || V[e] || (Me[e] ? Me[e].forEach(n) : (r.push(e), i[e] = !0));
				}
				var r = [], i = {};
				throw t.forEach(n), new st(`${e}: ` + r.map(ct).join([", "]));
			}, q = (e, t, n) => {
				function r(t) {
					if (t = n(t), t.length !== e.length) throw new Ue("Mismatched type converter count");
					for (var r = 0; r < e.length; ++r) U(e[r], t[r]);
				}
				e.forEach((e) => Me[e] = t);
				var i = Array(t.length), a = [], o = 0;
				t.forEach((e, t) => {
					V.hasOwnProperty(e) ? i[t] = V[e] : (a.push(e), B.hasOwnProperty(e) || (B[e] = []), B[e].push(() => {
						i[t] = V[e], ++o, o === a.length && r(i);
					}));
				}), a.length === 0 && r(i);
			}, lt = (e) => {
				for (; e.length;) {
					var t = e.pop();
					e.pop()(t);
				}
			};
			function ut(e) {
				for (var t = 1; t < e.length; ++t) if (e[t] !== null && e[t].s === void 0) return !0;
				return !1;
			}
			function dt(e, t, n, r, i) {
				(e < t || e > n) && i(`function ${r} called with ${e} arguments, expected ${t == n ? t : `${t} to ${n}`}`);
			}
			function ft(e, t, n, r, i, a) {
				var o = t.length;
				if (2 > o) throw new H("argTypes array size mismatch! Must at least get return value and 'this' types!");
				g(!a, "Async bindings are only supported with JSPI.");
				var s = t[1] !== null && n !== null, c = ut(t);
				n = t[0].name !== "void";
				for (var l = o - 2, u = t.length - 2, d = t.length - 1; 2 <= d && t[d].optional; --d) u--;
				for (r = [
					e,
					Ne,
					r,
					i,
					lt,
					t[0],
					t[1]
				], i = 0; i < o - 2; ++i) r.push(t[i + 2]);
				if (!c) for (i = s ? 1 : 2; i < t.length; ++i) t[i].s !== null && r.push(t[i].s);
				for (r.push(dt, u, l), c = ut(t), l = t.length - 2, u = [], i = ["fn"], s && i.push("thisWired"), o = 0; o < l; ++o) u.push(`arg${o}`), i.push(`arg${o}Wired`);
				u = u.join(","), i = i.join(","), u = `return function (${u}) {
checkArgCount(arguments.length, minArgs, maxArgs, humanName, throwBindingError);
`, c && (u += "var destructors = [];\n");
				var f = c ? "destructors" : "null";
				for (d = "humanName throwBindingError invoker fn runDestructors retType classParam".split(" "), s && (u += `var thisWired = classParam['toWireType'](${f}, this);
`), o = 0; o < l; ++o) u += `var arg${o}Wired = argType${o}['toWireType'](${f}, arg${o});
`, d.push(`argType${o}`);
				if (u += (n || a ? "var rv = " : "") + `invoker(${i});
`, c) u += "runDestructors(destructors);\n";
				else for (o = s ? 1 : 2; o < t.length; ++o) a = o === 1 ? "thisWired" : "arg" + (o - 2) + "Wired", t[o].s !== null && (u += `${a}_dtor(${a});
`, d.push(`${a}_dtor`));
				n && (u += "var ret = retType['fromWireType'](rv);\nreturn ret;\n"), u += "}\n", d.push("checkArgCount", "minArgs", "maxArgs"), u = `if (arguments.length !== ${d.length}){ throw new Error(humanName + "Expected ${d.length} closure arguments " + arguments.length + " given."); }
${u}`;
				let [p, m] = [d, u];
				return t = Function(...p, m)(...r), Je(e, t);
			}
			for (var pt = (e, t) => {
				for (var n = [], r = 0; r < e; r++) n.push(S[t + 4 * r >> 2]);
				return n;
			}, mt = (e) => {
				e = e.trim();
				let t = e.indexOf("(");
				return t === -1 ? e : (g(e.endsWith(")"), "Parentheses for argument names should match."), e.slice(0, t));
			}, ht = (e, t, n) => {
				if (!(e instanceof Object)) throw new H(`${n} with invalid "this": ${e}`);
				if (!(e instanceof t.h.constructor)) throw new H(`${n} incompatible with "this" of type ${e.constructor.name}`);
				if (!e.g.i) throw new H(`cannot call emscripten binding method ${n} on deleted object`);
				return $e(e.g.i, e.g.j.h, t.h);
			}, gt = [], J = [], _t = (e) => {
				9 < e && --J[e + 1] === 0 && (g(J[e] !== void 0, "Decref for unallocated handle."), J[e] = void 0, gt.push(e));
			}, vt = (e) => {
				if (!e) throw new H(`Cannot use deleted val. handle = ${e}`);
				return g(e === 2 || J[e] !== void 0 && e % 2 == 0, `invalid handle: ${e}`), J[e];
			}, yt = (e) => {
				switch (e) {
					case void 0: return 2;
					case null: return 4;
					case !0: return 6;
					case !1: return 8;
					default:
						let t = gt.pop() || J.length;
						return J[t] = e, J[t + 1] = 1, t;
				}
			}, bt = {
				name: "emscripten::val",
				fromWireType: (e) => {
					var t = vt(e);
					return _t(e), t;
				},
				toWireType: (e, t) => yt(t),
				o: 8,
				readValueFromPointer: rt,
				s: null
			}, xt = (e, t, n) => {
				switch (t) {
					case 1: return n ? function(e) {
						return this.fromWireType(_[e]);
					} : function(e) {
						return this.fromWireType(v[e]);
					};
					case 2: return n ? function(e) {
						return this.fromWireType(y[e >> 1]);
					} : function(e) {
						return this.fromWireType(b[e >> 1]);
					};
					case 4: return n ? function(e) {
						return this.fromWireType(x[e >> 2]);
					} : function(e) {
						return this.fromWireType(S[e >> 2]);
					};
					default: throw TypeError(`invalid integer width (${t}): ${e}`);
				}
			}, St = (e, t) => {
				var n = V[e];
				if (n === void 0) throw e = `${t} has unknown type ${ct(e)}`, new H(e);
				return n;
			}, Ct = (e, t) => {
				switch (t) {
					case 4: return function(e) {
						return this.fromWireType(ee[e >> 2]);
					};
					case 8: return function(e) {
						return this.fromWireType(ne[e >> 3]);
					};
					default: throw TypeError(`invalid float width (${t}): ${e}`);
				}
			}, wt = Object.assign({ optional: !0 }, bt), Y = (e, t, n) => {
				g(typeof n == "number", "stringToUTF8(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!");
				var r = v;
				if (g(typeof e == "string", `stringToUTF8Array expects a string (got ${typeof e})`), 0 < n) {
					var i = t;
					n = t + n - 1;
					for (var a = 0; a < e.length; ++a) {
						var o = e.charCodeAt(a);
						if (55296 <= o && 57343 >= o) {
							var s = e.charCodeAt(++a);
							o = 65536 + ((o & 1023) << 10) | s & 1023;
						}
						if (127 >= o) {
							if (t >= n) break;
							r[t++] = o;
						} else {
							if (2047 >= o) {
								if (t + 1 >= n) break;
								r[t++] = 192 | o >> 6;
							} else {
								if (65535 >= o) {
									if (t + 2 >= n) break;
									r[t++] = 224 | o >> 12;
								} else {
									if (t + 3 >= n) break;
									1114111 < o && F("Invalid Unicode code point " + P(o) + " encountered when serializing a JS string to a UTF-8 string in wasm memory! (Valid unicode code points should be in range 0-0x10FFFF)."), r[t++] = 240 | o >> 18, r[t++] = 128 | o >> 12 & 63;
								}
								r[t++] = 128 | o >> 6 & 63;
							}
							r[t++] = 128 | o & 63;
						}
					}
					r[t] = 0, e = t - i;
				} else e = 0;
				return e;
			}, Tt = (e) => {
				for (var t = 0, n = 0; n < e.length; ++n) {
					var r = e.charCodeAt(n);
					127 >= r ? t++ : 2047 >= r ? t += 2 : 55296 <= r && 57343 >= r ? (t += 4, ++n) : t += 3;
				}
				return t;
			}, Et = typeof TextDecoder < "u" ? new TextDecoder("utf-16le") : void 0, Dt = (e, t) => {
				g(e % 2 == 0, "Pointer passed to UTF16ToString must be aligned to two bytes!");
				for (var n = e >> 1, r = n + t / 2; !(n >= r) && b[n];) ++n;
				if (n <<= 1, 32 < n - e && Et) return Et.decode(v.subarray(e, n));
				for (n = "", r = 0; !(r >= t / 2); ++r) {
					var i = y[e + 2 * r >> 1];
					if (i == 0) break;
					n += String.fromCharCode(i);
				}
				return n;
			}, Ot = (e, t, n) => {
				if (g(t % 2 == 0, "Pointer passed to stringToUTF16 must be aligned to two bytes!"), g(typeof n == "number", "stringToUTF16(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!"), n ??= 2147483647, 2 > n) return 0;
				n -= 2;
				var r = t;
				n = n < 2 * e.length ? n / 2 : e.length;
				for (var i = 0; i < n; ++i) y[t >> 1] = e.charCodeAt(i), t += 2;
				return y[t >> 1] = 0, t - r;
			}, kt = (e) => 2 * e.length, At = (e, t) => {
				g(e % 4 == 0, "Pointer passed to UTF32ToString must be aligned to four bytes!");
				for (var n = 0, r = ""; !(n >= t / 4);) {
					var i = x[e + 4 * n >> 2];
					if (i == 0) break;
					++n, 65536 <= i ? (i -= 65536, r += String.fromCharCode(55296 | i >> 10, 56320 | i & 1023)) : r += String.fromCharCode(i);
				}
				return r;
			}, jt = (e, t, n) => {
				if (g(t % 4 == 0, "Pointer passed to stringToUTF32 must be aligned to four bytes!"), g(typeof n == "number", "stringToUTF32(str, outPtr, maxBytesToWrite) is missing the third parameter that specifies the length of the output buffer!"), n ??= 2147483647, 4 > n) return 0;
				var r = t;
				n = r + n - 4;
				for (var i = 0; i < e.length; ++i) {
					var a = e.charCodeAt(i);
					if (55296 <= a && 57343 >= a) {
						var o = e.charCodeAt(++i);
						a = 65536 + ((a & 1023) << 10) | o & 1023;
					}
					if (x[t >> 2] = a, t += 4, t + 4 > n) break;
				}
				return x[t >> 2] = 0, t - r;
			}, Mt = (e) => {
				for (var t = 0, n = 0; n < e.length; ++n) {
					var r = e.charCodeAt(n);
					55296 <= r && 57343 >= r && ++n, t += 4;
				}
				return t;
			}, X = 0, Nt = [], Pt = (e) => {
				var t = Nt.length;
				return Nt.push(e), t;
			}, Ft = (e, t) => {
				for (var n = Array(e), r = 0; r < e; ++r) n[r] = St(S[t + 4 * r >> 2], `parameter ${r}`);
				return n;
			}, It = (e, t, n) => {
				var r = [];
				return e = e.toWireType(r, n), r.length && (S[t >> 2] = yt(r)), e;
			}, Z = {}, Lt = (e) => {
				if (!(e instanceof Se || e == "unwind")) throw E(), e instanceof WebAssembly.RuntimeError && 0 >= an() && d("Stack overflow detected.  You can try increasing -sSTACK_SIZE (currently set to 65536)"), e;
			}, Rt = (e) => {
				throw h = e, N || 0 < X || (r.onExit?.(e), m = !0), new Se(e);
			}, zt = (e) => {
				if (T || m) d("user callback triggered after runtime exited or application aborted.  Ignoring.");
				else try {
					if (e(), !(T || N || 0 < X)) try {
						if (h = e = h, N || 0 < X || (g(!T), E(), Zt(), Xt(0), Ut[1].length && Wt(1, 10), Ut[2].length && Wt(2, 10), T = !0), N || 0 < X) {
							var t = `program exited (with status: ${e}), but keepRuntimeAlive() is set (counter=${X}) due to an async operation, so halting execution but not exiting the runtime or preventing further async execution (you can use emscripten_force_exit, if you want to force a true shutdown)`;
							a(t), d(t);
						}
						Rt(e);
					} catch (e) {
						Lt(e);
					}
				} catch (e) {
					Lt(e);
				}
			}, Bt = {}, Vt = () => {
				if (!Ht) {
					var e = {
						USER: "web_user",
						LOGNAME: "web_user",
						PATH: "/",
						PWD: "/",
						HOME: "/home/web_user",
						LANG: (typeof navigator == "object" && navigator.languages && navigator.languages[0] || "C").replace("-", "_") + ".UTF-8",
						_: s || "./this.program"
					}, t;
					for (t in Bt) Bt[t] === void 0 ? delete e[t] : e[t] = Bt[t];
					var n = [];
					for (t in e) n.push(`${t}=${e[t]}`);
					Ht = n;
				}
				return Ht;
			}, Ht, Ut = [
				null,
				[],
				[]
			], Wt = (e, t) => {
				var n = Ut[e];
				g(n), t === 0 || t === 10 ? ((e === 1 ? u : d)(Oe(n)), n.length = 0) : n.push(t);
			}, Gt = Array(256), Kt = 0; 256 > Kt; ++Kt) Gt[Kt] = String.fromCharCode(Kt);
			je = Gt, (() => {
				let e = qe.prototype;
				Object.assign(e, {
					isAliasOf: function(e) {
						if (!(this instanceof qe && e instanceof qe)) return !1;
						var t = this.g.j.h, n = this.g.i;
						e.g = e.g;
						var r = e.g.j.h;
						for (e = e.g.i; t.m;) n = t.H(n), t = t.m;
						for (; r.m;) e = r.H(e), r = r.m;
						return t === r && n === e;
					},
					clone: function() {
						if (this.g.i || Ie(this), this.g.G) return this.g.count.value += 1, this;
						var e = W, t = Object, n = t.create, r = Object.getPrototypeOf(this), i = this.g;
						return e = e(n.call(t, r, { g: { value: {
							count: i.count,
							F: i.F,
							G: i.G,
							i: i.i,
							j: i.j,
							l: i.l,
							v: i.v
						} } })), e.g.count.value += 1, e.g.F = !1, e;
					},
					delete() {
						if (this.g.i || Ie(this), this.g.F && !this.g.G) throw new H("Object already scheduled for deletion");
						Re(this);
						var e = this.g;
						--e.count.value, e.count.value === 0 && (e.l ? e.v.B(e.l) : e.j.h.B(e.i)), this.g.G || (this.g.l = void 0, this.g.i = void 0);
					},
					isDeleted: function() {
						return !this.g.i;
					},
					deleteLater: function() {
						if (this.g.i || Ie(this), this.g.F && !this.g.G) throw new H("Object already scheduled for deletion");
						return Ke.push(this), this.g.F = !0, this;
					}
				});
				let t = Symbol.dispose;
				t && (e[t] = e.delete);
			})(), Object.assign(it.prototype, {
				U(e) {
					return this.O && (e = this.O(e)), e;
				},
				N(e) {
					this.B?.(e);
				},
				o: 8,
				readValueFromPointer: rt,
				fromWireType: Ge
			}), J.push(0, 1, void 0, 1, null, 1, !0, 1, !1, 1), g(J.length === 10), r.count_emval_handles = () => J.length / 2 - 5 - gt.length, r.noExitRuntime && (N = r.noExitRuntime), r.print && (u = r.print), r.printErr && (d = r.printErr), r.wasmBinary && (f = r.wasmBinary), r.FS_createDataFile = function() {
				he();
			}, r.FS_createPreloadedFile = function() {
				he();
			}, Object.getOwnPropertyDescriptor(r, "fetchSettings") && A("`Module.fetchSettings` was supplied but `fetchSettings` not included in INCOMING_MODULE_JS_API"), r.thisProgram && (s = r.thisProgram), g(typeof r.memoryInitializerPrefixURL > "u", "Module.memoryInitializerPrefixURL option was removed, use Module.locateFile instead"), g(typeof r.pthreadMainPrefixURL > "u", "Module.pthreadMainPrefixURL option was removed, use Module.locateFile instead"), g(typeof r.cdInitializerPrefixURL > "u", "Module.cdInitializerPrefixURL option was removed, use Module.locateFile instead"), g(typeof r.filePackagePrefixURL > "u", "Module.filePackagePrefixURL option was removed, use Module.locateFile instead"), g(typeof r.read > "u", "Module.read option was removed"), g(typeof r.readAsync > "u", "Module.readAsync option was removed (modify readAsync in JS)"), g(typeof r.readBinary > "u", "Module.readBinary option was removed (modify readBinary in JS)"), g(typeof r.setWindowTitle > "u", "Module.setWindowTitle option was removed (modify emscripten_set_window_title in JS)"), g(typeof r.TOTAL_MEMORY > "u", "Module.TOTAL_MEMORY has been renamed Module.INITIAL_MEMORY"), g(typeof r.ENVIRONMENT > "u", "Module.ENVIRONMENT has been deprecated. To force the environment, use the ENVIRONMENT compile-time option (for example, -sENVIRONMENT=web or -sENVIRONMENT=node)"), g(typeof r.STACK_SIZE > "u", "STACK_SIZE can no longer be set at runtime.  Use -sSTACK_SIZE at link time"), g(typeof r.wasmMemory > "u", "Use of `wasmMemory` detected.  Use -sIMPORTED_MEMORY to define wasmMemory externally"), g(typeof r.INITIAL_MEMORY > "u", "Detected runtime INITIAL_MEMORY setting.  Use -sIMPORTED_MEMORY to define wasmMemory dynamically"), "writeI53ToI64 writeI53ToI64Clamped writeI53ToI64Signaling writeI53ToU64Clamped writeI53ToU64Signaling readI53FromI64 readI53FromU64 convertI32PairToI53 convertI32PairToI53Checked convertU32PairToI53 getTempRet0 setTempRet0 zeroMemory strError inetPton4 inetNtop4 inetPton6 inetNtop6 readSockaddr writeSockaddr emscriptenLog readEmAsmArgs jstoi_q listenOnce autoResumeAudioContext getDynCaller dynCall runtimeKeepalivePush runtimeKeepalivePop asmjsMangle asyncLoad mmapAlloc HandleAllocator getNativeTypeSize addOnInit addOnPostCtor addOnPreMain addOnExit STACK_SIZE STACK_ALIGN POINTER_SIZE ASSERTIONS getCFunc ccall cwrap uleb128Encode sigToWasmTypes generateFuncType convertJsFunctionToWasm getEmptyTableSlot updateTableMap getFunctionAddress addFunction removeFunction reallyNegative unSign strLen reSign formatString intArrayFromString intArrayToString AsciiToString stringToAscii stringToNewUTF8 stringToUTF8OnStack writeArrayToMemory registerKeyEventCallback maybeCStringToJsString findEventTarget getBoundingClientRect fillMouseEventData registerMouseEventCallback registerWheelEventCallback registerUiEventCallback registerFocusEventCallback fillDeviceOrientationEventData registerDeviceOrientationEventCallback fillDeviceMotionEventData registerDeviceMotionEventCallback screenOrientation fillOrientationChangeEventData registerOrientationChangeEventCallback fillFullscreenChangeEventData registerFullscreenChangeEventCallback JSEvents_requestFullscreen JSEvents_resizeCanvasForFullscreen registerRestoreOldStyle hideEverythingExceptGivenElement restoreHiddenElements setLetterbox softFullscreenResizeWebGLRenderTarget doRequestFullscreen fillPointerlockChangeEventData registerPointerlockChangeEventCallback registerPointerlockErrorEventCallback requestPointerLock fillVisibilityChangeEventData registerVisibilityChangeEventCallback registerTouchEventCallback fillGamepadEventData registerGamepadEventCallback registerBeforeUnloadEventCallback fillBatteryEventData battery registerBatteryEventCallback setCanvasElementSize getCanvasElementSize jsStackTrace getCallstack convertPCtoSourceLocation wasiRightsToMuslOFlags wasiOFlagsToMuslOFlags initRandomFill randomFill safeSetTimeout setImmediateWrapped safeRequestAnimationFrame clearImmediateWrapped registerPostMainLoop registerPreMainLoop getPromise makePromise idsToPromises makePromiseCallback Browser_asyncPrepareDataCounter isLeapYear ydayFromDate arraySum addDays getSocketFromFD getSocketAddress heapObjectForWebGLType toTypedArrayIndex webgl_enable_ANGLE_instanced_arrays webgl_enable_OES_vertex_array_object webgl_enable_WEBGL_draw_buffers webgl_enable_WEBGL_multi_draw webgl_enable_EXT_polygon_offset_clamp webgl_enable_EXT_clip_control webgl_enable_WEBGL_polygon_mode emscriptenWebGLGet computeUnpackAlignedImageSize colorChannelsInGlTextureFormat emscriptenWebGLGetTexPixelData emscriptenWebGLGetUniform webglGetUniformLocation webglPrepareUniformLocationsBeforeFirstUse webglGetLeftBracePos emscriptenWebGLGetVertexAttrib __glGetActiveAttribOrUniform writeGLArray registerWebGlEventCallback runAndAbortIfError ALLOC_NORMAL ALLOC_STACK allocate writeStringToMemory writeAsciiToMemory demangle stackTrace getFunctionArgsName createJsInvokerSignature PureVirtualError registerInheritedInstance unregisterInheritedInstance getInheritedInstanceCount getLiveInheritedInstances setDelayFunction getStringOrSymbol emval_get_global".split(" ").forEach(function(e) {
				ce(e, () => {
					var t = `\`${e}\` is a library symbol and not included by default; add it to your library.js __deps or to DEFAULT_LIBRARY_FUNCS_TO_INCLUDE on the command line`, n = e;
					n.startsWith("_") || (n = "$" + e), t += ` (e.g. -sDEFAULT_LIBRARY_FUNCS_TO_INCLUDE='${n}')`, se(e) && (t += ". Alternatively, forcing filesystem support (-sFORCE_FILESYSTEM) can export this for you"), F(t);
				}), ue(e);
			}), "run addRunDependency removeRunDependency out err callMain abort wasmMemory wasmExports HEAPF32 HEAPF64 HEAP8 HEAPU8 HEAP16 HEAPU16 HEAP32 HEAPU32 HEAP64 HEAPU64 writeStackCookie checkStackCookie INT53_MAX INT53_MIN bigintToI53Checked stackSave stackRestore stackAlloc ptrToString exitJS getHeapMax growMemory ENV ERRNO_CODES DNS Protocols Sockets timers warnOnce readEmAsmArgsArray jstoi_s getExecutableName handleException keepRuntimeAlive callUserCallback maybeExit alignMemory wasmTable noExitRuntime addOnPreRun addOnPostRun freeTableIndexes functionsInTableMap setValue getValue PATH PATH_FS UTF8Decoder UTF8ArrayToString UTF8ToString stringToUTF8Array stringToUTF8 lengthBytesUTF8 UTF16Decoder UTF16ToString stringToUTF16 lengthBytesUTF16 UTF32ToString stringToUTF32 lengthBytesUTF32 JSEvents specialHTMLTargets findCanvasEventTarget currentFullscreenStrategy restoreOldWindowedStyle UNWIND_CACHE ExitStatus getEnvStrings checkWasiClock flush_NO_FILESYSTEM emSetImmediate emClearImmediate_deps emClearImmediate promiseMap getExceptionMessageCommon getCppExceptionTag getCppExceptionThrownObjectFromWebAssemblyException Browser getPreloadedImageData__data wget MONTH_DAYS_REGULAR MONTH_DAYS_LEAP MONTH_DAYS_REGULAR_CUMULATIVE MONTH_DAYS_LEAP_CUMULATIVE SYSCALLS tempFixedLengthArray miniTempWebGLFloatBuffers miniTempWebGLIntBuffers GL AL GLUT EGL GLEW IDBStore SDL SDL_gfx allocateUTF8 allocateUTF8OnStack print printErr InternalError BindingError throwInternalError throwBindingError registeredTypes awaitingDependencies typeDependencies tupleRegistrations structRegistrations sharedRegisterType whenDependentTypesAreResolved embind_charCodes embind_init_charCodes readLatin1String getTypeName getFunctionName heap32VectorToArray requireRegisteredType usesDestructorStack checkArgCount getRequiredArgCount createJsInvoker UnboundTypeError GenericWireTypeSize EmValType EmValOptionalType throwUnboundTypeError ensureOverloadTable exposePublicSymbol replacePublicSymbol createNamedFunction embindRepr registeredInstances getBasestPointer getInheritedInstance registeredPointers registerType integerReadValueFromPointer enumReadValueFromPointer floatReadValueFromPointer readPointer runDestructors craftInvokerFunction embind__requireFunction genericPointerToWireType constNoSmartPtrRawPointerToWireType nonConstNoSmartPtrRawPointerToWireType init_RegisteredPointer RegisteredPointer RegisteredPointer_fromWireType runDestructor releaseClassHandle finalizationRegistry detachFinalizer_deps detachFinalizer attachFinalizer makeClassHandle init_ClassHandle ClassHandle throwInstanceAlreadyDeleted deletionQueue flushPendingDeletes delayFunction RegisteredClass shallowCopyInternalPointer downcastPointer upcastPointer validateThis char_0 char_9 makeLegalFunctionName emval_freelist emval_handles emval_symbols init_emval count_emval_handles Emval emval_returnValue emval_lookupTypes emval_methodCallers emval_addMethodCaller reflectConstruct".split(" ").forEach(ue), r.getExceptionMessage = Ae, r.incrementExceptionRefcount = (e) => {
				e = ke(e), sn(e);
			}, r.decrementExceptionRefcount = (e) => {
				e = ke(e), on(e);
			};
			var qt = {
				__assert_fail: (e, t, n, r) => A(`Assertion failed: ${L(e)}, at: ` + [
					t ? L(t) : "unknown filename",
					n,
					r ? L(r) : "unknown function"
				]),
				__throw_exception_with_stack_trace: (e) => {
					throw e = new WebAssembly.Exception(Q.__cpp_exception, [e], { traceStack: !0 }), e.message = Ae(e), e;
				},
				_abort_js: () => A("native code called abort()"),
				_embind_register_bigint: (e, t, n, r, i) => {
					t = z(t);
					var a = t.indexOf("u") != -1;
					a && (i = (1n << 64n) - 1n), U(e, {
						name: t,
						fromWireType: (e) => e,
						toWireType: function(e, n) {
							if (typeof n != "bigint" && typeof n != "number") throw TypeError(`Cannot convert "${R(n)}" to ${this.name}`);
							if (typeof n == "number" && (n = BigInt(n)), n < r || n > i) throw TypeError(`Passing a number "${R(n)}" from JS side to C/C++ side to an argument of type "${t}", which is outside the valid range [${r}, ${i}]!`);
							return n;
						},
						o: 8,
						readValueFromPointer: Fe(t, n, !a),
						s: null
					});
				},
				_embind_register_bool: (e, t, n, r) => {
					t = z(t), U(e, {
						name: t,
						fromWireType: function(e) {
							return !!e;
						},
						toWireType: function(e, t) {
							return t ? n : r;
						},
						o: 8,
						readValueFromPointer: function(e) {
							return this.fromWireType(v[e]);
						},
						s: null
					});
				},
				_embind_register_class: (e, t, n, r, i, a, o, s, c, l, u, d, f) => {
					u = z(u), a = G(i, a), s &&= G(o, s), l &&= G(c, l), f = G(d, f);
					var p = Ze(u);
					Xe(p, function() {
						K(`Cannot construct ${u} due to unbound types`, [r]);
					}), q([
						e,
						t,
						n
					], r ? [r] : [], (t) => {
						if (t = t[0], r) var n = t.h, i = n.A;
						else i = qe.prototype;
						t = Je(u, function(...e) {
							if (Object.getPrototypeOf(this) !== o) throw new H(`Use 'new' to construct ${u}`);
							if (c.D === void 0) throw new H(`${u} has no accessible constructor`);
							var t = c.D[e.length];
							if (t === void 0) throw new H(`Tried to invoke ctor of ${u} with invalid number of parameters (${e.length}) - expected (${Object.keys(c.D).toString()}) parameters instead!`);
							return t.apply(this, e);
						});
						var o = Object.create(i, { constructor: { value: t } });
						t.prototype = o;
						var c = new Qe(u, t, o, f, n, a, s, l);
						if (c.m) {
							var d;
							(d = c.m).I ?? (d.I = []), c.m.I.push(c);
						}
						return n = new it(u, c, !0, !1, !1), d = new it(u + "*", c, !1, !1, !1), i = new it(u + " const*", c, !1, !0, !1), Be[e] = {
							pointerType: d,
							P: i
						}, at(p, t), [
							n,
							d,
							i
						];
					});
				},
				_embind_register_class_class_function: (e, t, n, r, i, a, o, s) => {
					var c = pt(n, r);
					t = z(t), t = mt(t), a = G(i, a, s), q([], [e], (e) => {
						function r() {
							K(`Cannot call ${i} due to unbound types`, c);
						}
						e = e[0];
						var i = `${e.name}.${t}`;
						t.startsWith("@@") && (t = Symbol[t.substring(2)]);
						var l = e.h.constructor;
						return l[t] === void 0 ? (r.C = n - 1, l[t] = r) : (Ye(l, t, i), l[t].u[n - 1] = r), q([], c, (r) => {
							if (r = ft(i, [r[0], null].concat(r.slice(1)), null, a, o, s), l[t].u === void 0 ? (r.C = n - 1, l[t] = r) : l[t].u[n - 1] = r, e.h.I) for (let n of e.h.I) n.constructor.hasOwnProperty(t) || (n.constructor[t] = r);
							return [];
						}), [];
					});
				},
				_embind_register_class_constructor: (e, t, n, r, i, a) => {
					g(0 < t);
					var o = pt(t, n);
					i = G(r, i), q([], [e], (e) => {
						e = e[0];
						var n = `constructor ${e.name}`;
						if (e.h.D === void 0 && (e.h.D = []), e.h.D[t - 1] !== void 0) throw new H(`Cannot register multiple constructors with identical number of parameters (${t - 1}) for class '${e.name}'! Overload resolution is currently only performed using the parameter count, not actual type info!`);
						return e.h.D[t - 1] = () => {
							K(`Cannot construct ${e.name} due to unbound types`, o);
						}, q([], o, (r) => (r.splice(1, 0, null), e.h.D[t - 1] = ft(n, r, null, i, a), [])), [];
					});
				},
				_embind_register_class_function: (e, t, n, r, i, a, o, s, c) => {
					var l = pt(n, r);
					t = z(t), t = mt(t), a = G(i, a, c), q([], [e], (e) => {
						function r() {
							K(`Cannot call ${i} due to unbound types`, l);
						}
						e = e[0];
						var i = `${e.name}.${t}`;
						t.startsWith("@@") && (t = Symbol[t.substring(2)]), s && e.h.Z.push(t);
						var u = e.h.A, d = u[t];
						return d === void 0 || d.u === void 0 && d.className !== e.name && d.C === n - 2 ? (r.C = n - 2, r.className = e.name, u[t] = r) : (Ye(u, t, i), u[t].u[n - 2] = r), q([], l, (r) => (r = ft(i, r, e, a, o, c), u[t].u === void 0 ? (r.C = n - 2, u[t] = r) : u[t].u[n - 2] = r, [])), [];
					});
				},
				_embind_register_class_property: (e, t, n, r, i, a, o, s, c, l) => {
					t = z(t), i = G(r, i), q([], [e], (e) => {
						e = e[0];
						var r = `${e.name}.${t}`, u = {
							get() {
								K(`Cannot access ${r} due to unbound types`, [n, o]);
							},
							enumerable: !0,
							configurable: !0
						};
						return u.set = c ? () => K(`Cannot access ${r} due to unbound types`, [n, o]) : () => {
							throw new H(r + " is a read-only property");
						}, Object.defineProperty(e.h.A, t, u), q([], c ? [n, o] : [n], (n) => {
							var o = n[0], u = {
								get() {
									var t = ht(this, e, r + " getter");
									return o.fromWireType(i(a, t));
								},
								enumerable: !0
							};
							if (c) {
								c = G(s, c);
								var d = n[1];
								u.set = function(t) {
									var n = ht(this, e, r + " setter"), i = [];
									c(l, n, d.toWireType(i, t)), lt(i);
								};
							}
							return Object.defineProperty(e.h.A, t, u), [];
						}), [];
					});
				},
				_embind_register_emval: (e) => U(e, bt),
				_embind_register_enum: (e, t, n, r) => {
					function i() {}
					t = z(t), i.values = {}, U(e, {
						name: t,
						constructor: i,
						fromWireType: function(e) {
							return this.constructor.values[e];
						},
						toWireType: (e, t) => t.value,
						o: 8,
						readValueFromPointer: xt(t, n, r),
						s: null
					}), Xe(t, i);
				},
				_embind_register_enum_value: (e, t, n) => {
					var r = St(e, "enum");
					t = z(t), e = r.constructor, r = Object.create(r.constructor.prototype, {
						value: { value: n },
						constructor: { value: Je(`${r.name}_${t}`, function() {}) }
					}), e.values[n] = r, e[t] = r;
				},
				_embind_register_float: (e, t, n) => {
					t = z(t), U(e, {
						name: t,
						fromWireType: (e) => e,
						toWireType: (e, t) => {
							if (typeof t != "number" && typeof t != "boolean") throw TypeError(`Cannot convert ${R(t)} to ${this.name}`);
							return t;
						},
						o: 8,
						readValueFromPointer: Ct(t, n),
						s: null
					});
				},
				_embind_register_integer: (e, t, n, r, i) => {
					t = z(t), i === -1 && (i = 4294967295);
					var a = (e) => e;
					if (r === 0) {
						var o = 32 - 8 * n;
						a = (e) => e << o >>> o;
					}
					var s = (e, n) => {
						if (typeof e != "number" && typeof e != "boolean") throw TypeError(`Cannot convert "${R(e)}" to ${n}`);
						if (e < r || e > i) throw TypeError(`Passing a number "${R(e)}" from JS side to C/C++ side to an argument of type "${t}", which is outside the valid range [${r}, ${i}]!`);
					}, c = t.includes("unsigned") ? function(e, t) {
						return s(t, this.name), t >>> 0;
					} : function(e, t) {
						return s(t, this.name), t;
					};
					U(e, {
						name: t,
						fromWireType: a,
						toWireType: c,
						o: 8,
						readValueFromPointer: Fe(t, n, r !== 0),
						s: null
					});
				},
				_embind_register_memory_view: (e, t, n) => {
					function r(e) {
						return new i(_.buffer, S[e + 4 >> 2], S[e >> 2]);
					}
					var i = [
						Int8Array,
						Uint8Array,
						Int16Array,
						Uint16Array,
						Int32Array,
						Uint32Array,
						Float32Array,
						Float64Array,
						BigInt64Array,
						BigUint64Array
					][t];
					n = z(n), U(e, {
						name: n,
						fromWireType: r,
						o: 8,
						readValueFromPointer: r
					}, { V: !0 });
				},
				_embind_register_optional: (e) => {
					U(e, wt);
				},
				_embind_register_std_string: (e, t) => {
					t = z(t), U(e, {
						name: t,
						fromWireType: function(e) {
							for (var t = S[e >> 2], n = e + 4, r, i = n, a = 0; a <= t; ++a) {
								var o = n + a;
								(a == t || v[o] == 0) && (i = L(i, o - i), r === void 0 ? r = i : (r += "\0", r += i), i = o + 1);
							}
							return $(e), r;
						},
						toWireType: function(e, t) {
							t instanceof ArrayBuffer && (t = new Uint8Array(t));
							var n = typeof t == "string";
							if (!(n || ArrayBuffer.isView(t) && t.BYTES_PER_ELEMENT == 1)) throw new H("Cannot pass non-string to std::string");
							var r = n ? Tt(t) : t.length, i = Yt(4 + r + 1), a = i + 4;
							return S[i >> 2] = r, n ? Y(t, a, r + 1) : v.set(t, a), e !== null && e.push($, i), i;
						},
						o: 8,
						readValueFromPointer: rt,
						s(e) {
							$(e);
						}
					});
				},
				_embind_register_std_wstring: (e, t, n) => {
					if (n = z(n), t === 2) var r = Dt, i = Ot, a = kt, o = (e) => b[e >> 1];
					else t === 4 && (r = At, i = jt, a = Mt, o = (e) => S[e >> 2]);
					U(e, {
						name: n,
						fromWireType: (e) => {
							for (var n = S[e >> 2], i, a = e + 4, s = 0; s <= n; ++s) {
								var c = e + 4 + s * t;
								(s == n || o(c) == 0) && (a = r(a, c - a), i === void 0 ? i = a : (i += "\0", i += a), a = c + t);
							}
							return $(e), i;
						},
						toWireType: (e, r) => {
							if (typeof r != "string") throw new H(`Cannot pass non-string to C++ string type ${n}`);
							var o = a(r), s = Yt(4 + o + t);
							return S[s >> 2] = o / t, i(r, s + 4, o + t), e !== null && e.push($, s), s;
						},
						o: 8,
						readValueFromPointer: rt,
						s(e) {
							$(e);
						}
					});
				},
				_embind_register_void: (e, t) => {
					t = z(t), U(e, {
						W: !0,
						name: t,
						o: 0,
						fromWireType: () => {},
						toWireType: () => {}
					});
				},
				_emscripten_runtime_keepalive_clear: () => {
					N = !1, X = 0;
				},
				_emval_call: (e, t, n, r) => (e = Nt[e], t = vt(t), e(null, t, n, r)),
				_emval_decref: _t,
				_emval_get_method_caller: (e, t, n) => {
					t = Ft(e, t);
					var r = t.shift();
					e--;
					var i = "return function (obj, func, destructorsRef, args) {\n", a = 0, o = [];
					n === 0 && o.push("obj");
					for (var s = ["retType"], c = [r], l = 0; l < e; ++l) o.push(`arg${l}`), s.push(`argType${l}`), c.push(t[l]), i += `  var arg${l} = argType${l}.readValueFromPointer(args${a ? "+" + a : ""});
`, a += t[l].o;
					return i += `  var rv = ${n === 1 ? "new func" : "func.call"}(${o.join(", ")});
`, r.W || (s.push("emval_returnValue"), c.push(It), i += "  return emval_returnValue(retType, destructorsRef, rv);\n"), e = Function(...s, i + "};\n")(...c), n = `methodCaller<(${t.map((e) => e.name).join(", ")}) => ${r.name}>`, Pt(Je(n, e));
				},
				_emval_incref: (e) => {
					9 < e && (J[e + 1] += 1);
				},
				_emval_run_destructors: (e) => {
					lt(vt(e)), _t(e);
				},
				_emval_take_value: (e, t) => (e = St(e, "_emval_take_value"), e = e.readValueFromPointer(t), yt(e)),
				_setitimer_js: (e, t) => (Z[e] && (clearTimeout(Z[e].id), delete Z[e]), t && (Z[e] = {
					id: setTimeout(() => {
						g(e in Z), delete Z[e], zt(() => $t(e, performance.now()));
					}, t),
					da: t
				}), 0),
				_tzset_js: (e, t, n, r) => {
					var i = (/* @__PURE__ */ new Date()).getFullYear(), a = new Date(i, 0, 1).getTimezoneOffset();
					i = new Date(i, 6, 1).getTimezoneOffset(), S[e >> 2] = 60 * Math.max(a, i), x[t >> 2] = +(a != i), t = (e) => {
						var t = Math.abs(e);
						return `UTC${0 <= e ? "-" : "+"}${String(Math.floor(t / 60)).padStart(2, "0")}${String(t % 60).padStart(2, "0")}`;
					}, e = t(a), t = t(i), g(e), g(t), g(16 >= Tt(e), `timezone name truncated to fit in TZNAME_MAX (${e})`), g(16 >= Tt(t), `timezone name truncated to fit in TZNAME_MAX (${t})`), i < a ? (Y(e, n, 17), Y(t, r, 17)) : (Y(e, r, 17), Y(t, n, 17));
				},
				clock_time_get: function(e, t, n) {
					return 0 <= e && 3 >= e ? (C[n >> 3] = BigInt(Math.round(1e6 * (e === 0 ? Date.now() : performance.now()))), 0) : 28;
				},
				emscripten_resize_heap: (e) => {
					var t = v.length;
					if (e >>>= 0, g(e > t), 2147483648 < e) return d(`Cannot enlarge memory, requested ${e} bytes, but the limit is 2147483648 bytes!`), !1;
					for (var n = 1; 4 >= n; n *= 2) {
						var r = t * (1 + .2 / n);
						r = Math.min(r, e + 100663296);
						var i = Math, a = i.min;
						r = Math.max(e, r), g(65536, "alignment argument is required"), i = a.call(i, 2147483648, 65536 * Math.ceil(r / 65536));
						e: {
							a = i, r = p.buffer;
							var o = (a - r.byteLength + 65535) / 65536 | 0;
							try {
								p.grow(o), de();
								var s = 1;
								break e;
							} catch (e) {
								d(`growMemory: Attempted to grow heap from ${r.byteLength} bytes to ${a} bytes, but got error: ${e}`);
							}
							s = void 0;
						}
						if (s) return !0;
					}
					return d(`Failed to grow the heap from ${t} bytes to ${i} bytes, not enough memory!`), !1;
				},
				environ_get: (e, t) => {
					var n = 0, r = 0, i;
					for (i of Vt()) {
						var a = t + n;
						S[e + r >> 2] = a, n += Y(i, a, 1 / 0) + 1, r += 4;
					}
					return 0;
				},
				environ_sizes_get: (e, t) => {
					var n = Vt();
					S[e >> 2] = n.length, e = 0;
					for (var r of n) e += Tt(r) + 1;
					return S[t >> 2] = e, 0;
				},
				fd_close: () => {
					A("fd_close called without SYSCALLS_REQUIRE_FILESYSTEM");
				},
				fd_seek: function() {
					return 70;
				},
				fd_write: (e, t, n, r) => {
					for (var i = 0, a = 0; a < n; a++) {
						var o = S[t >> 2], s = S[t + 4 >> 2];
						t += 8;
						for (var c = 0; c < s; c++) Wt(e, v[o + c]);
						i += s;
					}
					return S[r >> 2] = i, 0;
				},
				proc_exit: Rt
			}, Q = await async function() {
				function e(e) {
					e = Q = e.exports;
					var t = {};
					for (i in e) {
						var n = e[i];
						t[i] = typeof n == "function" ? _e(n) : n;
					}
					if (Q = t, p = Q.memory, g(p, "memory not found in wasm exports"), de(), I = Q.__indirect_function_table, g(I, "table not found in wasm exports"), ve(), O--, r.monitorRunDependencies?.(O), g(pe["wasm-instantiate"]), delete pe["wasm-instantiate"], O == 0 && (k !== null && (clearInterval(k), k = null), fe)) {
						var i = fe;
						fe = null, i();
					}
					return Q;
				}
				function t(t) {
					return g(r === n, "the Module object should not be replaced during async compilation - perhaps the order of HTML elements is wrong?"), n = null, e(t.instance);
				}
				me();
				var n = r, i = {
					env: qt,
					wasi_snapshot_preview1: qt
				};
				if (r.instantiateWasm) return new Promise((t, n) => {
					try {
						r.instantiateWasm(i, (n, r) => {
							t(e(n, r));
						});
					} catch (e) {
						d(`Module.instantiateWasm callback failed with error: ${e}`), n(e);
					}
				});
				M ??= r.locateFile ? r.locateFile ? r.locateFile("libavoid.wasm", c) : c + "libavoid.wasm" : "libavoid.wasm";
				try {
					return t(await xe(i));
				} catch (e) {
					return a(e), Promise.reject(e);
				}
			}(), Jt = j("__getTypeName", 1), Yt = j("malloc", 1), $ = j("free", 1), Xt = j("fflush", 1), Zt = j("__funcs_on_exit", 0), Qt = Q.emscripten_stack_get_end, $t = j("_emscripten_timeout", 2), en = Q.__trap, tn = Q.emscripten_stack_init, nn = Q._emscripten_stack_restore, rn = Q._emscripten_stack_alloc, an = Q.emscripten_stack_get_current, on = j("__cxa_decrement_exception_refcount", 1), sn = j("__cxa_increment_exception_refcount", 1), cn = j("__thrown_object_from_unwind_exception", 1), ln = j("__get_exception_message", 3), un;
			function dn() {
				function e() {
					if (g(!un), un = !0, r.calledRun = !0, !m) {
						if (g(!w), w = !0, E(), Q.__wasm_call_ctors(), i(r), r.onRuntimeInitialized?.(), D("onRuntimeInitialized"), g(!r._main, "compiled without a main, but one is present. if you added it from JS, use Module[\"onRuntimeInitialized\"]"), E(), r.postRun) for (typeof r.postRun == "function" && (r.postRun = [r.postRun]); r.postRun.length;) {
							var e = r.postRun.shift();
							we.push(e);
						}
						D("postRun"), Ce(we);
					}
				}
				if (0 < O) fe = dn;
				else {
					if (tn(), ie(), r.preRun) for (typeof r.preRun == "function" && (r.preRun = [r.preRun]); r.preRun.length;) Ee();
					D("preRun"), Ce(Te), 0 < O ? fe = dn : (r.setStatus ? (r.setStatus("Running..."), setTimeout(() => {
						setTimeout(() => r.setStatus(""), 1), e();
					}, 1)) : e(), E());
				}
			}
			if (r.preInit) for (typeof r.preInit == "function" && (r.preInit = [r.preInit]); 0 < r.preInit.length;) r.preInit.shift()();
			D("preInit"), dn(), n = o;
			for (let e of Object.keys(r)) e in t || Object.defineProperty(t, e, {
				configurable: !0,
				get() {
					A(`Access to module property ('${e}') is no longer possible via the module constructor argument; Instead, use the result of the module constructor.`);
				}
			});
			return n;
		};
	})());
})), u = null, d;
function f(e) {
	d = e;
}
function p() {
	return u ??= Promise.resolve().then(() => (l(), o)).then(async ({ AvoidLib: e }) => {
		let t = d ?? i().avoidWasm;
		return await e.load(t === void 0 ? void 0 : a(t)), e.getInstance();
	}), u.catch(() => {
		u = null;
	}), u;
}
// src/routing.ts
var m = 1, h = {
	top: 1,
	bottom: 2,
	left: 4,
	right: 8
}, g = [
	[
		.5,
		0,
		"top"
	],
	[
		.5,
		1,
		"bottom"
	],
	[
		0,
		.5,
		"left"
	],
	[
		1,
		.5,
		"right"
	]
], _ = {
	shapeBufferDistance: 12,
	idealNudgingDistance: 22,
	segmentPenalty: 10
}, v = [
	"nudgeOrthogonalSegmentsConnectedToShapes",
	"nudgeSharedPathsWithCommonEndPoint",
	"performUnifyingNudgingPreprocessingStep",
	"nudgeOrthogonalTouchingColinearSegments"
], y = (e) => ({
	x: e.x + e.w / 2,
	y: e.y + e.h / 2
});
function b(e, t) {
	return [
		["left", t.x - e.x],
		["right", e.x + e.w - (t.x + t.w)],
		["top", t.y - e.y],
		["bottom", e.y + e.h - (t.y + t.h)]
	].sort((e, t) => e[1] - t[1])[0][0];
}
function x(e, t) {
	let n = y(e), r = (t.x - n.x) / e.w, i = (t.y - n.y) / e.h;
	return Math.abs(r) >= Math.abs(i) ? r >= 0 ? "right" : "left" : i >= 0 ? "bottom" : "top";
}
function S(e, t, n) {
	return t === "top" ? {
		x: e.x + e.w * n,
		y: e.y
	} : t === "bottom" ? {
		x: e.x + e.w * n,
		y: e.y + e.h
	} : t === "left" ? {
		x: e.x,
		y: e.y + e.h * n
	} : {
		x: e.x + e.w,
		y: e.y + e.h * n
	};
}
var ee = 17, C = _.shapeBufferDistance + 1;
function te(e, t, n) {
	let r = Array.from({ length: ee }, (e, t) => .05 + .9 * t / 16), i = r.filter((r) => {
		let i = S(e, t, r);
		return !n.some((e) => i.x > e.x - C && i.x < e.x + e.w + C && i.y > e.y - C && i.y < e.y + e.h + C);
	});
	return i.length > 0 ? i : r;
}
function ne(e) {
	let t = [];
	for (let n of e) {
		let e = t.at(-1);
		if (e && Math.abs(e.x - n.x) < .01 && Math.abs(e.y - n.y) < .01) continue;
		let r = t.at(-2);
		e && r && (r.x === e.x && e.x === n.x || r.y === e.y && e.y === n.y) && t.pop(), t.push(n);
	}
	return t;
}
async function w(e, t, n = {}) {
	let r = await p(), i = new Map(e.map((e) => [e.id, e])), a = t.filter((e) => i.has(e.from) && i.has(e.to)), o = (t) => {
		let n = [];
		for (let r = i.get(t)?.parent ?? null; r !== null && n.length < e.length; r = i.get(r)?.parent ?? null) n.push(r);
		return n;
	}, s = /* @__PURE__ */ new Map(), c = /* @__PURE__ */ new Map(), l = /* @__PURE__ */ new Map();
	for (let e of a) for (let [t, n] of [[e.from, e.to], [e.to, e.from]]) {
		let r = i.get(t);
		if (!r.container) continue;
		let a = i.get(n), s = o(n).includes(t) ? b(r, a) : x(r, y(a));
		c.set(`${e.id}|${t}`, s);
		let u = `${t}|${s}`;
		l.set(u, [...l.get(u) ?? [], `${e.id}|${t}`]);
	}
	for (let [t, n] of c) {
		let r = t.slice(t.indexOf("|") + 1), a = i.get(r), c = l.get(`${r}|${n}`), u = /* @__PURE__ */ new Set([r, ...o(r)]), d = te(a, n, e.filter((e) => !e.container || !u.has(e.id) && !o(e.id).includes(r)));
		s.set(t, S(a, n, d[Math.floor((c.indexOf(t) + .5) * d.length / c.length)]));
	}
	let u = (e) => /* @__PURE__ */ new Set([
		e.from,
		e.to,
		...o(e.from),
		...o(e.to)
	]), d = e.filter((e) => e.container), f = /* @__PURE__ */ new Map();
	for (let t of a) {
		let n = u(t), r = ce(e, n, [t]).map((e) => e.id), i = `${d.filter((e) => !n.has(e.id)).map((e) => e.id).join("|")}#${r.join("|")}`, a = f.get(i) ?? {
			passable: n,
			edges: []
		};
		a.edges.push(t), f.set(i, a);
	}
	let m = /* @__PURE__ */ new Map(), h = /* @__PURE__ */ new Map(), g = [];
	for (let [e, t] of f) for (let r of ie(t.edges, i, n.chunk ?? re)) g.push({
		key: e,
		passable: t.passable,
		edges: r
	});
	for (let t of g) {
		let i = t.key;
		le(r, e, o, s, t.passable, t.edges, m, n.crossingPenalty ?? E(t.edges.length));
		let a = new Set(i.slice(0, i.indexOf("#")).split("|"));
		for (let n of t.edges) h.set(n.id, [...e.filter((e) => !e.container || a.has(e.id)), ...ce(e, t.passable, [n])]);
	}
	return (g.length > 1 || (n.keep?.size ?? 0) > 0) && D(m, h, n.keep ?? /* @__PURE__ */ new Map()), m;
}
var T = _.idealNudgingDistance, re = 24;
function ie(e, t, n) {
	if (e.length <= n) return [e];
	let r = (e) => {
		let n = y(t.get(e.from)), r = y(t.get(e.to));
		return {
			x: (n.x + r.x) / 2,
			y: (n.y + r.y) / 2
		};
	}, i = new Map(e.map((e) => [e.id, r(e)])), a = [...i.values()].map((e) => e.x), o = [...i.values()].map((e) => e.y), s = Math.max(...a) - Math.min(...a) >= Math.max(...o) - Math.min(...o), c = [...e].sort((e, t) => s ? i.get(e.id).x - i.get(t.id).x : i.get(e.id).y - i.get(t.id).y), l = Math.ceil(e.length / n), u = [];
	for (let e = 0; e < l; e++) u.push(c.slice(Math.floor(e * c.length / l), Math.floor((e + 1) * c.length / l)));
	return u;
}
function E(e) {
	return e <= 24 ? 200 : e <= 40 ? 20 : 0;
}
var ae = (e, t, n, r) => Math.min(Math.max(e, t), Math.max(n, r)) - Math.max(Math.min(e, t), Math.min(n, r));
function oe(e, t, n, r) {
	return e.y === t.y && n.y === r.y && Math.abs(e.y - n.y) < 1 ? ae(e.x, t.x, n.x, r.x) > 1 : e.x === t.x && n.x === r.x && Math.abs(e.x - n.x) < 1 && ae(e.y, t.y, n.y, r.y) > 1;
}
function D(e, t, n) {
	let r = () => [...n, ...e], i = (e, t) => r().some(([n, r]) => n !== e && t.slice(1).some((e, n) => r.slice(1).some((i, a) => oe(t[n], e, r[a], i))));
	for (let [n, a] of [...e]) {
		let o = t.get(n) ?? [], s = a;
		for (let t = 1; t + 2 < s.length; t++) {
			let a = s[t], c = s[t + 1], l = a.y === c.y;
			if ((l || a.x === c.x) && r().some(([e, t]) => e !== n && t.slice(1).some((e, n) => oe(a, c, t[n], e)))) for (let r of [
				T,
				-T,
				2 * T,
				-2 * T
			]) {
				let a = s.map((e, n) => n === t || n === t + 1 ? l ? {
					x: e.x,
					y: e.y + r
				} : {
					x: e.x + r,
					y: e.y
				} : e);
				if (!(se(a, o) || i(n, a))) {
					s = a, e.set(n, s);
					break;
				}
			}
		}
		e.set(n, ne(s));
	}
}
function se(e, t) {
	return e.slice(1).some((n, r) => {
		let i = e[r];
		return t.some((e) => Math.max(i.x, n.x) > e.x + 1 && Math.min(i.x, n.x) < e.x + e.w - 1 && Math.max(i.y, n.y) > e.y + 1 && Math.min(i.y, n.y) < e.y + e.h - 1);
	});
}
function ce(e, t, n, r = () => !1) {
	let i = new Set(n.flatMap((e) => [e.from, e.to]));
	return e.filter((e) => e.container && e.header && t.has(e.id) && !i.has(e.id) && !r(e)).map((e) => ({
		...e,
		id: `${e.id}|header`,
		h: Math.min(e.h, e.header)
	}));
}
function le(e, t, n, r, i, a, o, s) {
	let c = t.filter((e) => e.container && !i.has(e.id)), l = new Set(c.map((e) => e.id)), u = (e) => n(e.id).some((e) => l.has(e)), d = [
		...t.filter((e) => !e.container && !u(e)),
		...c.filter((e) => !u(e)),
		...ce(t, i, a, u)
	], f = [], p = (e) => (f.push(e), e), y = new e.Router(e.RouterFlag.OrthogonalRouting.value);
	try {
		for (let [t, n] of Object.entries(_)) y.setRoutingParameter(e.RoutingParameter[t], n);
		y.setRoutingParameter(e.RoutingParameter.crossingPenalty, s);
		for (let t of v) y.setRoutingOption(e.RoutingOption[t], !0);
		let t = /* @__PURE__ */ new Map();
		for (let n of d) {
			let r = p(new e.Rectangle(p(new e.Point(n.x, n.y)), p(new e.Point(n.x + n.w, n.y + n.h)))), i = new e.ShapeRef(y, r);
			if (!n.container) for (let [t, n, r] of g) new e.ShapeConnectionPin(i, m, t, n, !0, 0, h[r]).setExclusive(!1);
			t.set(n.id, i);
		}
		let n = (n, i) => {
			let a = t.get(i);
			if (a) return p(new e.ConnEnd(a, m));
			let o = r.get(`${n.id}|${i}`);
			return p(new e.ConnEnd(p(new e.Point(o.x, o.y))));
		}, i = a.map((t) => new e.ConnRef(y, n(t, t.from), n(t, t.to)));
		y.processTransaction(), a.forEach((e, t) => {
			let n = p(i[t].displayRoute()), r = [];
			for (let e = 0; e < n.size(); e++) {
				let t = p(n.at(e));
				r.push({
					x: t.x,
					y: t.y
				});
			}
			o.set(e.id, ne(r.map((e) => ({
				x: Math.round(e.x * 10) / 10,
				y: Math.round(e.y * 10) / 10
			}))));
		});
	} finally {
		for (let e of f) e.isDeleted?.() || e.delete();
		y.delete();
	}
}
// src/routing.worker.ts
self.onmessage = (e) => {
	let { id: t, boxes: n, edges: r, keep: i, wasm: a } = e.data;
	f(a), w(n, r, { keep: new Map(i) }).then((e) => self.postMessage({
		id: t,
		routes: [...e]
	}), (e) => self.postMessage({
		id: t,
		error: String(e)
	}));
};
