/**
 * In-memory doubles for the dsh services the plugin consumes: ctx.settings
 * (namespace registration + scope), ctx.commands (registry), and the auth
 * bundle (no real codex CLI spawn).
 */

/** ctx.settings double: resolves schema defaults + base, tracks updates. */
export function mockSettings() {
	const state = { registrations: [], watchers: new Set(), updates: [], value: null };
	return {
		state,
		register(ns, schema, options) {
			state.registrations.push({ ns, schema, options });
			state.value = schema(options?.base ?? {});
			const scope = {
				get: () => state.value,
				watch(callback) {
					state.watchers.add(callback);
					return () => state.watchers.delete(callback);
				},
				async update(patch) {
					state.updates.push(patch);
					const prev = state.value;
					state.value = schema({ ...state.value, ...patch });
					for (const callback of [...state.watchers]) await callback(state.value, prev);
				},
				async replace(section) {
					const prev = state.value;
					state.value = schema({ ...section });
					for (const callback of [...state.watchers]) await callback(state.value, prev);
				}
			};
			state.scope = scope;
			return scope;
		},
		/** Test driver: commit a new resolved value (simulates a user write). */
		async commit(schema, section) {
			const prev = state.value;
			state.value = schema(section);
			for (const callback of [...state.watchers]) await callback(state.value, prev);
		}
	};
}

/** ctx.commands double: captures registered definitions. */
export function mockCommands() {
	const definitions = [];
	return {
		definitions,
		register(definition) {
			definitions.push(definition);
			return () => definitions.splice(definitions.indexOf(definition), 1);
		}
	};
}

/** auth bundle double: no FS, no spawn. */
export function stubAuth(overrides = {}) {
	return {
		codexHome: "/tmp/fake-codex-home",
		bin: "codex",
		getLoginStatus: async () => ({ loggedIn: false, text: "未登录——在对话中输入 /codex login" }),
		startDeviceLogin: async () => ({ text: "device instructions" }),
		logout: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
		...overrides
	};
}
