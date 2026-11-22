const OWNER = 'narrator_director';

const sameMembers = (a, b) => a.length === b.length && a.every((member, index) => member === b[index]);

/** SillyTavern's editGroup helper does not check the response before resolving. */
export async function saveGroupSettings(group, headers, request = fetch) {
    const response = await request('/api/groups/edit', { method: 'POST', headers, body: JSON.stringify(group) });
    if (!response.ok) throw new Error(`Could not save Narrator Director group settings (HTTP ${response.status}).`);
    if (!(await response.json())?.ok) throw new Error('SillyTavern did not confirm the group settings save.');
}

export function makeGroupSettings({ getGroup, saveGroup }) {
    const pending = new Map();

    async function update(id, current, changesFor) {
        const task = (pending.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
            const group = getGroup(id);
            if (!group || !current()) return false;
            const changes = changesFor(group);
            if (!changes) return true;
            const data = { ...group, ...changes };
            if (!data[OWNER]) delete data[OWNER];
            await saveGroup(data);
            const live = getGroup(id) ?? group;
            Object.assign(live, changes);
            if (!data[OWNER]) delete live[OWNER];
            return true;
        });
        pending.set(id, task);
        try {
            return await task;
        } finally {
            if (pending.get(id) === task) pending.delete(id);
        }
    }

    function apply(id, { modeFor, narratorAvatar, legacyMode, current }) {
        return update(id, current, group => {
            const baseline = { ...group[OWNER] };
            const changes = {};
            const mode = modeFor(group);
            if (group.generation_mode !== mode) {
                baseline.generationMode ??= legacyMode ?? group.generation_mode;
                changes.generation_mode = mode;
            }
            if (narratorAvatar) {
                const original = group.disabled_members ?? [];
                const disabled = group.members.filter(member => member !== narratorAvatar);
                if (!sameMembers(original, disabled)) {
                    baseline.disabledMembers ??= [...original];
                    changes.disabled_members = disabled;
                }
            }
            return Object.keys(changes).length ? { ...changes, [OWNER]: baseline } : null;
        });
    }

    function restore(id, { legacyMode, current }) {
        return update(id, current, group => {
            const baseline = group[OWNER];
            if (!baseline && legacyMode == null) return null;
            const generationMode = baseline?.generationMode ?? legacyMode;
            const disabledMembers = baseline?.disabledMembers;
            const changes = { [OWNER]: undefined };
            if (generationMode != null) changes.generation_mode = generationMode;
            if (Array.isArray(disabledMembers)) changes.disabled_members = [...disabledMembers];
            return changes;
        });
    }

    return { apply, restore };
}
