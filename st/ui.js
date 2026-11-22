// Settings panel and inspector.
// Design rules for this file: two layers at most (a tab, then its content; Record alone has a row of parts, because
// it holds the most); nothing folded or hidden behind a
// toggle or a tooltip; forms with plain fields instead of raw JSON; every change is one visible button.
// Full disclosure: every setting has a control here, and everything the director holds is shown on some tab.

import { failureHint, moduleLabel } from '../core/failures.js';
import { beatText } from '../core/beat.js';
import { AGE_GROUPS, ARC_TENSION, AXES, BANDS, BEAT_TYPES, CLUE_ROUTES, INITIATIVE, LETHALITY, SEVERITY, STAGES, STATS, STAT_BASELINE, TEMPERAMENTS, TEMPO } from '../core/enums.js';
import { tellsFor } from '../core/social.js';
import { splitByCast, summaryView } from '../core/record.js';
import { leadingEnding, needsConclusion, progress, spineState } from '../core/spine.js';
import { bandOf, factsInView } from '../core/state.js';
import { publicVars } from '../core/vars.js';
import { clone } from '../core/util.js';
import { AGENDA_CAPS, cleanWants } from '../core/agenda.js';

const MODULES = ['observer', 'tracker', 'planner', 'summariser', 'cleanup', 'genre', 'profile', 'opening'];
const MODULE_LABELS = { observer: 'Observer', tracker: 'Spine tracker', planner: 'Planner', summariser: 'Summariser', cleanup: 'Fact clean-up', genre: 'Story profile', profile: 'Character profiles', opening: 'Opening' };
const GROUP_MODES = { 0: 'swap (the director sends the cast)', 1: 'join, unmuted only', 2: 'join, all members' };
const TABS = [['now', 'Now'], ['scene', 'Scene'], ['cast', 'Cast'], ['story', 'Story'], ['plan', 'Plan'], ['record', 'Record'], ['log', 'Log']];

export function mountUi(api) {
    const { director, escapeHtml: h } = api;
    const ctx = () => SillyTavern.getContext();
    let tab = 'now';
    let open = false;
    let dirty = false;
    let logModule = null;
    let recordPart = 'facts';
    let recordQuery = '';
    let renderedEpoch = director.epoch;
    let returnFocus = null;

    // ------------------------------------------------------------ small builders
    const text = (f, v, ph = '') => `<input class="text_pole" data-f="${f}" value="${h(v ?? '')}" placeholder="${h(ph)}">`;
    const area = (f, v, rows = 2, ph = '') => `<textarea class="text_pole" data-f="${f}" rows="${rows}" placeholder="${h(ph)}">${h(v ?? '')}</textarea>`;
    /** A one-value field that wraps and scrolls like a text area. Enter does not add a line; read() joins any pasted lines. */
    const wrapped = (f, v, ph = '') => `<textarea class="text_pole nd-oneline" data-f="${f}" data-one="1" rows="2" placeholder="${h(ph)}">${h(v ?? '')}</textarea>`;
    const number = (f, v, min, max) => `<input class="text_pole nd-small" type="number" data-f="${f}" value="${Number(v ?? 0)}" min="${min}" max="${max}">`;
    const select = (f, v, options) => `<select class="text_pole" data-f="${f}">${options.map(o => `<option value="${h(o)}" ${o === v ? 'selected' : ''}>${h(o)}</option>`).join('')}</select>`;
    const check = (f, v, label) => `<label class="nd-check"><input type="checkbox" data-f="${f}" ${v ? 'checked' : ''}> ${h(label)}</label>`;
    const field = (label, control, hint = '') => {
        const tag = /^<(input|textarea|select)\b/.test(control) ? 'label' : 'div';
        return `<${tag} class="nd-field"><span>${h(label)}</span><span class="nd-control">${control}${hint ? `<small>${h(hint)}</small>` : ''}</span></${tag}>`;
    };
    const button = (action, label, data = '') => `<button type="button" class="menu_button nd-button" data-act="${action}" ${data}>${h(label)}</button>`;
    const iconButton = (icon, label, data = '', classes = '') => `<button type="button" class="nd-icon ${classes}" ${data} title="${h(label)}" aria-label="${h(label)}"><i class="${icon}" aria-hidden="true"></i></button>`;
    const pre = (v) => `<pre class="nd-pre">${h(typeof v === 'string' ? v : JSON.stringify(v, null, 2))}</pre>`;
    const lines = (v) => (Array.isArray(v) ? v.join('\n') : '');
    const fromLines = (s) => String(s ?? '').split('\n').map(x => x.trim()).filter(Boolean);
    const fromCommas = (s) => String(s ?? '').split(',').map(x => x.trim()).filter(Boolean);
    const empty = (what) => `<p class="nd-empty">${h(what)}</p>`;
    const editedFields = form => new Set([...form.querySelectorAll('[data-nd-edited]')].map(el => el.dataset.f));

    /** Read every field inside a form block into a plain object. */
    function read(form) {
        const out = {};
        form.querySelectorAll('[data-f]').forEach(el => {
            const key = el.dataset.f;
            if (el.type === 'checkbox') {
                if (el.dataset.multi) (out[key] ??= []), el.checked && out[key].push(el.value);
                else out[key] = el.checked;
            } else if (el.dataset.one) out[key] = el.value.replace(/\s*\n\s*/g, ' ');
            else out[key] = el.type === 'number' ? Number(el.value) : el.value;
        });
        return out;
    }
    const formOf = (el) => el.closest('[data-form]');
    const touched = () => { dirty = true; $('#nd-unsaved').text('unsaved changes'); };

    // ------------------------------------------------------------ story spine (Plan tab)
    const MARK_ICON = {
        open: ['fa-regular fa-square', 'Open. Click to mark it met.'],
        met: ['fa-solid fa-square-check nd-on', 'Met. Click to mark it failed.'],
        failed: ['fa-solid fa-square-xmark nd-failed', 'Failed. Click to reopen it.'],
    };
    const NEXT_MARK = { open: 'met', met: 'failed', failed: 'open' };
    const STATE_TEXT = {
        building: 'Building: something in this scene moved toward an ending or milestone. The director follows your approach.',
        drifting: 'Drifting: the last scene closed with nothing toward any ending or milestone. The next beats bring an open criterion to where you are, softly.',
        'turning away': 'Turning away: the latest reply turned against an ending. That ending no longer leads.',
        '': 'Not started yet: no reply has been read against the spine.',
    };
    const criterionRow = (c) => {
        const [icon, tip] = MARK_ICON[c.mark] ?? MARK_ICON.open;
        const saved = !!c.id;
        const note = [
            c.alternative ? '<b>alternative route</b>' : '',
            c.mark !== 'open' && c.by ? (c.by === 'player' ? 'by you' : 'by the story') : '',
            c.turn !== undefined && c.mark !== 'open' ? `turn ${c.turn}` : '',
            c.quote ? `${c.speaker ? `${h(c.speaker)}: ` : ''}“${h(c.quote)}”` : '',
            c.reason ? `why: ${h(c.reason)}` : '',
            c.mark === 'open' && c.partial ? `partly shown once${c.partial.quote ? `: “${h(c.partial.quote)}”` : ''}; a lasting state needs a second reply to show it` : '',
            saved ? '' : 'new: save the spine before marking it',
        ].filter(Boolean).join(' · ');
        return `<div class="nd-sp-crit" data-id="${h(c.id ?? '')}">
            ${saved ? iconButton(icon, tip, `data-act="spine-mark" data-id="${h(c.id)}" data-mark="${NEXT_MARK[c.mark] ?? 'met'}"`, 'nd-sp-mark') : ''}
            <div class="nd-sp-crit-text"><label class="nd-access-label"><span>Criterion</span>${wrapped('ctext', c.text, 'what has to happen')}</label>${note ? `<small>${note}</small>` : ''}</div>
            ${iconButton('fa-solid fa-trash', 'Remove this criterion', 'data-act="spine-remove" data-what="crit"')}
        </div>`;
    };
    const progressBar = (item) => {
        const p = progress(item);
        const pct = (n) => (p.total ? Math.round(100 * n / p.total) : 0);
        return `<div class="nd-sp-bar" title="${p.met} met, ${p.failed} failed, ${p.open} open"><span class="nd-sp-met" style="width:${pct(p.met)}%"></span><span class="nd-sp-fail" style="width:${pct(p.failed)}%"></span></div>
            <small>${p.met} of ${p.total} met${p.failed ? ` · ${p.failed} failed` : ''}${p.open ? ` · ${p.open} open` : ''}</small>`;
    };
    const checklist = (item) => `<div class="nd-sp-crits">${(item.criteria ?? []).map(criterionRow).join('')}</div>
        <div class="nd-actions">${button('spine-add-criterion', 'Add a criterion')}</div>`;
    const endingCard = (e, sp, lead) => {
        const away = (sp?.turnedAway ?? []).includes(e.id);
        return `<div class="nd-card nd-sp-item nd-sp-ending ${away ? 'nd-sp-away' : ''}" data-kind="ending" data-id="${h(e.id ?? '')}">
            <div class="nd-sp-head"><b>${h(e.title || 'New ending')}</b>${e.id && e.id === lead ? ' <small class="nd-sp-tag nd-on">leading</small>' : ''}${away ? ' <small class="nd-sp-tag nd-warn">turned away</small>' : ''}
                ${iconButton('fa-solid fa-trash', 'Remove this ending', 'data-act="spine-remove" data-what="item"', 'nd-sp-right')}</div>
            ${progressBar(e)}
            ${field('Title', wrapped('title', e.title, 'a name for this answer'))}
            ${field('How', wrapped('how', e.how, 'how the question gets answered this way'))}
            ${checklist(e)}
        </div>`;
    };
    const milestoneCard = (m, waiting) => (m.status === 'skipped'
        ? `<div class="nd-card nd-sp-item nd-sp-milestone nd-sp-done" data-kind="milestone" data-id="${h(m.id)}">
            <div class="nd-sp-head"><b>${h(m.title)}</b> <small class="nd-sp-tag">skipped</small></div>
            <small>A later milestone concluded first, so this one is out of play: no conclusion, no chapter, and the tracker and planner no longer see it.</small>
            ${field('Title', wrapped('title', m.title))}
            ${checklist(m)}
            <div class="nd-actions">${button('spine-reopen', 'Reopen', `data-id="${h(m.id)}"`)}</div>
        </div>`
        : m.status === 'concluded'
        ? `<div class="nd-card nd-sp-item nd-sp-milestone nd-sp-done" data-kind="milestone" data-id="${h(m.id)}">
            <div class="nd-sp-head"><b>${h(m.title)}</b> <small class="nd-sp-tag">concluded</small></div>
            ${field('Title', wrapped('title', m.title))}
            ${field('Conclusion', area('conclusion', m.conclusion, 4), 'Sent to the narrator under "Chapters so far". Its checklist is gone; this is what remains.')}
        </div>`
        : `<div class="nd-card nd-sp-item nd-sp-milestone" data-kind="milestone" data-id="${h(m.id ?? '')}">
            <div class="nd-sp-head"><b>${h(m.title || 'New milestone')}</b>${waiting ? ' <small class="nd-sp-tag nd-on">waiting for its conclusion to be written</small>' : ''}
                ${iconButton('fa-solid fa-trash', 'Remove this milestone', 'data-act="spine-remove" data-what="item"', 'nd-sp-right')}</div>
            ${progressBar(m)}
            ${m.happened ? `<small>The narration showed it happen${m.happened.quote ? `: “${h(m.happened.quote)}”` : ''}.</small>` : ''}
            ${field('Title', wrapped('title', m.title, 'a stepping stone of the story'))}
            ${checklist(m)}
            ${m.id ? `<div class="nd-actions">${button('spine-conclude', 'Conclude now', `data-id="${h(m.id)}"`)}<small>Open criteria become failed, and the conclusion is written from what happened.</small></div>` : ''}
        </div>`);

    function spineSection(s) {
        const sp = s.spine;
        if (!sp) {
            return `<div data-form="spine"><h4>Story spine</h4>
                ${empty('Drafted after the arc, from the cards, scenario, persona, world notes and opening.')}
                <div class="nd-actions">${button('spine-draft', 'Draft the spine now')}</div></div>`;
        }
        const lead = leadingEnding(sp);
        const st = spineState(sp);
        const titleOf = (id) => sp.endings.find(e => e.id === id)?.title ?? id;
        const readings = (sp.readings ?? []).slice(-4).reverse().map(r => `<div><small>turn ${r.turn}: ${Object.entries(r.byEnding ?? {}).map(([id, v]) => `${h(titleOf(id))} <b>${h(v)}</b>`).join(' · ')}</small></div>`).join('');
        const waiting = new Set(needsConclusion(s).map(m => m.id));
        const p = sp.proposal;
        return `<div data-form="spine" id="nd-spine">
            <h4>Story spine <small>the setup's question and its possible answers; the narrator never sees this</small></h4>
            ${field('Question', wrapped('question', sp.question, 'the question the setup poses'))}
            <div class="nd-field"><span>Where you stand</span><div>${h(STATE_TEXT[st] ?? STATE_TEXT[''])}
                <small>${lead ? `Leading ending: <b>${h(titleOf(lead))}</b>.` : 'No ending leads yet.'}</small>${readings}
                <div class="nd-actions">${button('spine-track', 'Check the spine now')}<small>${(() => { const n = director.nextBatch?.(true)?.length ?? 0; return n ? `${n} repl${n === 1 ? 'y waits' : 'ies wait'} for the tracker. It checks by itself every ${Number(api.getSettings().trackEvery) || 4} replies you have answered.` : 'Every reply so far has been checked.'; })()}</small></div></div></div>
            ${p ? `<div class="nd-card nd-sp-proposal">
                <div class="nd-sp-head"><b>Proposed new ending: ${h(p.title)}</b></div>
                <p class="nd-note">You turned away from every ending. ${h(p.reason ?? '')}</p>
                ${p.how ? `<small>${h(p.how)}</small>` : ''}
                ${(p.criteria ?? []).map(c => `<div><small>☐ ${h(c)}</small></div>`).join('')}
                <div class="nd-actions">${button('spine-proposal', 'Accept', 'data-accept="1"')}${button('spine-proposal', 'Keep the current endings', 'data-accept="0"')}</div>
            </div>` : ''}
            <h4>Endings <small>all live at once; the one you build toward leads. Failed criteria lower progress, never close an ending</small></h4>
            <div id="nd-sp-endings">${sp.endings.map(e => endingCard(e, sp, lead)).join('') || empty('No endings.')}</div>
            <div class="nd-actions">${button('spine-add-ending', 'Add an ending')}</div>
            <h4>Milestones <small>stepping stones; a milestone concludes when every criterion is met or failed</small></h4>
            <div id="nd-sp-milestones">${sp.milestones.map(m => milestoneCard(m, waiting.has(m.id))).join('') || empty('No milestones.')}</div>
            <div class="nd-actions">${button('spine-add-milestone', 'Add a milestone')}${button('save-spine', 'Save the spine')}</div>
            <template id="nd-sp-crit-template">${criterionRow({ id: '', text: '', mark: 'open' })}</template>
            <template id="nd-sp-ending-template">${endingCard({ id: '', title: '', how: '', criteria: [] }, sp, null)}</template>
            <template id="nd-sp-milestone-template">${milestoneCard({ id: '', title: '', criteria: [], status: 'open' }, false)}</template>
        </div>`;
    }

    /** Open criteria a beat can serve: [id, "item title: criterion text"]. */
    const servable = (s) => [...(s.spine?.endings ?? []), ...(s.spine?.milestones ?? []).filter(m => m.status !== 'concluded' && m.status !== 'skipped')]
        .flatMap(item => (item.criteria ?? []).filter(c => c.mark === 'open').map(c => [c.id, `${item.title}: ${c.text}`]));

    // ------------------------------------------------------------ settings panel (Extensions drawer)
    const profileOptions = (selected, emptyLabel) => {
        const profiles = ctx().extensionSettings?.connectionManager?.profiles ?? [];
        return `<option value="">${h(emptyLabel)}</option>` + profiles.map(p => `<option value="${h(p.id)}" ${p.id === selected ? 'selected' : ''}>${h(p.name)}</option>`).join('');
    };

    function renderSettings() {
        const s = api.getSettings();
        const hint = (t) => (t ? `<small class="nd-hint">${h(t)}</small>` : '');
        const num = (key, label, note, step = 1) => `<label class="nd-row"><span>${h(label)}${hint(note)}</span><input type="number" min="0" step="${step}" class="text_pole nd-num" data-nd-num="${key}" value="${Number(s[key])}"></label>`;
        const sel = (id, label, value, options, note = '') => `<label class="nd-row"><span>${h(label)}${hint(note)}</span><select id="${id}" class="text_pole">${options.map(([v, l]) => `<option value="${v}" ${value === v ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></label>`;
        const text = (id, label, value, note) => `<label class="nd-row"><span>${h(label)}${hint(note)}</span><input type="text" id="${id}" class="text_pole" value="${h(value ?? '')}"></label>`;
        const tick = (id, on, label, note) => `<label class="checkbox_label nd-tick"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> <span>${h(label)}${hint(note)}</span></label>`;
        $('#nd-settings-body').html(`
            ${tick('nd-enabled', s.enabled, 'Enabled', 'Active only in chats with the Narrator card, alone or in a group with your cards.')}
            <div class="menu_button" id="nd-open">Open the inspector</div>

            <h4>Director's model</h4>
            <label class="nd-row"><span>Connection profile${hint('Used for every director call unless a module below has its own. "Current connection" shares the narrator\'s model and sampler settings.')}</span><select id="nd-profile" class="text_pole">${profileOptions(s.profile, 'Current connection')}</select></label>
            ${MODULES.map(m => `<label class="nd-row"><span>${h(MODULE_LABELS[m])}</span><select class="text_pole" data-nd-module="${m}">${profileOptions(s.profiles?.[m] ?? '', 'Same as above')}</select></label>`).join('')}
            ${tick('nd-temps', s.setTemps, 'Set the temperature for director calls', 'Applies when a connection profile is chosen. A model that refuses the setting is left at its own default for the session.')}
            ${num('tempRecord', 'Record keeping', 'Observer, spine tracker, summariser, fact clean-up, story profile, character profiles. Low, so quotes are copied exactly.', 0.05)}
            ${num('tempPlan', 'Planning', 'Planner and opening. Higher, so plans and openings vary.', 0.05)}
            ${num('maxRetries', 'Tries per reply', 'How many times the observer may fail on one reply before it is left for /director retry.')}

            <h4>Longest answer per module, in tokens</h4>
            ${MODULES.map(m => `<label class="nd-row"><span>${h(MODULE_LABELS[m])}</span><input type="number" min="100" step="50" class="text_pole nd-num" data-nd-token="${m}" value="${Number(s.tokens?.[m])}"></label>`).join('')}

            <h4>Story</h4>
            ${sel('nd-placement', 'Where the notes go', s.placement, [['auto', 'Automatic'], ['depth', 'Before your last message'], ['system', 'In the system prompt'], ['macro', 'Only where {{director_notes}} is']], 'Automatic: a {{director_notes}} preset entry if one is enabled; otherwise before your last message, or in the system prompt for Claude and Gemini.')}
            ${num('cadence', 'Re-plan every N turns', '0 (the default) means on events only: the planner runs when the openings run out, when you go elsewhere, when the scene stalls, when the story drifts, and on request. A timed re-plan can replace an opening you were about to take.')}
            ${num('nudgeAfter', 'Nudge a waiting opening after N turns', 'An opening offered this many turns without being taken is mentioned to the narrator once more, as still there; never pressed. It is retired two turns later (five later if the plan needs it). Going elsewhere counts as passing it by, not waiting. 0 means never nudge.')}
            ${num('dormantAfter', 'Let a thread sleep after N turns', 'An open thread nobody has touched for this many turns leaves the planner\'s view, so plans build on what is in play. It wakes by itself when a reply names its people, place or key words again, or when they are in the scene. It stays on the Record tab. 0 means threads never sleep.')}
            ${num('stallAfter','Re-plan when nothing changes for N replies', 'When this many replies in a row record nothing new (no fact, thread, opening taken or spine step), the planner brings something small to where you are, without cutting the scene short. 0 turns it off.')}

            <h4>Groups</h4>
            ${sel('nd-greetings', 'Other members\' greetings', s.greetings, [['hide', 'Hide from the prompt'], ['keep', 'Keep']], 'SillyTavern posts every member\'s greeting in a new group chat.')}
            ${num('castLimit', 'Largest cast sent in full', 'Above this many cast cards the group swaps, and the director sends full cards only for characters in the scene.')}

            <h4>Memory and lore</h4>
            ${sel('nd-memory', 'Who keeps the story\'s memory', s.memory, [['director', 'The director'], ['extension', 'Another extension'], ['off', 'Nobody']], 'The director: it summarises each reply and sends the story so far and chapters to the narrator. Another extension (BaiBai Book, Summarize): that extension feeds the narrator the story so far; the director adds only its one-line summaries of the last 2 turns, sends no chapters, and plans from that extension\'s record. Nobody: no story memory is sent. Facts, scene, cast, threads, the spine and lore are kept in every mode.')}
            ${sel('nd-memory-provider', 'Read the memory from', s.memoryProvider, api.providerOptions(), 'With "Another extension". Automatic takes the first one present: BaiBai Book, then Summarize. If it is missing or slow, the planner works from the last replies and the other records.')}
            ${text('nd-memory-macro', 'Macro to read', s.memoryMacro, 'With "A macro": its name without braces, for example bbsHistory.')}
            ${text('nd-strip', 'Tags to remove before reading', s.stripTags, 'Other extensions\' tags, separated by commas. Each is removed whole, content included, before the director reads a reply; the message itself is not changed. Records made before you change this still count.')}
            ${num('rollEvery', 'Roll up summaries every N', 'Counted over summaries whose messages have left the prompt. Only when the director keeps the memory.')}
            ${num('backfill', 'Replies to read on an existing chat', 'How far back the director reads when first enabled on a chat.')}
            ${num('trackEvery', 'Check the spine every N replies', 'The spine tracker waits until this many replies you have answered are ready, then reads them in one call. "Check the spine now" on the Plan tab, or /director track, checks at once.')}
            ${num('cleanEvery', 'Clean up facts every N turns', 'Merges facts that say the same thing, the most current one winning, and retires minor facts that no longer matter. A major fact is never removed, only merged. Retired facts stay listed on the Record tab. 0 turns this timer off.')}
            ${num('cleanAbove', 'Clean up early above N facts', 'Runs the same clean-up sooner, without waiting for the turn count, when the live (not retired) facts number more than this and have grown since the last clean-up. It does not repeat until the count grows again. Works even when the timer above is off. 0 turns the early clean-up off.')}
            ${num('recurrence', 'Mentions before a lore entry', 'A person, place or thing must appear in this many accepted replies.')}
            ${tick('nd-mirror', s.mirrorLore, 'Keep lorebook files for the director\'s lore', 'Writes "Narrator baseline" and "Narrator dynamic lore" so other extensions can look entries up. Leave those files unbound.')}

            <h4>Size limits, in tokens</h4>
            ${num('briefTokens', 'Notes', 'Lines are dropped, least important first, to fit.')}
            ${num('storyTokens', 'Block before the chat history', 'The Now tab reports when story context is shortened to fit this estimate.')}`);
    }

    $('#extensions_settings2').append(`
        <div class="nd-settings"><div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>Narrator Director</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content" id="nd-settings-body"></div>
        </div></div>`);
    renderSettings();
    const set = (key, value) => { api.getSettings()[key] = value; api.saveSettings(); };
    $('#nd-settings-body')
        .on('focus mousedown', 'select', function () { if (this.options.length <= 1 && (this.id === 'nd-profile' || this.dataset.ndModule)) renderSettings(); })
        .on('change', '#nd-enabled', async function () {
            this.disabled = true;
            try {
                await api.onToggle(this.checked);
            } catch (error) {
                toastr.error(String(error?.message ?? error), 'Narrator Director');
            } finally {
                this.checked = api.getSettings().enabled;
                this.disabled = false;
            }
        })
        .on('change', '#nd-profile', function () { set('profile', this.value); })
        .on('change', '[data-nd-module]', function () { api.getSettings().profiles[this.dataset.ndModule] = this.value; api.saveSettings(); })
        .on('change', '#nd-temps', function () { set('setTemps', this.checked); })
        .on('change', '#nd-mirror', function () { set('mirrorLore', this.checked); })
        .on('change', '[data-nd-token]', function () { api.getSettings().tokens[this.dataset.ndToken] = Math.max(100, Number(this.value) || 100); api.saveSettings(); })
        .on('change', '#nd-placement', function () { set('placement', this.value); })
        .on('change', '#nd-greetings', function () { set('greetings', this.value); })
        .on('change', '#nd-memory', function () { set('memory', this.value); })
        .on('change', '#nd-memory-provider', function () { set('memoryProvider', this.value); })
        .on('change', '#nd-memory-macro', function () { set('memoryMacro', this.value.trim()); })
        .on('change', '#nd-strip', function () { set('stripTags', this.value.trim()); })
        .on('change', '[data-nd-num]', function () { set(this.dataset.ndNum, Math.max(0, Number(this.value) || 0)); })
        .on('click', '#nd-open', () => show(true));

    // ------------------------------------------------------------ inspector shell
    $('body').append(`
        <aside id="nd-inspector" class="nd-hidden" aria-label="Narrator Director">
            <div class="nd-head"><b>Director</b><span id="nd-status" role="status"></span>
                <button type="button" class="nd-warn nd-failing-count" id="nd-failure-link" data-nd-tab="log" hidden></button>
                <span class="nd-spacer"></span><span id="nd-unsaved" class="nd-warn" role="status"></span>
                ${iconButton('fa-solid fa-rotate', 'Refresh', 'id="nd-refresh"')}
                ${iconButton('fa-solid fa-xmark', 'Close', 'id="nd-close"')}</div>
            <nav class="nd-tabs" aria-label="Director views">${TABS.map(([id, label]) => `<button type="button" data-nd-tab="${id}" aria-controls="nd-body">${label}</button>`).join('')}</nav>
            <div class="nd-body" id="nd-body" tabindex="-1"></div>
            <div id="nd-feedback" role="status" aria-atomic="true"></div>
            <div class="nd-foot"><input id="nd-say" class="text_pole" aria-label="Direction to the narrator" placeholder="Tell the director something…"><button type="button" class="menu_button" id="nd-send">Send</button></div>
        </aside>`);
    const wand = $('#extensionsMenu');
    if (wand.length) wand.append('<button type="button" id="nd-wand" class="list-group-item flex-container flexGap5"><span class="fa-solid fa-clapperboard extensionsMenuExtensionButton" aria-hidden="true"></span>Director</button>');
    $(document).on('click', '#nd-wand', () => show(true));

    // ------------------------------------------------------------ tabs
    const others = (s) => Object.entries(s.cast).filter(([, c]) => !c.pc);
    const statusText = (c) => c.statuses.map(x => `${x.name} (${x.severity})`).join(', ');

    const tabs = {
        now(s) {
            const b = api.getBrief();
            const g = api.groupInfo();
            const total = s.meta.accepted + s.meta.rejected;
            return `
                <h4>This chat</h4>
                <div class="nd-field"><span>Director</span><div class="nd-seg">
                    ${button('cmd', 'Off', 'data-cmd="off"')}
                    <small>Off stops the director in this chat only.</small></div></div>
                <div class="nd-field"><span>Progress</span><div>Turn ${s.meta.turn} · ${s.canon.length} facts on record${total ? ` · ${Math.round(100 * s.meta.rejected / total)}% of proposed changes refused` : ''}${s.meta.lagging ? ' · <span class="nd-warn">the latest reply is not read yet</span>' : ''}</div></div>
                ${g ? `<div class="nd-field"><span>Group</span><div>${h(GROUP_MODES[g.mode] ?? g.mode)} · ${g.cast} cast · ${g.muted} muted ${button('setup', 'Mute the cast so only the narrator speaks')}</div></div>` : ''}
                <div class="nd-field"><span>Notes are placed</span><div>${h({ depth: 'before your last message', system: 'in the system prompt', macro: 'where the preset has {{director_notes}}' }[b.placement] ?? b.placement)}</div></div>
                <div class="nd-actions">${button('cmd', 'Re-plan', 'data-cmd="replan"')}${button('cmd', 'Draft an opening', 'data-cmd="opening"')}${button('cmd', 'Choose the next beat', 'data-cmd="suggest"')}${button('cmd', 'Retry failed calls', 'data-cmd="retry"')}</div>

                <h4>Notes sent with the last turn</h4>${pre(b.brief.text || 'Nothing has been sent yet.')}
                <h4>Notes if you sent a message now</h4>${pre(b.preview().text)}
                <h4>Sent before the chat history</h4>
                ${b.story.overflow ? '<p class="nd-warn">Story context was shortened to fit the token budget.</p>' : ''}
                ${pre(b.story.text || 'Nothing yet.')}`;
        },

        scene(s) {
            const sc = s.scene;
            const names = others(s).filter(([, c]) => !c.dead).map(([n]) => n);
            return `
                <div data-form="scene">
                    <h4>Where and when</h4>
                    ${field('Location', text('location', sc.location.established ? sc.location.value : '', 'not established yet'))}
                    ${field('Time', text('time', sc.time.established ? sc.time.value : '', 'not established yet'))}
                    ${field('Mood', text('mood', sc.mood, 'two or three words'))}
                    ${field('Initiative', select('initiative', sc.initiative, INITIATIVE), 'player: the scene waits on you. world: events keep moving.')}
                    <h4>Who is here</h4>
                    <div class="nd-checks">${names.map(n => `<label class="nd-check"><input type="checkbox" data-f="present" data-multi="1" value="${h(n)}" ${sc.present.includes(n) ? 'checked' : ''}> ${h(n)}</label>`).join('') || empty('No characters on record yet.')}</div>
                    ${field('Add someone', text('add', '', 'names, separated by commas'))}
                    <div class="nd-actions">${button('save-scene', 'Save the scene')}</div>
                </div>`;
        },

        cast(s) {
            // Wants (M1): up to three lasting, high-level wants, one per line. The narrator sees them while they are present.
            const agendaFields = (st, name) => {
                const a = st.agendas?.[name];
                const wants = cleanWants(a);
                const note = wants.length ? `Set by ${a.by === 'player' ? 'you' : a.by === 'setup' ? 'the spine drafter' : 'the planner'}.` : 'No wants yet; the planner may give some.';
                return `
                    ${field('Wants', area('agenda.wants', wants.join('\n'), 3, 'what they live for, one per line, up to three'), `${note} Up to ${AGENDA_CAPS.wants}, lasting and high-level ("a happy family", "to amass a fortune"). The narrator sees them while this character is in the scene. The planner changes them only when the story transforms one. Clear them all and the planner leaves this character without.`)}`;
            };
            const factText = new Map([...s.canon, ...s.uncertain].map(f => [f.id, f.fact]));
            const block = ([name, c], i) => `
                <div class="nd-card" data-form="cast" data-name="${h(name)}">
                    <h4 class="nd-cast-head">${h(name)}${c.pc ? ' <small>your character</small>' : `
                        ${iconButton('fa-solid fa-pen', `Rename ${name}`, 'data-act="rename-cast"')}
                        <small>${c.main ? 'main cast · ' : ''}${bandOf(c.rel)} toward you</small>
                        ${iconButton(`fa-solid ${c.main ? 'fa-user-lock' : 'fa-user'}`, c.main ? `Unlock ${name} from main cast` : `Lock ${name} as main cast`,
                            `data-act="lock-cast" data-lock="${c.main ? 'unlock' : 'lock'}" aria-pressed="${!!c.main}"`, `nd-lock ${c.main ? 'nd-on' : ''}`)}`}</h4>
                    ${c.pc ? '' : `
                    ${field('Stage', select('stage', c.stage, STAGES))}
                    <div class="nd-field"><span>Feelings toward you</span><div class="nd-grid">${AXES.map(a => `<label>${a}${number(`rel.${a}`, c.rel[a], -10, 10)}</label>`).join('')}</div></div>`}
                    <div class="nd-field"><span>Abilities</span><div class="nd-grid">${STATS.map(st => `<label>${st}${number(`stats.${st}`, c.stats?.[st] ?? STAT_BASELINE, 1, 130)}</label>`).join('')}</div></div>
                    ${field('Conditions', text('statuses', statusText(c), 'arm wound (serious), fever (mild)'), `Severity is one of: ${SEVERITY.join(', ')}.`)}
                    ${field('In brief', area('profile', c.profile, 2, 'who they are and how they speak'))}
                    ${field('Gender', text('gender', c.gender))}
                    ${field('Race', text('race', c.race, 'human if unstated'))}
                    ${field('Age group', select('age_group', c.age_group ?? '', ['', ...AGE_GROUPS]), 'Leave empty if unspecified.')}
                    ${field('Appearance', area('appearance', c.appearance, 2, 'build, hair, eyes, marks, usual clothing'), 'Gender, race, age group and appearance are anchors: sent to the narrator while they are in the scene, so they stay the same. The story never changes them. Clear one to take it from the card again.')}
                    ${c.pc ? '' : `
                    ${field('Temperament', select('temperament', c.temperament ?? 'reserved', TEMPERAMENTS), 'Decides their behaviour wherever a line below is left empty.')}
                    <div class="nd-field"><span>How they act when…</span><div>${BANDS.map(b => `<label class="nd-stack">${b}${text(`tells.${b}`, c.tells?.[b] ?? '', tellsFor({ temperament: c.temperament }, b))}</label>`).join('')}</div></div>
                    ${field('Does unprompted', text('unprompted', c.unprompted, 'one thing they do without being asked'))}
                    ${agendaFields(s, name)}
                    ${field('Toward others', text('stances', Object.entries(c.stances ?? {}).map(([n, v]) => `${n}: ${v}`).join(', '), 'Old Tam: 3, Hale: -4'), 'From -10 to 10. Changes only when both are in the scene.')}
                    ${field('Wrongly believes', area('beliefs', c.beliefs.filter(x => !x.true).map(x => x.believes).join('\n'), 2, 'one per line'))}
                    ${field('Witnessed', `<div>${c.knows.length ? c.knows.slice(-6).map(k => h(factText.get(k.fact) ?? '(a fact since removed)')).join('<br>') + (c.knows.length > 6 ? `<br><small>and ${c.knows.length - 6} earlier</small>` : '') : '<small>nothing on record</small>'}</div>`)}
                    <div class="nd-field"><span></span><div>${check('dead', c.dead, 'Dead')}</div></div>`}
                    <div class="nd-actions">${button('save-cast', `Save ${name}`, `data-i="${i}"`)}</div>
                    ${c.pc ? '' : `
                    <div class="nd-field"><span>Not a character?</span><div>${c.main ? '<small>Unlock first to remove a main cast member.</small>' : `${button('remove-cast', `Remove ${name} from the cast`)}<small>For someone who was only passing by. Facts about what they did stay.</small>`}</div></div>`}
                </div>`;
            const all = Object.entries(s.cast);
            return `<p class="nd-note">Feelings run from -10 to 10. Abilities: an untrained person is 30; 60 is formidable; 85 is the best in the world. The narrator never sees these numbers, only words.</p>
                ${all.map(block).join('') || empty('No characters on record yet.')}`;
        },

        story(s) {
            const g = s.genre ?? {};
            return `
                <div data-form="profile">
                    <h4>Story profile ${g.confirmed === false && s.meta.turn === 0 ? '<small class="nd-warn">a draft; saving accepts it</small>' : ''}</h4>
                    ${field('Genre', text('dominant', g.dominant, 'fantasy'))}
                    ${field('Also', text('secondary', (g.secondary ?? []).join(', '), 'adventure, romance'), 'Up to three secondary genres, separated by commas. Smut is recognized as erotica.')}
                    ${field('Voice', area('register', g.register, 2, 'diction, rhythm and humour'))}
                    ${field('Point of view', text('pov', g.pov, 'second person, present tense'))}
                    ${field('Tempo', select('tempo', g.tempo ?? 'measured', TEMPO))}
                    ${field('Lethality', select('lethality', g.lethality ?? 'low', LETHALITY))}
                    ${field('Stakes', text('stakes', g.stakes, 'what can be lost'))}
                    ${field('Protect, in order', area('priority', lines(g.priority), 3, 'one per line'))}
                    ${field('Promises', area('promises', lines(g.promises), 3, 'one per line'))}
                    ${field('Avoid', area('avoid', lines(g.avoid), 3, 'one per line'))}
                    <div class="nd-field"><span>Abilities that matter</span><div class="nd-checks">${STATS.map(st => `<label class="nd-check"><input type="checkbox" data-f="stats_focus" data-multi="1" value="${st}" ${(g.stats_focus ?? []).includes(st) ? 'checked' : ''}> ${st}</label>`).join('')}</div></div>
                    ${field('Status', `<div>${g.confirmed ? 'Accepted by you.' : s.meta.turn > 0 ? 'A draft, treated as accepted since play began.' : 'A draft. Saving accepts it.'}</div>`)}
                    <div class="nd-actions">${button('save-profile', 'Save the profile')}${button('cmd', 'Draft it again', 'data-cmd="profile"')}</div>
                </div>
                <div data-form="premise">
                    <h4>Premise</h4>
                    ${area('premise', s.premise, 3, 'The situation the story starts from. Sent to the narrator every turn.')}
                    <div class="nd-actions">${button('save-premise', 'Save the premise')}</div>
                </div>`;
        },

        plan(s) {
            const arc = s.arc;
            const queued = s.beats.filter(b => b.status === 'queued');
            const played = s.beats.filter(b => b.status !== 'queued');
            const sceneIds = ['', ...s.scenes.map(sc => sc.id)];
            const clueLines = (b) => (b.clues ?? []).map(c => `${c.text} | ${c.route} | ${c.where ?? ''}${c.found ? ' | found' : ''}`).join('\n');
            const serveOptions = servable(s);
            const servesSelect = (b) => `<select class="text_pole" data-f="serves"><option value="">nothing in particular</option>${serveOptions.map(([id, label]) => `<option value="${h(id)}" ${id === b.serves ? 'selected' : ''}>${h(label)}</option>`).join('')}${b.serves && !serveOptions.some(([id]) => id === b.serves) ? `<option value="${h(b.serves)}" selected>${h(b.serves)} (no longer open)</option>` : ''}</select>`;
            const beatRow = (b) => `
                <div class="nd-card nd-beat" data-id="${h(b.id ?? '')}">
                    ${field('Opening', wrapped('pressure', beatText(b).pressure, 'what the world offers now; the player may take it or pass it by'), 'What the narrator sees. True in the world now; never the outcome.')}
                    ${field('Lands when', wrapped('goal', beatText(b).goal, 'what counts as this beat happening'), 'The record keeper judges the beat by it.')}
                    ${field('Only if', wrapped('precondition', b.precondition, 'the condition that makes it fit'))}
                    <div class="nd-field"><span>Kind</span><div class="nd-inline">${select('type', b.type ?? 'choice', BEAT_TYPES)} ${check('required', b.required, 'Required')} ${button('remove-beat', 'Remove')}</div></div>
                    ${field('In scene', select('scene', b.scene ?? '', sceneIds))}
                    ${field('Serves', servesSelect(b), 'The spine criterion this beat gives the player a way toward.')}
                    ${field('Lore to recall', wrapped('lore', (b.lore ?? []).join(', '), 'up to three lorebook keys'), 'Triggers those lorebook entries. Not shown to the narrator.')}
                    ${field('Clues', area('clues', clueLines(b), 2, 'a grey film on the bucket | place | the well'), `One per line: what it is | how it is found (${CLUE_ROUTES.join(', ')}) | where.`)}
                    ${b.id ? field('So far', `<div><small>offered ${b.offered ?? 0} time(s) · moved toward ${b.progress ?? 0} · walked past ${b.preempted ?? 0}</small></div>`) : ''}
                </div>`;
            const sceneRow = (sc) => `
                <div class="nd-card nd-scene" data-id="${h(sc.id ?? '')}">
                    ${field('Purpose', wrapped('purpose', sc.purpose, 'what this scene is for'))}
                    ${field('If nobody steps in', area('if_unchallenged', lines(sc.if_unchallenged), 2, 'one event per line, in order'))}
                    ${field('Choices on offer', area('choice_points', lines(sc.choice_points), 2, 'one per line'))}
                    ${field('Who should feel what', area('focus', Object.entries(sc.focus ?? {}).map(([n, v]) => `${n}: ${v}`).join('\n'), 2, 'Mira: guarded hope'))}
                    <div class="nd-actions">${button('remove-scene', 'Remove this scene')}</div>
                </div>`;
            return `
                <p class="nd-note nd-warn">This tab shows where the story may go.</p>
                <p class="nd-note">Last planned at turn ${s.meta.lastPlanTurn < 0 ? '–' : s.meta.lastPlanTurn}${s.meta.planReason ? `, because: ${h(s.meta.planReason)}` : ''}.</p>
                ${spineSection(s)}
                ${arc ? `<div data-form="arc">
                    <h4>Arc</h4>
                    ${field('Goal', wrapped('goal', arc.goal))}
                    ${field('Forces', area('forces', lines(arc.forces), 2, 'one per line'))}
                    ${field('Tension', select('tension', arc.tension, ARC_TENSION))}
                    ${field('Act', number('act', arc.act, 1, 5))}
                    ${field('Payoff', wrapped('payoff', arc.payoff?.name, 'one moment the story should earn'))}
                    ${field('Payoff in act', number('payoffAct', arc.payoff?.act ?? 3, 1, 5))}
                    ${field('Things to plant', area('hooks', (arc.payoff?.hooks ?? []).map(k => `${k.text}${k.planted ? ' | planted' : ''}`).join('\n'), 2, 'one per line'))}
                    ${field('Possible endings', area('endings', (arc.endings ?? []).map(e => e.title).join('\n'), 2, 'one per line; at least two'))}
                    <div class="nd-actions">${button('save-arc', 'Save the arc')}</div>
                </div>` : `<h4>Arc</h4>${empty('No arc yet. It is drafted once the story profile is accepted or you start playing.')}`}
                <div data-form="beats">
                    <h4>Coming up <small>the narrator sees only the first</small></h4>
                    <div id="nd-beats">${queued.map(beatRow).join('') || empty('Nothing queued.')}</div>
                    <div class="nd-actions">${button('add-beat', 'Add a beat')}${button('save-beats', 'Save the beats')}${button('cmd', 'Re-plan', 'data-cmd="replan"')}</div>
                </div>
                <div data-form="scenes">
                    <h4>Scenes</h4>
                    <div id="nd-scenes">${s.scenes.map(sceneRow).join('') || empty('None.')}</div>
                    <div class="nd-actions">${button('add-scene', 'Add a scene')}${button('save-scenes', 'Save the scenes')}</div>
                </div>
                <h4>Already played</h4>
                ${played.slice().reverse().map(b => `<div class="nd-line"><div class="nd-line-text"><b>${h(b.status)}</b> ${h(b.intent)} <small>${h(b.type)}</small></div></div>`).join('') || empty('Nothing yet.')}
                <template id="nd-beat-template">${beatRow({ id: '', goal: '', pressure: '', precondition: '', type: 'choice', required: false })}</template>
                <template id="nd-scene-template">${sceneRow({ id: '', purpose: '' })}</template>`;
        },

        record(s) {
            const book = recordPart === 'lore' ? director.lorebook(s) : null;
            const item = (text, buttons, small = '') => `<div class="nd-line"><div class="nd-line-text">${h(text)}${small ? `<br><small>${small}</small>` : ''}</div><div class="nd-line-buttons">${buttons}</div></div>`;
            const lore = (e) => item(e.text, '', `<b>${h(e.keys.join(', '))}</b> · ${h(e.kind)} · mentioned in ${e.mentions} repl${e.mentions === 1 ? 'y' : 'ies'}${e.supersedes ? ` · replaces authored lore on ${h(e.supersedes)}` : ''}${e.history.length ? `<br>Earlier: ${h(e.history.map(x => x.text).join(' | '))}` : ''}`);
            const inView = new Set(factsInView(s).map(f => f.id));
            const weight = (f) => (f.retired ? '<b>retired by the clean-up</b> · ' : `${f.weight === 'minor' ? 'minor' : 'major'}${f.weight === 'minor' && !inView.has(f.id) ? ', faded: no longer shown to the models' : ''}${f.merged ? ` · merged from ${f.merged.length} facts` : ''} · `);
            const seen = (f) => `${weight(f)}turn ${f.turn ?? '?'} · seen by ${f.witnesses?.length ? h(f.witnesses.join(', ')) : 'nobody else'}${f.secret ? ' · <b class="nd-secret">secret: anyone else in the scene is played as not knowing</b>' : ''}<br>“${h(f.quote || 'no quote')}”`;
            // The icon shows the state (lit = secret); clicking it switches.
            const secretIcon = (f) => iconButton('fa-solid fa-user-secret', f.secret ? 'Make public' : 'Mark secret',
                `data-act="toggle-secret" data-id="${h(f.id)}" aria-pressed="${!!f.secret}"`, f.secret ? 'nd-on' : '');
            const source = mid => mid ? button('source', 'Source', `data-mid="${h(mid)}"`) : '';
            const fact = (f) => item(f.fact, secretIcon(f) + button('retcon', 'Undo', `data-id="${h(f.id)}"`) + source(f.source), seen(f));
            const hint = (f) => item(f.fact, button('confirm-fact', 'It is true', `data-id="${h(f.id)}"`) + button('drop-fact', 'Remove', `data-id="${h(f.id)}"`), f.offscreen ? 'planned off-screen; not narrated yet' : seen(f));
            const who = (n) => `${h(n)}${s.cast[n]?.pc ? ' <small>you</small>' : s.cast[n]?.main ? ' <small><i class="fa-solid fa-user-lock"></i> main cast</small>' : ''}`;
            // World first, then one group per cast member the facts name.
            const grouped = (facts, draw, worldTitle, worldNote, castTitle, castNote) => {
                const g = splitByCast(s, facts);
                const castCount = g.cast.reduce((n, [, list]) => n + list.length, 0);
                return `<h4>${worldTitle} <small>${g.world.length} · ${worldNote}</small></h4>
                    ${g.world.map(draw).join('') || empty('Nothing.')}
                    <h4>${castTitle} <small>${castCount} · ${castNote}</small></h4>
                    ${g.cast.map(([n, list]) => `<h5>${who(n)} <small>${list.length}</small></h5>${list.map(draw).join('')}`).join('') || empty('Nothing.')}`;
            };
            const sv = recordPart === 'summaries' ? summaryView(s.summaries, 20) : null;
            const filter = list => !recordQuery ? list : list.filter(f => [f.fact, f.quote, ...(f.witnesses ?? [])]
                .some(value => String(value ?? '').toLocaleLowerCase().includes(recordQuery.toLocaleLowerCase())));
            const search = `<form class="nd-foot" id="nd-record-search">
                <input class="text_pole" type="search" aria-label="Search this record" value="${h(recordQuery)}" placeholder="Search facts, quotes or witnesses">
                <button class="menu_button" type="submit">Search</button></form>`;
            const parts = {
                facts: ['What has happened', s.canon.length, () => `
                    <p class="nd-note"><i class="fa-solid fa-user-secret nd-on"></i> lit: the fact is secret, and characters in the scene who did not see it are played as not knowing. Dim: an ordinary fact. Click the icon to switch. Major facts always count; minor ones fade after a few turns. ${Number(api.getSettings().cleanEvery) > 0 ? `Every ${Number(api.getSettings().cleanEvery)} turns the clean-up merges facts that say the same thing into one (the most current wins) and retires minor ones that no longer matter; retired facts stay listed here.` : 'The fact clean-up is off.'}</p>
                    ${search}
                    ${grouped(filter(s.canon).slice().reverse(), fact, 'World facts', 'newest first', 'Cast knowledge', 'by character')}
                    <h4>Undone <small>the narrator is told these did not happen</small></h4>
                    ${s.tombstones.map((t, i) => item(t.fact, button('forget-retcon', 'Allow again', `data-i="${i}"`))).join('') || empty('Nothing has been undone.')}`],
                rumours: ['Rumours', s.uncertain.length, () => `
                    <p class="nd-note">Hinted, rumoured or planned off-screen, and not confirmed by the narration yet.</p>
                    ${search}
                    ${grouped(filter(s.uncertain), hint, 'World hearsay', 'about places, events and things', 'Cast rumours', 'by character')}`],
                threads: ['Threads', s.threads.filter(t => t.status !== 'resolved').length, () => `
                    <h4>Threads <small>open questions, promises and dangers</small></h4>
                    ${s.threads.map(t => item(t.setup, t.status === 'resolved' ? button('drop-thread', 'Remove', `data-id="${h(t.id)}"`) : button('resolve-thread', 'Resolved', `data-id="${h(t.id)}"`) + button('drop-thread', 'Remove', `data-id="${h(t.id)}"`), `${h(t.status)}${t.payoff ? ` · ${h(t.payoff)}` : ''}`)).join('') || empty('None.')}`],
                summaries: ['Turn summaries', (api.getSettings().memory ?? 'director') !== 'director' ? Math.min(2, s.summaries.recent.length) : s.summaries.recent.length, () => (api.getSettings().memory ?? 'director') !== 'director' ? `
                    <p class="nd-note">${api.getSettings().memory === 'extension' ? 'Another extension keeps the story\'s memory and feeds the narrator.' : 'No story memory is kept.'} ${api.getSettings().memory === 'extension' ? 'Only the last 2 turns below go to the narrator and the planner, beside that extension\'s own record;' : 'Nothing here is sent to the narrator;'} nothing is rolled up. Change this under "Who keeps the story's memory" in the settings.</p>
                    <h4>Last 2 turns <small>newest first</small></h4>
                    ${sv.latest.slice(0, 2).map(x => item(x.text, '', `message ${x.i + 1}${x.hidden ? ' · hidden' : ''}`)).join('') || empty('None yet.')}` : `
                    <div data-form="rolled">
                        <h4>Aggregate summary <small>older turns, rolled up; sent once those messages leave the prompt</small></h4>
                        ${area('rolled', s.summaries.rolled, 4, 'Nothing rolled up yet.')}
                        <div class="nd-actions">${button('save-rolled', 'Save the summary')}${button('cmd', 'Roll up now', 'data-cmd="rollup"')}${s.meta.staleRollup ? '<small class="nd-warn">An earlier roll-up covered a deleted message and was dropped.</small>' : ''}</div>
                    </div>
                    ${sv.older.length ? `<h4>Older turns, not rolled up yet <small>${sv.older.length} · messages ${sv.older[0].i + 1} to ${sv.older.at(-1).i + 1}</small></h4>
                        ${pre(sv.older.map(x => x.text).join(' '))}<small>Roll up now folds these into the aggregate summary.</small>` : ''}
                    <h4>Latest turns <small>${sv.latest.length}, newest first</small></h4>
                    ${sv.latest.map(x => item(x.text, '', `message ${x.i + 1}${x.hidden ? ' · hidden' : ''}`)).join('') || empty('None yet.')}`],
                lore: ['Living lore', book?.entries.length ?? '', () => `
                    <h4>Lore the story has added <small>${book.entries.length}</small></h4>
                    ${book.entries.map(lore).join('') || empty('None yet. A person, place or thing must recur before it earns an entry.')}
                    <h4>Waiting to recur <small>${book.waiting.length}</small></h4>
                    ${book.waiting.map(lore).join('') || empty('None.')}`],
            };
            if (!parts[recordPart]) recordPart = 'facts';
            return `<div class="nd-seg nd-subtabs">${Object.entries(parts).map(([id, [label, n]]) => `<button type="button" class="menu_button ${id === recordPart ? 'nd-on' : ''}" data-act="record-part" data-value="${id}" aria-pressed="${id === recordPart}">${h(label)} <small>${n}</small></button>`).join('')}</div>
                ${parts[recordPart][2]()}`;
        },

        log(s) {
            const calls = director.calls;
            const names = Object.keys(calls).sort((a, b) => calls[b].at - calls[a].at);
            if (!names.includes(logModule)) logModule = names[0] ?? null;
            const c = logModule ? calls[logModule] : null;
            return `
                <h4>Director errors</h4>
                ${director.errors.slice().reverse().map(e => `<div class="nd-line nd-warn"><div class="nd-line-text"><b>${h(moduleLabel(e.module))}</b> ${h(e.error)}<br><small>${h(failureHint(e.error))}</small></div>${e.mid ? button('source', 'Source', `data-mid="${h(e.mid)}"`) : ''}</div>`).join('') || empty('None.')}
                ${director.errors.length ? `<div class="nd-actions">${button('cmd', 'Retry failed calls', 'data-cmd="retry"')}</div>` : ''}
                <h4>Corrections sent to the narrator</h4>
                ${s.flags.slice(-8).reverse().map(f => `<div class="nd-line"><div class="nd-line-text"><b>Turn ${f.turn}</b> ${h(f.correction)}<br><small>“${h(f.quote)}” against: ${h(f.conflicts_with)}</small></div></div>`).join('') || empty('None.')}
                <h4>Proposed changes that were refused</h4>
                ${s.meta.rejections.slice(-12).reverse().map(r => `<div class="nd-line"><div class="nd-line-text"><b>${h(r.kind)}</b> ${h(r.reason)}<br><small>${h(JSON.stringify(r.item)).slice(0, 200)}</small></div></div>`).join('') || empty('None.')}
                <h4>Cost this session <small>per module</small></h4>
                ${(() => {
                    const usage = director.usage ?? {};
                    const mods = Object.keys(usage).sort((a, b) => usage[b].promptTokens - usage[a].promptTokens);
                    if (!mods.length) return empty('No director calls yet in this session.');
                    const cell = 'style="padding:2px 8px;text-align:right"', left = 'style="padding:2px 8px;text-align:left"';
                    const rows = mods.map(m => `<tr><td ${left}>${h(MODULE_LABELS[m] ?? m)}</td><td ${cell}>${usage[m].calls}</td><td ${cell}>${usage[m].promptTokens}</td><td ${cell}>${usage[m].answerTokens}</td></tr>`).join('');
                    return `<table style="border-collapse:collapse;width:100%"><thead><tr><th ${left}>Module</th><th ${cell}>Calls</th><th ${cell}>Prompt ~tokens</th><th ${cell}>Answer ~tokens</th></tr></thead><tbody>${rows}</tbody></table>
                        <p class="nd-note">Rough estimates from text length (about 4 characters per token), not the provider's count. Resets when the chat changes.</p>`;
                })()}
                <h4>Last call of each module</h4>
                ${names.length ? `<div class="nd-seg">${names.map(n => `<button type="button" class="menu_button ${n === logModule ? 'nd-on' : ''}" data-act="log-module" data-value="${h(n)}" aria-pressed="${n === logModule}">${h(MODULE_LABELS[n] ?? n)}</button>`).join('')}</div>` : empty('No director calls yet in this session.')}
                ${c ? `<p class="nd-note">${c.ms} ms${c.promptTokens != null ? ` · sent ${c.promptChars} chars (~${c.promptTokens} tokens) · answered ${c.answerChars} chars (~${c.answerTokens} tokens)` : ''}${c.error ? ` · <span class="nd-warn">failed: ${h(c.error)}</span>` : ''}</p>
                    <h4>What it answered</h4>${pre(c.raw || '(nothing)')}
                    <h4>What it was sent</h4>${c.messages.map(m => `<small>${h(m.role)}</small>${pre(m.content)}`).join('')}` : ''}
                <h4>What cards and lore can read <small>chat variables</small></h4>
                ${pre(Object.entries(publicVars(s).flags).map(([k, v]) => `${k} = ${v}`).join('\n'))}
                <h4>Director state</h4>
                ${button('show-state', 'Show full state')}`;
        },
    };

    /**
     * What is failing right now, on top of every tab (audit, 22 Nov 2026: failures were only in the Log tab). Each line
     * says what the part does, the error, and what to do; one Retry for all.
     */
    function failingBanner() {
        const failing = Object.values(director.failing ?? {});
        if (!failing.length) return '';
        const lines = failing.map(f => `<div class="nd-line"><div class="nd-line-text"><b>${h(moduleLabel(f.module))}</b> is failing${f.count > 1 ? ` (${f.count}×)` : ''}: ${h(String(f.error).slice(0, 220))}<br><small>${h(failureHint(f.error))}</small></div></div>`).join('');
        return `<div class="nd-failing">${lines}<div class="nd-actions">${button('cmd', 'Retry now', 'data-cmd="retry"')}</div></div>`;
    }

    /** A dot on the menu entry while something fails, so it is seen with the panel closed. */
    function badge() {
        const n = Object.keys(director.failing ?? {}).length;
        const wand = $('#nd-wand');
        wand.find('.nd-badge').remove();
        if (n) wand.append(`<span class="nd-badge" title="${n} director part${n > 1 ? 's' : ''} failing">${n}</span>`);
    }

    // ------------------------------------------------------------ rendering
    function render(force = false) {
        if (!open) return;
        if (!director.owns()) return;
        renderedEpoch = director.epoch;
        const ref = api.narratorRef();
        $('#nd-inspector .nd-tabs button').each(function () {
            const selected = this.dataset.ndTab === tab;
            $(this).toggleClass('nd-active', selected).attr('aria-current', selected ? 'true' : null);
        });
        setStatus('#nd-unsaved', dirty ? 'unsaved changes' : '');
        if (!ref) {
            dirty = false;
            setStatus('#nd-status', 'not active here');
            $('#nd-failure-link').prop('hidden', true);
            const paused = api.narratorInChat?.() && api.getSettings().enabled;
            $('#nd-body').html(paused
                ? `<p class="nd-note">The director is off for this chat.</p><div class="nd-actions">${button('cmd', 'Turn the director back on for this chat', 'data-cmd="on"')}</div>`
                : '<p class="nd-note">The director is not active in this chat. It runs only with the Narrator card: open a chat with it, or add it to a group with your cards.</p>');
            return;
        }
        const failing = Object.values(director.failing ?? {});
        setStatus('#nd-status', director.running ? 'working…' : `Narrator ${ref.name}`);
        $('#nd-failure-link').prop('hidden', !failing.length).text(`${failing.length} failing`);
        // Never redraw over something the player is typing or has not saved.
        if (!force && (dirty || $('#nd-body').find('input:focus, textarea:focus, select:focus').length)) return;
        const scroll = $('#nd-body').scrollTop();
        try {
            $('#nd-body').html(failingBanner() + tabs[tab](director.readView()));
        } catch (e) {
            $('#nd-body').html(pre(String(e?.stack ?? e)));
        }
        $('#nd-body').scrollTop(scroll);
    }

    function show(on) {
        if (on === open) return;
        open = on;
        $('#nd-inspector').toggleClass('nd-hidden', !on);
        if (on) {
            returnFocus = document.activeElement;
            render();
            document.querySelector('#nd-inspector .nd-active')?.focus();
        } else {
            if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus();
            else document.querySelector('#extensionsMenuButton')?.focus();
        }
    }

    function setStatus(selector, message) {
        const node = $(selector);
        if (node.text() !== message) node.text(message);
    }

    function done(message) {
        dirty = false;
        if (message) {
            setStatus('#nd-feedback', message);
            toastr.success(message, 'Narrator Director');
        }
        render(true);
    }

    async function say() {
        const epoch = renderedEpoch;
        if (!director.owns(epoch)) return;
        const value = String($('#nd-say').val()).trim();
        if (!value) return;
        $('#nd-say').val('');
        let out;
        try { out = await api.command(value); } catch (error) {
            if (director.owns(epoch)) setStatus('#nd-feedback', String(error?.message ?? error));
            return;
        }
        if (!director.owns(epoch)) return;
        if (out) setStatus('#nd-feedback', String(out).slice(0, 300));
        render();
    }

    // ------------------------------------------------------------ actions
    const parseStatuses = (textValue, old) => fromCommas(textValue).map(part => {
        const m = part.match(/^(.*?)\s*\((\w+)\)\s*$/);
        const name = (m ? m[1] : part).trim();
        const prev = old.find(x => x.name.toLowerCase() === name.toLowerCase());
        const severity = m && SEVERITY.includes(m[2].toLowerCase()) ? m[2].toLowerCase() : (prev?.severity ?? 'mild');
        return { ...(prev ?? { treated: false, since: director.view().meta.turn, affects: null }), name, severity };
    });

    async function commandAction(text, epoch) {
        const out = await api.command(text);
        if (!director.owns(epoch)) return;
        if (out) setStatus('#nd-feedback', String(out).slice(0, 300));
        render();
    }

    const actions = {
        cmd(el, epoch) { return commandAction(el.dataset.cmd, epoch); },
        async setup(_el, epoch) {
            const out = await api.setupGroup();
            if (!director.owns(epoch)) return;
            toastr.info(out, 'Narrator Director');
            done();
        },
        'log-module'(el) { logModule = el.dataset.value; render(true); },
        'show-state'(el) {
            el.insertAdjacentHTML('afterend', pre(director.readView()));
            el.remove();
        },
        async source(el, epoch) {
            const target = await api.showSource(el.dataset.mid, epoch);
            if (!director.owns(epoch)) return;
            if (!target?.getClientRects().length) {
                setStatus('#nd-feedback', 'The source reply is no longer visible in this chat.');
                return;
            }
            show(false);
            target.tabIndex = -1;
            target.focus({ preventScroll: true });
            target.scrollIntoView({ block: 'center' });
        },
        'record-part'(el) {
            if (dirty && !confirm('Discard unsaved changes on this part?')) return;
            dirty = false;
            recordPart = el.dataset.value;
            $('#nd-body').scrollTop(0);
            render(true);
        },

        'save-scene'(el) {
            const form = formOf(el), f = read(form), edited = editedFields(form), fields = [];
            for (const key of ['location', 'time']) if (edited.has(key)) {
                const value = f[key].trim();
                fields.push([`scene.${key}`, { value, established: !!value }]);
            }
            for (const key of ['mood', 'initiative']) if (edited.has(key)) fields.push([`scene.${key}`, f[key].trim()]);
            let presence = false;
            if (edited.has('present') || edited.has('add')) {
                const add = fromCommas(f.add), remove = [];
                for (const input of form.querySelectorAll('[data-f="present"][data-nd-edited]')) {
                    (input.checked ? add : remove).push(input.value);
                }
                if (add.length || remove.length) presence = api.playerOp({ kind: 'scene-presence', add, remove });
            }
            if (fields.length) api.editStates(fields);
            else if (presence) api.editStates([]);
            done(fields.length || presence ? 'Scene saved' : 'No scene changes to save');
        },

        'save-cast'(el) {
            const form = formOf(el), f = read(form), name = form.dataset.name, edited = editedFields(form);
            const state = director.view(), c = state.cast[name];
            if (!c) { done(`${name} is no longer in the cast`); return; }
            if (!edited.size) { done('No cast changes to save'); return; }
            const fields = [];
            const wants = edited.has('agenda.wants') ? cleanWants(fromLines(f['agenda.wants'])) : undefined;
            for (const key of edited) {
                const value = f[key];
                if (key === 'agenda.wants') continue;
                if (key === 'statuses') fields.push([key, parseStatuses(value, c.statuses)]);
                else if (key === 'beliefs') fields.push([key, fromLines(value).map(b => ({ believes: b, true: false, source: 'player', turn: state.meta.turn }))]);
                else if (key === 'stances') fields.push([key, Object.fromEntries(fromCommas(value).map(p => p.split(':'))
                    .filter(p => p.length === 2 && p[0].trim()).map(([n, v]) => [n.trim(), Math.max(-10, Math.min(10, Number(v) || 0))]))]);
                else if (key.startsWith('rel.')) fields.push([key, Math.max(-10, Math.min(10, value))]);
                else if (key.startsWith('stats.')) fields.push([key, Math.max(1, Math.min(130, value || STAT_BASELINE))]);
                else fields.push([key, typeof value === 'string' ? value.trim() : value]);
            }
            api.playerOp({ kind: 'cast', action: 'edit', name, fields, ...(wants ? { wants } : {}) });
            api.playerOp({ kind: 'note', text: 'the cast record was corrected; use the current details' });
            done(`${name} saved`);
        },

        async 'rename-cast'(el, epoch) {
            const name = formOf(el).dataset.name;
            const c = ctx();
            const question = `<h3>Rename ${h(name)}</h3><small>Renaming onto someone already in the cast joins the two; that entry is kept.</small>`;
            const answer = c.callGenericPopup ? await c.callGenericPopup(question, c.POPUP_TYPE.INPUT, name) : prompt(`Rename ${name}`, name);
            if (!director.owns(epoch)) return;
            const to = typeof answer === 'string' ? answer.trim() : '';
            if (!to || to === name) return;
            api.playerOp({ kind: 'cast', action: 'rename', name, to });
            done(`${name} is now ${to}`);
        },

        'lock-cast'(el) {
            const name = formOf(el).dataset.name, action = el.dataset.lock;
            api.playerOp({ kind: 'cast', action, name });
            done(action === 'lock' ? `${name} locked as main cast` : `${name} unlocked`);
        },

        'remove-cast'(el) {
            const name = formOf(el).dataset.name;
            if (!confirm(`Remove ${name} from the cast? Facts about them stay.`)) return;
            api.playerOp({ kind: 'cast', action: 'remove', name });
            done(`${name} removed from the cast`);
        },

        async 'save-profile'(el, epoch) {
            const f = read(formOf(el)), g = director.view().genre ?? {};
            const saved = await api.confirmGenre({
                ...g, dominant: f.dominant, secondary: fromCommas(f.secondary), register: f.register, pov: f.pov, tempo: f.tempo,
                lethality: f.lethality, stakes: f.stakes, priority: fromLines(f.priority), promises: fromLines(f.promises), avoid: fromLines(f.avoid),
                stats_focus: f.stats_focus ?? [],
            });
            if (!director.owns(epoch)) return;
            if (saved) done('Story profile saved');
            else setStatus('#nd-feedback', 'Enter a genre before saving the story profile.');
        },

        'save-premise'(el) { api.host.setSetup({ premise: read(formOf(el)).premise.trim() }); done('Premise saved'); },

        'save-arc'(el) {
            const f = read(formOf(el)), arc = director.view().arc ?? {};
            const endings = fromLines(f.endings).map(title => (arc.endings ?? []).find(e => e.title === title) ?? { title, outcomes: {} });
            if (endings.length < 2) return toastr.warning('Keep at least two possible endings, or the arc becomes a script.', 'Narrator Director');
            const hooks = fromLines(f.hooks).map(line => { const [t, flag] = line.split('|').map(x => x.trim()); return { text: t, planted: flag === 'planted' }; });
            api.editState('arc', {
                ...arc, goal: f.goal.trim(), forces: fromLines(f.forces), tension: f.tension, act: Math.max(1, Math.min(5, f.act || 1)),
                payoff: { ...(arc.payoff ?? {}), name: f.payoff.trim(), act: Math.max(1, Math.min(5, f.payoffAct || 3)), hooks }, endings,
            });
            done('Arc saved');
        },

        'add-scene'() {
            const holder = document.querySelector('#nd-scenes');
            holder.querySelector('.nd-empty')?.remove();
            holder.insertAdjacentHTML('beforeend', document.querySelector('#nd-scene-template').innerHTML);
            holder.lastElementChild.querySelector('input, textarea')?.focus();
            dirty = true; $('#nd-unsaved').text('unsaved changes');
        },
        'remove-scene'(el) { el.closest('.nd-scene').remove(); dirty = true; $('#nd-unsaved').text('unsaved changes'); },
        'save-scenes'() {
            const scenes = [...document.querySelectorAll('#nd-scenes .nd-scene')].map((row, n) => {
                const f = read(row);
                const focus = Object.fromEntries(fromLines(f.focus).map(l => l.split(':')).filter(p => p.length >= 2 && p[0].trim()).map(([name, ...rest]) => [name.trim(), rest.join(':').trim()]));
                return { id: row.dataset.id || `s-ui-${Date.now()}-${n}`, purpose: f.purpose.trim(), if_unchallenged: fromLines(f.if_unchallenged), choice_points: fromLines(f.choice_points), focus };
            }).filter(sc => sc.purpose);
            api.editState('scenes', scenes);
            done('Scenes saved');
        },

        'add-beat'() {
            const holder = document.querySelector('#nd-beats');
            holder.querySelector('.nd-empty')?.remove();
            holder.insertAdjacentHTML('beforeend', document.querySelector('#nd-beat-template').innerHTML);
            holder.lastElementChild.querySelector('input, textarea')?.focus();
            dirty = true;
            $('#nd-unsaved').text('unsaved changes');
        },
        'remove-beat'(el) { el.closest('.nd-beat').remove(); dirty = true; $('#nd-unsaved').text('unsaved changes'); },
        'save-beats'() {
            const s = director.view();
            const old = new Map(s.beats.map(b => [b.id, b]));
            const queued = [...document.querySelectorAll('#nd-beats .nd-beat')].map((row, n) => {
                const f = read(row), prev = old.get(row.dataset.id);
                const id = prev?.id ?? `b-ui-${Date.now()}-${n}`;
                const clues = fromLines(f.clues).map((line, k) => {
                    const [t, route, where, flag] = line.split('|').map(x => x.trim());
                    const was = (prev?.clues ?? []).find(c => c.text === t);
                    return { id: was?.id ?? `${id}-c${k}`, text: t, route: CLUE_ROUTES.includes(route) ? route : 'place', where: where ?? '', found: flag === 'found' || !!was?.found };
                }).filter(c => c.text).slice(0, 3);
                return {
                    ...(prev ?? {}), id, scene: f.scene, lore: fromCommas(f.lore).slice(0, 3), clues, serves: f.serves || '',
                    // intent is the goal's old name, kept as a copy. Either text alone serves as both.
                    ...beatText(f), precondition: f.precondition.trim(), type: f.type, required: !!f.required, status: 'queued',
                };
            }).filter(b => b.goal);
            api.editState('beats', [...s.beats.filter(b => b.status !== 'queued'), ...queued]);
            done('Beats saved');
        },

        // ---- story spine
        'spine-track'(_el, epoch) { return commandAction('track', epoch); },
        'spine-draft'(_el, epoch) { return commandAction('spine', epoch); },
        'spine-mark'(el) {
            if (dirty && !confirm('Discard unsaved changes on the spine?')) return;
            api.playerOp({ kind: 'spine-mark', id: el.dataset.id, mark: el.dataset.mark });
            done();
        },
        'spine-conclude'(el) {
            if (dirty && !confirm('Discard unsaved changes on the spine?')) return;
            if (!confirm('Conclude this milestone now? Its open criteria become failed, and its checklist is replaced by a conclusion.')) return;
            api.playerOp({ kind: 'spine-conclude', milestone: el.dataset.id });
            done('Milestone concluded; its conclusion will be written shortly');
        },
        'spine-reopen'(el) {
            if (dirty && !confirm('Discard unsaved changes on the spine?')) return;
            api.playerOp({ kind: 'spine-reopen', milestone: el.dataset.id });
            done('Milestone reopened');
        },
        'spine-proposal'(el) {
            if (dirty && !confirm('Discard unsaved changes on the spine?')) return;
            const accept = el.dataset.accept === '1';
            api.playerOp({ kind: 'spine-proposal', accept });
            done(accept ? 'New ending added' : 'Kept the current endings');
        },
        'spine-add-criterion'(el) {
            const holder = el.closest('.nd-sp-item').querySelector('.nd-sp-crits');
            holder.insertAdjacentHTML('beforeend', document.querySelector('#nd-sp-crit-template').innerHTML);
            holder.lastElementChild.querySelector('textarea')?.focus();
            touched();
        },
        'spine-add-ending'() {
            const holder = document.querySelector('#nd-sp-endings');
            holder.querySelector('.nd-empty')?.remove();
            holder.insertAdjacentHTML('beforeend', document.querySelector('#nd-sp-ending-template').innerHTML);
            holder.lastElementChild.querySelector('textarea')?.focus();
            touched();
        },
        'spine-add-milestone'() {
            const holder = document.querySelector('#nd-sp-milestones');
            holder.querySelector('.nd-empty')?.remove();
            holder.insertAdjacentHTML('beforeend', document.querySelector('#nd-sp-milestone-template').innerHTML);
            holder.lastElementChild.querySelector('textarea')?.focus();
            touched();
        },
        'spine-remove'(el) { el.closest(el.dataset.what === 'crit' ? '.nd-sp-crit' : '.nd-sp-item').remove(); touched(); },
        'save-spine'() {
            const old = director.view().spine;
            if (!old) return;
            const sp = clone(old);
            const val = (root, f) => String(root.querySelector(`[data-f="${f}"]`)?.value ?? '').replace(/\s*\n\s*/g, ' ').trim();
            const stamp = Date.now();
            const criteriaOf = (itemEl, prevItem, itemId) => [...itemEl.querySelectorAll('.nd-sp-crit')].map((row, n) => {
                const text = val(row, 'ctext');
                const prev = (prevItem?.criteria ?? []).find(c => c.id && c.id === row.dataset.id);
                return prev ? { ...prev, text } : { id: `${itemId}-u${stamp}${n}`, text, mark: 'open' };
            }).filter(c => c.text);
            const items = (sel, list, prefix) => [...document.querySelectorAll(sel)].map((el, n) => {
                const prev = list.find(x => x.id && x.id === el.dataset.id);
                const id = prev?.id ?? `${prefix}-ui-${stamp}-${n}`;
                return { el, prev, id, title: val(el, 'title') };
            }).filter(x => x.title);
            sp.question = val(document.querySelector('#nd-spine'), 'question');
            sp.endings = items('#nd-sp-endings .nd-sp-item', old.endings ?? [], 'e').map(({ el, prev, id, title }) => ({
                ...(prev ?? {}), id, title, how: val(el, 'how'), criteria: criteriaOf(el, prev, id),
            }));
            sp.milestones = items('#nd-sp-milestones .nd-sp-item', old.milestones ?? [], 'm').map(({ el, prev, id, title }) => (prev?.status === 'concluded'
                ? { ...prev, title, conclusion: String(el.querySelector('[data-f="conclusion"]')?.value ?? '').trim() }
                : { ...(prev ?? { status: 'open', conclusion: '' }), id, title, criteria: criteriaOf(el, prev, id) }));
            const kept = new Set(sp.endings.map(e => e.id));
            sp.turnedAway = (sp.turnedAway ?? []).filter(id => kept.has(id));
            api.editState('spine', sp);
            done('Spine saved');
        },

        'toggle-secret'(el) { api.playerOp({ kind: 'fact-secret', id: el.dataset.id, secret: el.getAttribute('aria-pressed') !== 'true' }); done(); },
        'save-rolled'(el) { api.editState('summaries.rolled', read(formOf(el)).rolled.trim()); done('Summary saved'); },
        retcon(el) { api.playerOp({ kind: 'retcon', ids: [el.dataset.id] }); done('Undone. The narrator is told it did not happen.'); },
        'confirm-fact'(el) { api.playerOp({ kind: 'fact-review', id: el.dataset.id, confirm: true }); done('Confirmed'); },
        'drop-fact'(el) { api.playerOp({ kind: 'fact-review', id: el.dataset.id }); done('Removed'); },
        'resolve-thread'(el) { api.playerOp({ kind: 'thread-review', id: el.dataset.id, resolve: true }); done('Thread resolved'); },
        'drop-thread'(el) { api.playerOp({ kind: 'thread-review', id: el.dataset.id }); done('Thread removed'); },
        'forget-retcon'(el) { api.editState('tombstones', director.view().tombstones.filter((_, i) => i !== Number(el.dataset.i))); done('Allowed again'); },
    };

    $('#nd-inspector')
        .on('click', '#nd-close', () => show(false))
        .on('click', '#nd-refresh', () => { if (!dirty || confirm('Discard unsaved changes?')) { dirty = false; render(true); } })
        .on('click', '[data-nd-tab]', function () {
            if (dirty && !confirm('Discard unsaved changes on this tab?')) return;
            dirty = false;
            tab = this.dataset.ndTab;
            $('#nd-body').scrollTop(0);
            render(true);
        })
        .on('input change', '#nd-body [data-f]', function () {
            this.dataset.ndEdited = '1';
            dirty = true;
            setStatus('#nd-unsaved', 'unsaved changes');
        })
        .on('keydown', '#nd-body textarea[data-one]', (e) => { if (e.key === 'Enter') e.preventDefault(); })
        .on('click', '#nd-send', say)
        .on('submit', '#nd-record-search', function (e) {
            e.preventDefault();
            recordQuery = this.querySelector('input').value.trim();
            render(true);
            document.querySelector('#nd-record-search input')?.focus();
        })
        .on('keydown', '#nd-say', (e) => { if (e.key === 'Enter') say(); })
        .on('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); show(false); } })
        .on('click', '[data-act]', async function () {
            const epoch = renderedEpoch;
            if (!director.owns(epoch)) return;
            try { await actions[this.dataset.act]?.(this, epoch); } catch (e) {
                if (!director.owns(epoch)) return;
                console.error('[Narrator Director]', e);
                setStatus('#nd-feedback', String(e?.message ?? e));
            }
        });

    return {
        update(reason) {
            if (reason === 'chat') {
                $('#nd-say').val('');
                recordQuery = '';
                setStatus('#nd-feedback', '');
            }
            badge();
            render(reason === 'chat');
            // Removing a focused input can fire its delegated change handler during the redraw.
            if (reason === 'chat') {
                dirty = false;
                $('#nd-unsaved').text('');
            }
        },
        open: () => show(true),
        close: () => show(false),
        showLog: () => {
            if (dirty && !confirm('Discard unsaved changes?')) return;
            dirty = false;
            tab = 'log';
            if (open) render(true);
            else show(true);
        },
    };
}
