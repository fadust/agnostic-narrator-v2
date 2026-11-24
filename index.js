// Narrator Director: SillyTavern glue. Everything with rules in it lives in core/ and is tested in Node;
// this file only connects SillyTavern's events, prompt slots and World Info to that core.
// Tested against SillyTavern 1.19.0 (release, 06bde93).

import { extension_prompt_roles, extension_prompt_types, showMoreMessages } from '../../../../script.js';
import { group_generation_mode } from '../../../group-chats.js';
import { buildBrief, buildStoryBlock, cueInPrompt } from './core/brief.js';
import { DEFAULTS, Director } from './core/director.js';
import { extractJson } from './core/json.js';
import { DYNAMIC_WORLD, toWorldInfoEntry } from './core/lore.js';
import { validateGenre } from './core/planner.js';
import { openingPrompt, premisePrompt, revisePrompt } from './core/prompts.js';
import { castPeople, classify, storyBasis } from './core/state.js';
import { cleanDialogue, cleanSpokenLineGap, FALLBACK_NOTE, hasLeak, parseTags, stripDirector } from './core/text.js';
import { clone, similarity, str } from './core/util.js';
import { clearVars, publicVars, writeVars } from './core/vars.js';
import { makeCall } from './st/call.js';
import { parseDirectorCommand } from './st/commands.js';
import { makeGroupSettings, saveGroupSettings } from './st/group.js';
import { failureHint, moduleLabel } from './core/failures.js';
import { memoryGaps, memoryStory, providerOptions, registerMemoryProvider } from './st/providers.js';
import { mountUi } from './st/ui.js';

const KEY = 'narrator_director';           // settings key, chat metadata key, card marker (data.extensions.narrator_director)
const PROMPT_BRIEF = 'narrator_director_brief';
const PROMPT_STORY = 'narrator_director_story';
const PROMPT_SCAN = 'narrator_director_scan';
const MACRO = 'director_notes';
const SKIP_TYPES = new Set(['quiet', 'impersonate']);
const SYSTEM_PROMPT_SOURCES = new Set(['claude', 'makersuite', 'vertexai']);

const SETTINGS_DEFAULTS = {
    enabled: true,
    profile: '',                 // connection profile id for all modules; '' = current connection
    profiles: {},                // per-module overrides: observer, tracker, planner, summariser, genre, profile, opening
    castLimit: 4,                // above this many cast cards, the group runs in swap mode and the director injects the cast
    placement: 'auto',           // auto | depth | system | macro
    greetings: 'hide',           // hide | keep: other members' greetings in a narrator group
    cadence: DEFAULTS.cadence,
    nudgeAfter: DEFAULTS.nudgeAfter,
    stallAfter: DEFAULTS.stallAfter,
    dormantAfter: DEFAULTS.dormantAfter,
    rollEvery: DEFAULTS.rollEvery,
    backfill: DEFAULTS.backfill,
    trackEvery: DEFAULTS.trackEvery,
    cleanEvery: DEFAULTS.cleanEvery,
    cleanAbove: DEFAULTS.cleanAbove,
    recurrence: DEFAULTS.recurrence,
    briefTokens: DEFAULTS.briefTokens,
    storyTokens: DEFAULTS.storyTokens,
    maxRetries: DEFAULTS.maxRetries,
    tokens: { ...DEFAULTS.tokens },   // longest answer per module
    setTemps: true,              // send a temperature with director calls made through a connection profile
    tempRecord: 0.2,             // observer, summariser, story profile, character profiles: quotes must be exact
    tempPlan: 0.7,               // planner and opening: variety is wanted
    mirrorLore: true,            // keep real lorebook files for the director's entries, so other extensions can look them up
    memory: 'director',          // director | extension | off: who keeps the story's memory and feeds it to the narrator
    memoryProvider: 'auto',      // with memory 'extension': auto | baibai | summarize | macro (see st/providers.js)
    memoryMacro: '',             // with memoryProvider 'macro': the macro to read, e.g. bbsHistory
    stripTags: 'bbs_start, bbs_end, bbs_items, bbs_vars, bbi_image',   // other extensions' tags removed, content included, before the director reads a reply
};

const ctx = () => SillyTavern.getContext();
// SillyTavern reuses the chat array, and its selection can change before CHAT_CHANGED fires.
function chatKey() {
    const c = ctx();
    const owner = c.groupId ? ['group', c.groupId] : ['character', c.characters?.[c.characterId]?.avatar ?? c.characterId];
    return JSON.stringify([...owner, c.getCurrentChatId?.(), c.chatMetadata?.integrity]);
}

let settings = { ...SETTINGS_DEFAULTS };
const modelCall = makeCall({ getContext: () => ctx(), getSettings: () => settings });
let genType = 'normal';
let generating = false;
let generatingSince = 0;
let currentBrief = '';
let lastBrief = { text: '', scan: '', lines: {}, fallback: true };
let pendingCue = null;
let lastStory = { text: '', overflow: false, tokens: 0 };
let firstIncluded = 0;
let loreKeys = [];
let kickTimer = null;
let ui = null;
const CHAT_CHANGED = 'The chat changed before the director could finish.';

// ---------------------------------------------------------------- activation

const isNarratorCard = (ch) => !!ch?.data?.extensions?.[KEY];

function meta(create = false) {
    const c = ctx();
    if (!c.chatMetadata) return null;
    if (!c.chatMetadata[KEY] && create) c.chatMetadata[KEY] = { v: 1, setup: {} };
    return c.chatMetadata[KEY] ?? null;
}

function currentGroup() {
    const c = ctx();
    return c.groupId ? c.groups.find(g => g.id === c.groupId) ?? null : null;
}

function groupMembers(group = currentGroup()) {
    const c = ctx();
    return group ? group.members.map(av => c.characters.find(ch => ch.avatar === av)).filter(Boolean) : [];
}

/** The narrator of the open chat, or null when the director has no business here. */
function narratorRef() {
    if (!settings.enabled) return null;
    const c = ctx();
    const m = meta();
    if (m?.enabled === false) return null;
    const group = currentGroup();
    if (group) {
        const members = groupMembers(group);
        // Only the Narrator card (marked in its data) turns the director on; any other card never does.
        const n = members.find(isNarratorCard);
        return n ? { name: n.name, avatar: n.avatar, group: true, neutral: neutralPrefixes(n), strip: parseTags(settings.stripTags) } : null;
    }
    const ch = c.characters[c.characterId];
    if (!ch || c.groupId) return null;
    return isNarratorCard(ch) ? { name: ch.name, avatar: ch.avatar, group: false, neutral: neutralPrefixes(ch), strip: parseTags(settings.stripTags) } : null;
}

/** Whether the open chat has the Narrator card (solo, or a group member), whatever the on/off switches say. */
function narratorInChat() {
    const c = ctx();
    const group = currentGroup();
    if (group) return groupMembers(group).some(isNarratorCard);
    return !c.groupId && isNarratorCard(c.characters[c.characterId]);
}

/** The narrator card marks which of its greetings are neutral openers (data.extensions.narrator_director.neutral). */
function neutralPrefixes(ch) {
    const list = ch?.data?.extensions?.[KEY]?.neutral;
    return Array.isArray(list) ? list.filter(p => typeof p === 'string' && p.length >= 12) : [];
}

// ---------------------------------------------------------------- host for the core director

function castCards() {
    const c = ctx();
    const ref = narratorRef();
    const members = ref?.group ? groupMembers().filter(ch => ch.avatar !== ref.avatar) : [];
    return members.map(ch => {
        const fill = (t) => String(t ?? '').replace(/{{char}}/gi, ch.name).replace(/<BOT>/g, ch.name);
        const parts = [fill(ch.description), fill(ch.personality)].filter(s => s.trim());
        return { name: ch.name, text: parts.join('\n'), talkativeness: Number(ch.talkativeness ?? 0.5) };
    });
}

const host = {
    chat: () => ctx().chat,
    chatKey,
    narrator: narratorRef,
    setup: () => ({ ...(meta()?.setup ?? {}), player: ctx().name1 }),
    setSetup(patch) {
        if (!director.owns()) return;
        const m = meta(true);
        Object.assign(m.setup, patch);
        ctx().saveMetadataDebounced();
        if (patch.genre && !patch.genre.confirmed) {
            toastr.info(`Story profile drafted: ${[patch.genre.dominant, ...patch.genre.secondary].join(' / ')}. Review it with /director inspect.`, 'Narrator Director');
        }
        refresh('setup');
    },
    settings: () => settings,
    save: () => { if (director.owns()) return ctx().saveChat(); },
    // A change the player made in the inspector (a milestone concluded, a criterion marked, a cast edit) may leave
    // work due: start the director, as a chat event would, rather than waiting for the next reply.
    changed: (reason) => { refresh(reason); if (reason === 'player') scheduleKick(); },
    firstIncluded: () => firstIncluded,
    loreKeys: () => loreKeys,
    loreEntries: () => loreEntries,
    castNames: () => castCards().map(card => card.name),
    memoryStory: () => memoryStory(settings),
    call: (...args) => modelCall(...args),
    generating: () => generating,
    // A part of the director starts failing, or answers again (audit, 22 Nov 2026: failures were silent).
    failed(module, entry, first) {
        if (entry && first) {
            toastr.warning(`${moduleLabel(module)} failed: ${String(entry.error).slice(0, 160)}. ${failureHint(entry.error)}`, 'Narrator Director', { timeOut: 12000, onclick: () => ui?.showLog?.() });
        } else if (!entry) {
            toastr.success(`${moduleLabel(module)} works again.`, 'Narrator Director', { timeOut: 4000 });
        }
        ui?.update('errors');
    },
    async cards() {
        const c = ctx();
        const cards = castCards().map(({ name, text }) => ({ name, text }));
        const persona = c.powerUserSettings?.persona_description;
        // The player character's own lorebook entry counts too (audit, 21 Nov 2026: a persona holding only looks left a
        // lore-written S-class fighter profiled as an ordinary man).
        const low = String(c.name1 ?? '').trim().toLowerCase();
        const mine = low ? loreEntries.filter(e => [e.comment, e.keys[0]].some(k => String(k ?? '').trim().toLowerCase() === low)) : [];
        const text = [persona, ...mine.map(e => e.content.trim())].filter(Boolean).join('\n\n').slice(0, 4000);
        if (c.name1 && text) cards.push({ name: c.name1, text, isPlayer: true, aliases: mine.flatMap(e => e.keys) });
        return cards;
    },
    async material() {
        const c = ctx();
        const ref = narratorRef();
        const parts = [];
        for (const card of castCards()) parts.push(`[Character: ${card.name}]\n${card.text.slice(0, 1500)}`);
        const group = currentGroup();
        const scenario = c.chatMetadata?.scenario || (group ? groupMembers(group).map(ch => ch.scenario).filter(Boolean).join('\n') : '');
        if (scenario) parts.push(`[Scenario]\n${String(scenario).slice(0, 1500)}`);
        const persona = c.powerUserSettings?.persona_description;
        if (persona) parts.push(`[Player character: ${c.name1}]\n${String(persona).slice(0, 800)}`);
        if (loreSample.length) parts.push(`[World notes]\n${loreSample.join('\n').slice(0, 3000)}`);
        const opening = c.chat.find(m => !m.is_user && classify(m, ref) === 'narration');
        if (opening) parts.push(`[Opening]\n${stripDirector(opening.mes).slice(0, 1500)}`);
        // The player's first message says what the player character is after (owner, 19 Nov 2026). Without a premise
        // from a card, the scenario or the lorebook, the story waits for it: a persona describes who the player is, never
        // the story, so a profile drafted from it alone goes wherever the persona's text leans.
        const first = c.chat.find(m => m.is_user && !m.is_system);
        if (first) parts.push(`[The player's opening move: what ${c.name1 || 'the player character'} sets out to do]\n${String(first.mes).slice(0, 1200)}`);
        const premise = castCards().length || scenario || loreSample.length;
        if (!premise && !first) return '';
        return parts.join('\n\n');
    },
};

const director = new Director(host);

// ---------------------------------------------------------------- outputs: variables, prompts, UI

function refresh(reason = '') {
    if (!director.owns()) return;
    const c = ctx();
    const ref = narratorRef();
    if (c.chatMetadata) {
        const vars = (c.chatMetadata.variables ??= {});
        const changed = ref ? writeVars(vars, publicVars(director.readView())) : clearVars(vars);
        if (changed) c.saveMetadataDebounced();
    }
    ui?.update(reason);
}

function presetHasMacro() {
    const c = ctx();
    const needle = `{{${MACRO}}}`;
    if (c.mainApi === 'openai') {
        const oai = c.chatCompletionSettings;
        const ids = new Set((oai.prompts ?? []).filter(p => String(p.content ?? '').includes(needle)).map(p => p.identifier));
        if (!ids.size) return false;
        return (oai.prompt_order ?? []).some(o => (o.order ?? []).some(e => e.enabled && ids.has(e.identifier)));
    }
    const pu = c.powerUserSettings ?? {};
    return JSON.stringify([pu.sysprompt, pu.context, pu.instruct]).includes(needle);
}

/** Where the brief goes: its own preset entry if there is one, else placed by backend. */
function placement() {
    if (settings.placement !== 'auto') return settings.placement;
    if (presetHasMacro()) return 'macro';
    const c = ctx();
    // Claude and Gemini turn a late system message into a user turn, which would merge the brief with the player's message.
    if (c.mainApi === 'openai' && SYSTEM_PROMPT_SOURCES.has(c.chatCompletionSettings.chat_completion_source)) return 'system';
    return 'depth';
}

const promptFilter = () => !SKIP_TYPES.has(genType);

function setPrompts(brief, story) {
    const c = ctx();
    const T = extension_prompt_types, SYSTEM = extension_prompt_roles.SYSTEM;
    currentBrief = brief?.text ?? '';
    const where = placement();
    if (!currentBrief || where === 'macro') c.setExtensionPrompt(PROMPT_BRIEF, '', T.NONE, 0);
    else if (where === 'system') c.setExtensionPrompt(PROMPT_BRIEF, currentBrief, T.IN_PROMPT, 0, false, SYSTEM, promptFilter);
    else c.setExtensionPrompt(PROMPT_BRIEF, currentBrief, T.IN_CHAT, 1, false, SYSTEM, promptFilter);
    c.setExtensionPrompt(PROMPT_STORY, story?.text ?? '', T.IN_PROMPT, 0, false, SYSTEM, promptFilter);
    // Scan-only: World Info reads it, the prompt never contains it. The only scanned block.
    c.setExtensionPrompt(PROMPT_SCAN, brief?.scan ?? '', T.NONE, 0, true, SYSTEM, promptFilter);
}

function clearPrompts() {
    currentBrief = '';
    const c = ctx();
    for (const k of [PROMPT_BRIEF, PROMPT_STORY, PROMPT_SCAN]) c.setExtensionPrompt(k, '', extension_prompt_types.NONE, 0);
}

/** Swap-mode cast for the story block: full cards for those present, short profiles for the rest. */
function injectedCast(state) {
    const group = currentGroup();
    if (!group || group.generation_mode !== group_generation_mode.SWAP) return [];
    const c = ctx();
    return castCards().map(card => {
        const people = castPeople(state, [card.name]);
        return {
            name: card.name,
            people,
            full: `[${card.name}]\n${c.substituteParams(card.text)}`,
            short: people.map(n => state.cast[n]?.profile).filter(Boolean).join(' ') || c.substituteParams(card.text).slice(0, 240),
        };
    });
}

/**
 * Generate interceptor: runs after the player's message is in the chat and before World Info scans.
 * Finishes the brief in code; no model call happens here. Never runs for dry runs.
 */
globalThis.narratorDirectorIntercept = async function (_coreChat, _contextSize, _abort, type) {
    try {
        if (!director.owns()) return clearPrompts();
        genType = type || 'normal';
        const ref = narratorRef();
        if (!ref) return clearPrompts();
        // Impersonate and quiet generations get nothing from the director. The prompt filters alone are not enough:
        // SillyTavern 1.19.0 ignores them for in-chat injections, so the blocks are removed and put back afterwards.
        if (SKIP_TYPES.has(genType)) return clearPrompts();
        director.sync();
        const c = ctx();
        const redo = ['swipe', 'regenerate', 'continue'].includes(genType);
        const state = director.readView({ includeProvisional: !redo });
        const last = c.chat.at(-1);
        const { entries } = director.readings(ref);
        const recentNarration = entries.filter(e => e.kind === 'narration').slice(-4).map(e => e.text);
        // Everyone a card holds shares that card's talkativeness.
        const talkativeness = Object.fromEntries(castCards().flatMap(card => castPeople(state, [card.name]).map(n => [n, card.talkativeness])));
        let playerMessage = '';
        if (last?.is_user) playerMessage = last.mes;
        else if (redo) playerMessage = [...c.chat].reverse().find(m => m.is_user)?.mes ?? '';
        lastBrief = buildBrief(state, { playerMessage, recentNarration, talkativeness, tokenCap: settings.briefTokens });
        lastStory = buildStoryBlock(state, { cast: injectedCast(state), firstIncluded, tokenCap: settings.storyTokens, memory: settings.memory, loreNames: loreKeys, unsummarised: settings.memory === 'extension' ? memoryGaps(settings) : null });
        setPrompts(lastBrief, lastStory);
        const existing = genType === 'swipe' || genType === 'continue';
        const index = c.chat.length - (existing ? 1 : 0);
        const anchor = c.chat[index - 1];
        const previousCue = genType === 'continue' ? entries[index]?.cue : null;
        pendingCue = { epoch: director.epoch, index, anchor, basis: anchor ? storyBasis(c.chat, ref, anchor) : null, previousCue, brief: lastBrief };
        ui?.update('brief');
    } catch (e) {
        console.error('[Narrator Director] interceptor failed; narrating without notes', e);
        clearPrompts();
    }
};

function onPromptAssembled(data, dryRun) {
    if (dryRun || !pendingCue || !director.owns(pendingCue.epoch)) return;
    const prompt = data?.prompt ?? data?.input;
    if (typeof prompt !== 'string' && !Array.isArray(prompt)) return;
    pendingCue.sent = cueInPrompt(pendingCue.brief, prompt, value => ctx().substituteParams(value));
}

// ---------------------------------------------------------------- events

function scheduleKick(delay = 400) {
    const epoch = director.epoch;
    clearTimeout(kickTimer);
    kickTimer = setTimeout(() => {
        if (!director.owns(epoch)) return;
        kickTimer = null;
        // A generation that never reported its end must not hold the director back for good.
        if (generating && Date.now() - generatingSince > 10 * 60_000) generating = false;
        if (generating) return scheduleKick(600);
        if (!narratorRef()) return;
        director.kick()?.catch(e => console.error('[Narrator Director]', e));
    }, delay);
}

/** Console handle for debugging and tests: narratorDirector.view(), .brief(), .idle(). */
globalThis.narratorDirector = {
    director,
    view: (opts) => director.view(opts),
    brief: () => lastBrief,
    story: () => lastStory,
    lorebook: () => director.lorebook(),
    idle: () => !kickTimer && !director.running && !generating,
    active: () => !!narratorRef(),
    ref: () => narratorRef(),
    firstIncluded: () => firstIncluded,
    /** Let an extension supply planner memory and optionally synchronous narrator coverage via gaps(). */
    registerMemoryProvider,
};

function onChatChanged() {
    clearTimeout(kickTimer);
    kickTimer = null;
    director.reset();
    generating = false;
    generatingSince = 0;
    genType = 'normal';
    firstIncluded = 0;
    loreKeys = [];
    loreEntries = [];
    loreSample = [];
    lastBrief = { text: '', scan: '', lines: {}, fallback: true };
    pendingCue = null;
    lastStory = { text: '', overflow: false, tokens: 0 };
    clearPrompts();
    if (narratorRef()) {
        director.sync();
        applyGroupRule().catch(console.error);
        scheduleKick();
    }
    refresh('chat');
}

function onGenerationStarted(type, _opts, dryRun) {
    if (dryRun || !director.owns()) return;
    pendingCue = null;
    genType = type || 'normal';
    if (!SKIP_TYPES.has(genType)) { generating = true; generatingSince = Date.now(); }
}

function onGenerationDone() {
    if (!director.owns()) return;
    generating = false;
    if (SKIP_TYPES.has(genType)) {
        genType = 'normal';
        if (narratorRef() && lastBrief.text) setPrompts(lastBrief, lastStory); // restore what the skipped generation removed
    }
    const n = Number(ctx().substituteParams('{{firstIncludedMessageId}}'));
    if (Number.isFinite(n)) firstIncluded = n;
    if (narratorRef()) { director.sync(); scheduleKick(); }
}

/** Apply the dialogue gap rule to saved replies even when card regexes are unavailable in a group. */
function formatSavedDialogue(text, { messageId, isUser, isSystem, isReasoning }) {
    if (isUser || isSystem || isReasoning || !text.includes('\x60')) return text;
    const message = ctx().chat[messageId];
    return message && classify(message, narratorRef()) === 'narration' ? cleanSpokenLineGap(text) : text;
}

/** Clean generated replies before the recorder or the next narrator prompt sees them. */
function onMessageReceived(id) {
    if (!director.owns()) return;
    const c = ctx();
    const m = c.chat[id];
    const ref = narratorRef();
    if (!ref || !m || m.is_user) return;
    let text = hasLeak(m.mes) ? stripDirector(m.mes) : m.mes;
    if (classify(m, ref) === 'narration') {
        text = cleanDialogue(text);
        const pending = pendingCue;
        if (pending?.sent && director.owns(pending.epoch) && Number(id) === pending.index && c.chat[id - 1] === pending.anchor) {
            const current = pending.sent;
            const previous = pending.previousCue;
            const sent = !current.beat && previous ? previous : {
                beat: current.beat,
                clues: previous?.beat === current.beat ? [...new Set([...previous.clues, ...current.clues])] : current.clues,
            };
            const receipt = { beat: sent.beat, clues: sent.clues, basis: pending.basis };
            (m.extra ??= {}).narratorCue = receipt;
            // Streaming saves swipe metadata before this event; non-streaming copies extra after it.
            const started = +new Date(m.gen_started);
            for (const [i, info] of (m.swipe_info ?? []).entries()) {
                if (info && (i === m.swipe_id || (started > 0 && +new Date(info.gen_started) === started))) {
                    (info.extra ??= {}).narratorCue = receipt;
                }
            }
            pendingCue = null;
        }
    }
    let dirty = text !== m.mes;
    if (dirty) {
        m.mes = text;
        if (Array.isArray(m.swipes) && typeof m.swipe_id === 'number') m.swipes[m.swipe_id] = m.mes;
    }
    if (hasLeak(m.extra?.reasoning)) { m.extra.reasoning = stripDirector(m.extra.reasoning); dirty = true; }
    if (dirty) { c.updateMessageBlock(id, m); c.saveChat(); }
    director.sync();
    scheduleKick();
}

const RETCON_OOC = /^\s*[([]?\s*OOC\s*[:：]\s*retcon\s*[:：]?\s*(.+?)[)\]]?\s*$/is;

function onMessageSent(id) {
    if (!director.owns()) return;
    const c = ctx();
    if (!narratorRef()) return;
    director.sync();
    const m = c.chat[id];
    const ooc = m?.mes?.match(RETCON_OOC);
    if (ooc) {
        // An out-of-character retcon: apply it, then keep the message out of the prompt and the summaries.
        retcon(ooc[1]);
        m.is_system = true;
        $(`#chat .mes[mesid="${id}"]`).attr('is_system', 'true');
        c.saveChat();
    }
    refresh('sent');
}

function onChatMutated() {
    if (!director.owns() || !narratorRef()) return;
    const r = director.sync();
    if (r.deleted.length || r.stale.length) refresh('mutated');
    scheduleKick();
}

// ---------------------------------------------------------------- World Info: dynamic lore and muted members' books

let loreSample = [];
/** Authored lorebook entries (not the director's own), for profiling cast members a lorebook describes. */
let loreEntries = [];
const arrOf = (v) => (Array.isArray(v) ? v.map(String) : []);

async function onEntriesLoaded(lists) {
    const epoch = director.epoch;
    const current = () => director.owns(epoch);
    if (!current()) return;
    const all = [...lists.globalLore, ...lists.characterLore, ...lists.chatLore, ...lists.personaLore];
    const ref = narratorRef();
    if (!ref) return;
    const c = ctx();
    if (lists.chatLore.some(entry => entry.world && entry.world !== c.chatMetadata?.world_info)) return;
    const have = new Set(all.map(e => e.world));
    const added = [];
    if (ref.group) {
        // SillyTavern loads a bound lorebook only for the member that is generating. The cast is muted, so add theirs.
        for (const ch of groupMembers()) {
            const world = ch.data?.extensions?.world;
            if (!world || have.has(world)) continue;
            have.add(world);
            const data = await c.loadWorldInfo(world);
            if (!current()) return;
            if (!data?.entries) continue;
            for (const e of Object.values(data.entries)) added.push({ ...e, world });
        }
    }
    const narratorCard = c.characters.find(ch => ch.avatar === ref.avatar);
    const narratorWorld = narratorCard?.data?.extensions?.world;
    // The card's baseline lorebook (genre craft) works without the manual "Import Card Lore" step:
    // if it is not bound and loaded, its embedded entries are added here.
    const book = narratorCard?.data?.character_book;
    const baselineName = book?.name || 'Narrator baseline';
    if (book?.entries?.length && !(narratorWorld && have.has(narratorWorld)) && !have.has(baselineName)) {
        const converted = c.convertCharacterBook(book);
        // Entries are filed under a book the director owns: lookups by uid go to that file. If a file of the same name
        // exists that the director did not write (an earlier "Import Card Lore"), it may be out of date, so the
        // director uses its own copy beside it instead of touching the player's file.
        const worldName = await ownedWorldName(baselineName, current);
        if (!current()) return;
        for (const e of Object.values(converted.entries ?? {})) added.push({ ...e, world: worldName });
        // Kept in step with the card: a card update that adds entries must reach the file, or lookups by uid fail
        // ("Valid UID is required" from extensions such as WorldInfoInfo).
        await mirrorWorld(worldName, converted, current);
        if (!current()) return;
    }
    const authored = [...lists.globalLore, ...lists.characterLore, ...added, ...lists.chatLore]
        .filter(e => e.world !== narratorWorld && e.world !== baselineName && e.world !== `${baselineName} (director)` && e.world !== DYNAMIC_WORLD && !e.disable);
    loreKeys = [...new Set(authored.flatMap(e => e.key ?? []))].slice(0, 200);
    loreEntries = authored.map(e => ({ keys: arrOf(e.key), comment: String(e.comment ?? ''), content: String(e.content ?? '') })).filter(e => e.content.trim());
    loreSample = authored.filter(e => e.constant).concat(authored.filter(e => !e.constant)).slice(0, 12)
        .map(e => `- ${(e.key ?? []).slice(0, 2).join(', ') || e.comment || 'note'}: ${String(e.content ?? '').slice(0, 300)}`);
    const dynamic = director.lorebook().entries.map(toWorldInfoEntry);
    lists.characterLore.push(...added, ...dynamic);
    await mirrorWorld(DYNAMIC_WORLD, { entries: Object.fromEntries(dynamic.map(({ world, ...e }) => [e.uid, e])) }, current);
}

const MIRROR_MARK = 'narrator_director_mirror';
const mirrored = new Map();
const ownedNames = new Map();

/** `name` if no file has it or the director wrote that file; otherwise "<name> (director)". */
async function ownedWorldName(name, current) {
    if (ownedNames.has(name)) return ownedNames.get(name);
    let use = name;
    try {
        const c = ctx();
        if (settings.mirrorLore !== false && c.getWorldInfoNames().includes(name) && !(await c.loadWorldInfo(name))?.[MIRROR_MARK]) use = `${name} (director)`;
    } catch (e) {
        console.warn('[Narrator Director] could not check the lorebook file', e);
    }
    if (current()) ownedNames.set(name, use);
    return use;
}

/**
 * The director's entries are added at load time under book names that would otherwise not exist as files.
 * Other extensions look activated entries up by book name and uid (for example /wi-get-timed-effect) and warn
 * when the file is missing. So each book is mirrored to a real lorebook file the director owns.
 * The mirror is never bound or activated; it only answers lookups. A file the director did not create is left alone.
 * @param {() => boolean} current Whether the initiating chat still owns this work.
 */
async function mirrorWorld(name, data, current) {
    if (!current() || settings.mirrorLore === false) return;
    try {
        const c = ctx();
        const exists = c.getWorldInfoNames().includes(name);
        const signature = JSON.stringify(data.entries ?? {});
        if (exists && mirrored.get(name) === signature) return;
        if (exists && !mirrored.has(name)) {
            const saved = await c.loadWorldInfo(name);
            if (!current() || !saved?.[MIRROR_MARK]) return;
            if (JSON.stringify(saved.entries ?? {}) === signature) { mirrored.set(name, signature); return; }
        }
        if (!current()) return;
        await c.saveWorldInfo(name, { entries: structuredClone(data.entries ?? {}), [MIRROR_MARK]: true }, true);
        if (current()) {
            mirrored.set(name, signature);
            if (!exists) await c.updateWorldInfoList();
        }
    } catch (e) {
        console.warn('[Narrator Director] could not mirror lore to a file', e);
    }
}

// ---------------------------------------------------------------- groups

const groupSettings = makeGroupSettings({
    getGroup: id => ctx().groups.find(group => group.id === id),
    saveGroup: group => saveGroupSettings(group, ctx().getRequestHeaders()),
});

/** Cast up to the limit: SillyTavern joins every card. Above it: swap mode, and the director injects the cast. */
async function applyGroupRule(narratorAvatar) {
    const epoch = director.epoch;
    if (!director.owns(epoch)) return false;
    const ref = narratorRef();
    const group = currentGroup();
    if (!ref?.group || !group) return false;
    const current = () => director.owns(epoch) && currentGroup()?.id === group.id;
    const applied = await groupSettings.apply(group.id, {
        modeFor: g => g.members.length - 1 <= settings.castLimit ? group_generation_mode.APPEND_DISABLED : group_generation_mode.SWAP,
        narratorAvatar,
        legacyMode: meta()?.groupMode,
        current,
    });
    if (!applied || !current()) return false;
    $('#rm_group_generation_mode').val(currentGroup().generation_mode);
    return true;
}

/** Restore the group settings the Director changed. The group can have several chats. */
async function restoreGroupMode() {
    const epoch = director.epoch;
    if (!director.owns(epoch)) return false;
    const group = currentGroup();
    const m = meta();
    if (!group) return true;
    const current = () => director.owns(epoch) && currentGroup()?.id === group.id;
    const restored = await groupSettings.restore(group.id, { legacyMode: m?.groupMode, current });
    if (!restored || !current()) return false;
    if (m?.groupMode !== undefined) { delete m.groupMode; ctx().saveMetadataDebounced(); }
    $('#rm_group_generation_mode').val(currentGroup().generation_mode);
    return true;
}

/** One click: only the narrator speaks. Mutes the cast and applies the cast-size rule. */
async function setupGroup() {
    const epoch = director.epoch;
    if (!director.owns(epoch)) return CHAT_CHANGED;
    const ref = narratorRef();
    const group = currentGroup();
    if (!ref?.group || !group) return 'Open a group chat that includes the narrator card first.';
    if (!await applyGroupRule(ref.avatar) || !director.owns(epoch)) return CHAT_CHANGED;
    return `Group set up: ${ref.name} narrates, ${currentGroup().disabled_members.length} cast member(s) muted.`;
}

/** In a group, the narrator opens with her group greeting (CCv3 group_only_greetings), not her solo one. */
function onFirstMessageSelected(args) {
    if (!settings.enabled || !currentGroup() || !isNarratorCard(args?.character)) return;
    // Another extension (Group Greetings, which loads first) has already chosen this opening: leave it.
    if (args.output) return;
    const g = args.character.data?.group_only_greetings;
    if (Array.isArray(g) && g[0]) args.output = g[0];
}

/** SillyTavern posts every member's greeting and offers no way to suppress one, so the others are hidden after the fact. */
function onGroupChatCreated() {
    const ref = narratorRef();
    if (!ref?.group || settings.greetings !== 'hide') return;
    const c = ctx();
    let hid = 0;
    c.chat.forEach((m, i) => {
        // By authorship, not by classify(): the narrator's neutral greeting is not "narration" but must stay visible.
        const hers = m.original_avatar ? m.original_avatar === ref.avatar : m.name === ref.name;
        if (m.is_user || hers) return;
        m.is_system = true;
        $(`#chat .mes[mesid="${i}"]`).attr('is_system', 'true');
        hid++;
    });
    if (hid) c.saveChat();
}

// ---------------------------------------------------------------- player actions

/**
 * Retcon by text. Guarded (package audit P2, 22 Nov 2026): an empty or one-letter text matched every fact. Under 3 letters
 * is refused; more than 3 matches are listed and need a trailing "!" to go ahead.
 */
function retcon(raw) {
    let text = String(raw ?? '').trim();
    const force = text.endsWith('!');
    if (force) text = text.slice(0, -1).trim();
    if (text.replace(/[^\p{L}\p{N}]/gu, '').length < 3) return 'Say what to retcon in at least a few words, for example: /director retcon: Mira has the key';
    const state = director.view();
    const all = [...state.canon, ...state.uncertain];
    const needle = text.toLowerCase();
    // Prefer facts that contain the text; fall back to close rewordings. A loose match would delete too much.
    let hits = all.filter(f => f.fact.toLowerCase().includes(needle));
    if (!hits.length) hits = all.filter(f => similarity(f.fact, text) >= 0.6);
    if (hits.length > 3 && !force) return `That matches ${hits.length} facts: ${hits.slice(0, 5).map(f => f.fact).join(' | ').slice(0, 300)}. Make the text more specific, or add ! at the end to retcon all of them.`;
    // Matched facts become tombstones by id; free text is kept only when nothing on record matched.
    director.playerOp({ kind: 'retcon', ids: hits.map(f => f.id), texts: hits.length ? [] : [str(text, 300)] });
    return hits.length ? `Retconned: ${hits.map(f => f.fact).join(' | ').slice(0, 240)}` : 'No recorded fact matched; the narrator is told it did not happen.';
}

/** Several edits saved together, with one note to the narrator. */
function editStates(pairs) {
    for (const [path, value] of pairs) director.playerOp({ kind: 'edit', path, value });
    director.playerOp({ kind: 'note', text: 'the record was corrected; treat these notes as the truth where they differ from earlier narration' });
}

/** Plan-side records the narrator never sees. Editing them sends no note: a note would only reveal that a plan exists. */
const PLAN_PATHS = new Set(['arc', 'beats', 'scenes', 'spine']);

function editState(path, value) {
    director.playerOp({ kind: 'edit', path, value });
    if (PLAN_PATHS.has(path.split('.')[0])) return;
    // Operation note: the narrator reflects the change without ever hearing about the tool.
    director.playerOp({ kind: 'note', text: `the record of ${path.split('.')[0]} was corrected; treat these notes as the truth where they differ from earlier narration` });
}

async function rerunGenre() {
    const epoch = director.epoch;
    const saved = await director.exclusive(() => director.ensureGenre(true));
    if (!director.owns(epoch) || !saved) return false;
    host.save();
    refresh('genre');
    return true;
}

async function confirmGenre(value) {
    if (!director.owns()) return false;
    const v = validateGenre(value);
    if (!v.ok) return false;
    v.value.confirmed = true;
    // Before the story starts the profile is a setup value; afterwards a change is logged on the latest message.
    if (ctx().chat.length <= 1) host.setSetup({ genre: v.value });
    else if (!director.playerOp({ kind: 'genre', value: v.value })) return false;
    scheduleKick(50);
    return true;
}

/** Draft an opening from a premise the player picks, and offer it as a swipe of the first message. */
async function draftOpening() {
    const epoch = director.epoch;
    const c = ctx();
    const ref = narratorRef();
    if (!ref) return 'The director is not active in this chat.';
    const last = c.chat.at(-1);
    const lastText = last?.mes;
    const lastSwipe = last?.swipe_id;
    const current = () => director.owns(epoch) && ctx().chat.at(-1) === last
        && last?.mes === lastText && last?.swipe_id === lastSwipe;
    const stale = () => director.owns(epoch) ? 'The reply changed before the opening was ready.' : CHAT_CHANGED;
    const state = director.view();
    const material = await host.material();
    if (!current()) return stale();
    const raw = await director.model('opening', premisePrompt({ genre: state.genre, material }));
    if (!current()) return stale();
    const premises = (extractJson(raw).value?.premises ?? []).map(p => str(p, 400)).filter(Boolean).slice(0, 3);
    if (!premises.length) return 'No premises came back; see the inspector for the raw output.';
    const html = `<h3>Pick a premise</h3>${premises.map((p, i) => `<label class="nd-premise"><input type="radio" name="nd-premise" value="${i}" ${i ? '' : 'checked'}> ${escapeHtml(p)}</label>`).join('')}`;
    let pick = 0;
    const ok = await c.callGenericPopup(html, c.POPUP_TYPE.CONFIRM, '', { onClose: (popup) => { pick = Number(popup.dlg.querySelector('input[name="nd-premise"]:checked')?.value ?? 0); } });
    if (!current()) return stale();
    if (!ok) return 'Cancelled.';
    const premise = premises[pick];
    const text = stripDirector(await director.model('opening', openingPrompt({ genre: state.genre, premise, material, player: c.name1 })));
    if (!current()) return stale();
    if (!text) return 'The opening came back empty.';
    host.setSetup({ premise });
    const first = c.chat.findIndex(m => !m.is_user && (m.original_avatar ? m.original_avatar === ref.avatar : m.name === ref.name));
    if (first !== -1 && c.chat.length <= first + 1) {
        const m = c.chat[first];
        m.swipes = Array.isArray(m.swipes) && m.swipes.length ? m.swipes : [m.mes];
        m.swipes.push(text);
        if (Array.isArray(m.swipe_info)) m.swipe_info.push({ send_date: m.send_date, extra: {} });
        m.swipe_id = m.swipes.length - 1;
        m.mes = text;
        await host.save();
        if (director.owns(epoch)) await c.reloadCurrentChat();
        return 'Opening drafted as a new swipe of the first message.';
    }
    await c.executeSlashCommandsWithOptions(`/sendas name=${JSON.stringify(ref.name)} ${JSON.stringify(text)}`);
    return 'Opening posted.';
}

async function revise(kind, instruction) {
    const epoch = director.epoch;
    const state = director.view();
    if (kind === 'genre') {
        if (!state.genre) return 'The story profile is not ready yet.';
        const raw = await director.model('genre', revisePrompt({ kind: 'story profile', current: state.genre, instruction }));
        if (!director.owns(epoch)) return CHAT_CHANGED;
        const parsed = extractJson(raw);
        const saved = parsed.ok && await confirmGenre({
            ...parsed.value, lethality: state.genre.lethality,
        });
        return saved ? 'Story profile revised.' : 'The revision did not return a valid story profile.';
    }
    if (kind !== 'plan' || !director.playerOp({ kind: 'instruction', text: instruction })) {
        return 'No revision was saved. Use /director revise genre or /director revise plan in a story.';
    }
    scheduleKick(50);
    return 'The planner will revise the plan.';
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));

async function setEnabledForChat(on) {
    const epoch = director.epoch;
    if (!director.owns(epoch)) return false;
    const m = meta(true);
    const c = ctx();
    if (on) {
        // Resumes a Narrator chat paused with /director off. It never adopts another card as narrator.
        delete m.enabled;
        delete m.narrator;
    } else {
        if (!await restoreGroupMode() || !director.owns(epoch)) return false;
        meta(true).enabled = false;
    }
    if (!director.owns(epoch)) return false;
    c.saveMetadataDebounced();
    onChatChanged();
    return true;
}

/** /director: free text, or a keyword followed by a colon. */
async function directorCommand(_named, text) {
    const epoch = director.epoch;
    if (!director.owns(epoch)) return CHAT_CHANGED;
    try {
        return await runDirectorCommand(text, epoch);
    } catch (error) {
        if (!director.owns(epoch)) return CHAT_CHANGED;
        throw error;
    }
}

async function runDirectorCommand(text, epoch) {
    const { key: k, rest } = parseDirectorCommand(text);
    if (k === 'on') {
        if (!narratorInChat()) return 'The director runs only with the Narrator card. Open a chat with it, or add it to a group with your cards.';
        return await setEnabledForChat(true) ? 'Director on for this chat.' : CHAT_CHANGED;
    }
    if (k === 'off') return await setEnabledForChat(false) ? 'Director off for this chat.' : CHAT_CHANGED;
    if (k === 'inspect') { ui?.open(); return ''; }
    if (!narratorRef()) return narratorInChat() ? 'The director is off for this chat. /director on turns it back on.' : 'The director runs only with the Narrator card. Open a chat with it, or add it to a group with your cards.';
    switch (k) {
        case 'scene': {
            const fields = Object.fromEntries([...rest.matchAll(/(location|time|mood)\s*=\s*([^;,\n]+)/gi)].map(m => [m[1].toLowerCase(), m[2].trim()]));
            const present = rest.match(/present\s*=\s*([^;\n]+)/i)?.[1].split(/,|\band\b/).map(s => s.trim()).filter(Boolean);
            if (!Object.keys(fields).length && !present?.length) return 'Give at least one scene field: location, time, mood or present.';
            for (const f of ['location', 'time']) if (fields[f]) director.playerOp({ kind: 'edit', path: `scene.${f}`, value: { value: fields[f], established: true } });
            if (fields.mood) director.playerOp({ kind: 'edit', path: 'scene.mood', value: fields.mood });
            if (present) director.playerOp({ kind: 'edit', path: 'scene.present', value: present });
            director.playerOp({ kind: 'note', text: `scene change: ${rest}` });
            return 'Scene adjusted.';
        }
        case 'beats': {
            const beats = rest.split(/;|\n/).map(s => s.trim()).filter(Boolean).map(intent => ({ intent, type: 'choice', required: false }));
            if (!beats.length) return 'Give one or more intents separated by semicolons.';
            director.playerOp({ kind: 'beats', value: beats, seq: Date.now() % 100000 });
            return `Queued ${beats.length} beat(s).`;
        }
        case 'rewrite': {
            if (!rest.trim()) return 'Give a direction after /director rewrite:';
            const c = ctx();
            const last = c.chat.at(-1);
            if (!last || classify(last, narratorRef()) !== 'narration') return 'The latest message is not a narrator reply.';
            director.playerOp({ kind: 'instruction', text: `rewrite the last reply: ${rest}` });
            const count = last.swipes?.length ?? 1;
            if ((last.swipe_id ?? 0) < count - 1) await c.swipe.to(null, 'right', { forceSwipeId: count - 1 });
            if (!director.owns(epoch) || ctx().chat.at(-1) !== last) return 'The target reply changed before the rewrite.';
            await c.swipe.right(); // past the last swipe: SillyTavern generates a new one
            return '';
        }
        case 'pg':
        case 'explicit':
            return 'Content is set by the selected preset. Choose Narrator Companion (PG) or Narrator Companion (Mature) in AI Response Configuration.';
        case 'retcon': return retcon(rest);
        case 'profile': return await rerunGenre() ? 'Story profile saved.' : 'No story profile was saved. Add a premise and check the Log tab.';
        case 'confirm': return await confirmGenre(director.view().genre) ? 'Story profile confirmed.' : 'A valid story profile is needed first.';
        case 'replan':
            if (!director.playerOp({ kind: 'instruction', text: rest || 're-plan from where the story stands', ...(rest ? {} : { quiet: true }) })) return 'Start a story before re-planning.';
            scheduleKick(50);
            return 'Re-plan requested.';
        case 'rollup': {
            const saved = await director.exclusive(() => director.maybeRollUp(true));
            if (!director.owns(epoch)) return CHAT_CHANGED;
            if (!saved) return 'No roll-up was saved. Roll-up requires Director memory and a summary outside the prompt.';
            host.save();
            refresh('rollup');
            return 'Summaries rolled up.';
        }
        case 'track': {
            if (!director.view().spine) return 'There is no spine yet. Use /director spine first.';
            const { status } = await director.trackNow();
            if (!director.owns(epoch)) return CHAT_CHANGED;
            refresh('tracked');
            return {
                current: 'No replies are waiting for a spine check.',
                checked: 'Spine checked against the latest replies.',
                partial: 'Some spine checks were saved. Replies are still waiting.',
                pending: 'No spine check was saved. See the Log tab.',
                superseded: CHAT_CHANGED,
            }[status];
        }
        case 'spine': {
            const had = !!director.view().spine;
            if (!director.view().arc) return 'The spine is drafted after the arc. Accept the story profile or start playing first.';
            const ok = await director.exclusive(() => director.ensureSpine(true));
            if (!director.owns(epoch)) return CHAT_CHANGED;
            host.save(); refresh('spine');
            return ok ? (had ? 'Spine redrafted from the setup.' : 'Spine drafted.') : 'No spine came back; see the Log tab.';
        }
        case 'redraft': {
            if (!director.view().genre) return 'The story profile is not ready yet.';
            const saved = await director.exclusive(() => director.redraftArc());
            if (!director.owns(epoch)) return CHAT_CHANGED;
            host.save(); refresh('spine');
            if (!saved) return 'No new arc was saved. See the Log tab.';
            return saved.length === 3 ? 'Arc, spine and plan redrafted.' : `Redrafted ${saved.join(' and ')}. See the Log tab for the other parts.`;
        }
        case 'settle': {
            if (!rest.trim()) return 'Usage: /director settle <what is closed, e.g. Max wants nothing in return>';
            if (!director.playerOp({ kind: 'settle', text: rest.trim() })) return 'Start a story before settling a matter.';
            scheduleKick(50);
            return 'Settled: the story will not press it again.';
        }
        case 'unsettle': {
            const list = director.view().settled ?? [];
            const item = list[Number(rest) - 1];
            if (!item) return list.length ? `Settled:\n${list.map((s, i) => `${i + 1}. ${s.text}`).join('\n')}\nUse /director unsettle <number>.` : 'Nothing is settled.';
            director.playerOp({ kind: 'unsettle', id: item.id });
            return `Reopened: ${item.text}`;
        }
        case 'opening': return await draftOpening();
        case 'setup': return await setupGroup();
        case 'retry': director.retry(); return 'Retrying failed reads.';
        case 'dump': return JSON.stringify(director.view(), null, 2);
        case 'suggest': return await suggestBeat();
        case 'revise': {
            const [, what, instr] = rest.match(/^(\w+)\s+([\s\S]+)$/) ?? [];
            return what ? await revise(what.toLowerCase(), instr) : 'Usage: /director revise genre|plan <instruction>';
        }
        default:
            // Free text: an instruction to the director. It reaches the planner and, once, the narrator's notes.
            if (!director.playerOp({ kind: 'instruction', text: rest })) return 'Start a story before sending a direction.';
            scheduleKick(50);
            return 'Noted.';
    }
}

/** Suggest mode: the player picks which queued beat comes next. Opt-in by command, because it shows the plan. */
async function suggestBeat() {
    const epoch = director.epoch;
    const c = ctx();
    const state = director.view();
    const queued = state.beats.filter(b => b.status === 'queued');
    if (queued.length < 2) return 'Fewer than two beats are queued.';
    const html = `<h3>What should come next?</h3><small>This shows where the story may be heading.</small>${queued.slice(0, 6).map((b, i) => `<label class="nd-premise"><input type="radio" name="nd-beat" value="${i}" ${i ? '' : 'checked'}> ${escapeHtml(b.intent)} <i>(${b.type})</i></label>`).join('')}`;
    let pick = 0;
    const ok = await c.callGenericPopup(html, c.POPUP_TYPE.CONFIRM, '', { onClose: (popup) => { pick = Number(popup.dlg.querySelector('input[name="nd-beat"]:checked')?.value ?? 0); } });
    if (!director.owns(epoch)) return CHAT_CHANGED;
    if (!ok || pick === 0) return '';
    const chosen = queued[pick];
    const beats = clone(director.view().beats);
    const from = beats.findIndex(b => b.id === chosen?.id && b.status === 'queued'), to = beats.findIndex(b => b.status === 'queued');
    if (from < 0) return 'The queued opening has changed.';
    beats.splice(to, 0, ...beats.splice(from, 1));
    director.playerOp({ kind: 'edit', path: 'beats', value: beats });
    return 'Next beat chosen.';
}

async function showSource(mid, epoch) {
    const message = ctx().chat.find(m => m.narrator_id === mid);
    if (!message || !director.owns(epoch)) return null;
    const index = ctx().chat.indexOf(message);
    const element = () => document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (!element()) {
        const before = Number(document.querySelector('#chat .mes')?.getAttribute('mesid'));
        if (Number.isFinite(before) && before > index) await showMoreMessages(before - index);
    }
    if (!director.owns(epoch) || ctx().chat[index] !== message) return null;
    return element();
}

// ---------------------------------------------------------------- init

function loadSettings() {
    const c = ctx();
    c.extensionSettings[KEY] = { ...SETTINGS_DEFAULTS, ...(c.extensionSettings[KEY] ?? {}) };
    // Saved token limits predate newer modules: fill in their defaults.
    c.extensionSettings[KEY].tokens = { ...SETTINGS_DEFAULTS.tokens, ...(c.extensionSettings[KEY].tokens ?? {}) };
    // A strip list still at the earlier default gains BaiBai Book's item and variable tags; one the player edited stays.
    if (c.extensionSettings[KEY].stripTags === 'bbs_start, bbs_end, bbi_image') c.extensionSettings[KEY].stripTags = SETTINGS_DEFAULTS.stripTags;
    // A plan's beats now carry a goal and an opening each: a planner limit still at the old default of 1800 was cutting
    // plans off mid-answer (found live, 19 Nov 2026). It becomes 3000; tokens are spent only when the plan needs them.
    if (c.extensionSettings[KEY].tokens?.planner === 1800) c.extensionSettings[KEY].tokens.planner = 3000;
    // Timed re-plans default to off (owner, 18 Nov 2026): a cadence still at the old default of 6 becomes 0, once.
    if (!c.extensionSettings[KEY].cadenceEvents) {
        if (c.extensionSettings[KEY].cadence === 6) c.extensionSettings[KEY].cadence = 0;
        c.extensionSettings[KEY].cadenceEvents = true;
    }
    settings = c.extensionSettings[KEY];
    settings.profiles ??= {};
    settings.tokens = { ...DEFAULTS.tokens, ...(settings.tokens ?? {}) };
}

function registerMacro() {
    const c = ctx();
    const handler = () => (narratorRef() && !SKIP_TYPES.has(genType) && placement() === 'macro' ? currentBrief : '');
    const description = 'The director\'s notes for this turn. Put it in its own prompt entry to choose where the notes go.';
    if (c.macros?.register) c.macros.register(MACRO, { handler, description, category: 'prompts' });
    else c.registerMacro?.(MACRO, handler, description);
}

function registerCommand() {
    const c = ctx();
    c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
        name: 'director',
        callback: async (named, text) => {
            try {
                const out = await directorCommand(named, text);
                if (out && out.length < 300) toastr.info(out, 'Narrator Director');
                return out ?? '';
            } catch (e) {
                console.error('[Narrator Director]', e);
                toastr.error(String(e?.message ?? e), 'Narrator Director');
                return '';
            }
        },
        unnamedArgumentList: [c.SlashCommandArgument.fromProps({ description: 'instruction, or keyword: text', typeList: [c.ARGUMENT_TYPE.STRING], isRequired: false })],
        helpString: `<div>Talk to the story director without breaking the scene.</div>
<ul><li><code>/director make the next scene quieter</code> – free-text instruction</li>
<li><code>/director scene: location=the docks; mood=tense; present=Ji Si, Hale</code></li>
<li><code>/director beats: a rival appears; the storm breaks</code></li>
<li><code>/director rewrite: less dialogue</code> – redo the latest reply as a new swipe</li>
<li><code>/director retcon: the letter was burned</code></li>
<li><code>/director redraft</code> – a fresh arc, spine and plan from where the story stands, when the story feels stuck</li>
<li><code>/director settle &lt;text&gt;</code> – close a matter so the story stops pressing it; <code>/director unsettle</code> lists and reopens</li>
<li><code>/director spine</code> – draft the story spine (endings and milestones) now, or redraft it</li>
<li><code>/director track</code> – check the spine against the latest replies now, without waiting for the next batch</li>
<li><code>inspect, profile, confirm, replan, rollup, opening, suggest, setup, retry, dump, on, off</code></li></ul>`,
    }));
}

(function init() {
    const c = ctx();
    loadSettings();
    const formatter = c.messageFormatter;
    formatter?.addHook(formatSavedDialogue, { stage: formatter.stage.BEFORE_REGEX });
    registerMacro();
    registerCommand();
    const E = c.eventTypes, on = (ev, fn) => ev && c.eventSource.on(ev, fn);
    on(E.CHAT_CHANGED, onChatChanged);
    // A slash command in the composer can end the send before any generation takes place.
    on(E.GENERATION_AFTER_COMMANDS ?? E.GENERATION_STARTED, onGenerationStarted);
    on(E.GENERATE_AFTER_DATA, onPromptAssembled);
    on(E.GENERATION_ENDED, onGenerationDone);
    on(E.GENERATION_STOPPED, onGenerationDone);
    on(E.MESSAGE_RECEIVED, onMessageReceived);
    on(E.MESSAGE_SENT, onMessageSent);
    for (const ev of [E.MESSAGE_DELETED, E.MESSAGE_EDITED, E.MESSAGE_UPDATED, E.MESSAGE_SWIPED, E.MESSAGE_SWIPE_DELETED]) on(ev, onChatMutated);
    on(E.WORLDINFO_ENTRIES_LOADED, onEntriesLoaded);
    on(E.GROUP_UPDATED, () => { applyGroupRule().catch(console.error); scheduleKick(); });
    on(E.CHARACTER_EDITED, () => scheduleKick(1500));
    on(E.CHARACTER_FIRST_MESSAGE_SELECTED, onFirstMessageSelected);
    on(E.GROUP_CHAT_CREATED, onGroupChatCreated);
    ui = mountUi({
        director, host, getSettings: () => settings, defaults: SETTINGS_DEFAULTS, narratorRef, narratorInChat, escapeHtml, providerOptions,
        saveSettings: () => { c.saveSettingsDebounced(); refresh('settings'); },
        onToggle: async (enabled) => {
            const epoch = director.epoch;
            if (!enabled && !await restoreGroupMode()) return false;
            if (!director.owns(epoch)) return false;
            settings.enabled = enabled;
            c.saveSettingsDebounced();
            onChatChanged();
            return true;
        },
        getBrief: () => ({
            brief: lastBrief, story: lastStory, placement: placement(),
            reply: director.readings().entries.findLast(entry => entry.kind === 'narration'),
            preview: () => buildBrief(director.readView(), { tokenCap: settings.briefTokens }),
        }),
        editState, editStates, confirmGenre, rerunGenre, retcon, setupGroup,
        playerOp: (op) => director.playerOp(op), showSource,
        command: (text) => directorCommand({}, text),
        groupInfo: () => { const g = currentGroup(); return g ? { mode: g.generation_mode, cast: g.members.length - 1, muted: g.disabled_members?.length ?? 0 } : null; },
        fallbackNote: FALLBACK_NOTE, dynamicWorld: DYNAMIC_WORLD,
    });
    if (c.chat?.length) onChatChanged();
    console.log('[Narrator Director] ready');
})();
