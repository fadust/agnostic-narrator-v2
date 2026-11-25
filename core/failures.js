// Director failures in words the player can act on (audit, 22 Nov 2026: background failures only reached the
// console and the inspector's Log tab, so a broken model or profile quietly stopped the director).

const LABELS = {
    observer: 'reading replies', 'observer-check': 'checking beat evidence', 'observer-memory-check': 'checking recalled facts',
    tracker: 'tracking the story spine', 'tracker-check': 'checking spine marks',
    planner: 'planning', 'planner-check': 'checking the plan', spine: 'drafting the story spine', genre: 'the story profile',
    profile: 'character profiles', summariser: 'summaries', cleanup: 'tidying facts', conclusion: 'closing milestones',
};

/** What the module does, for a message. */
export const moduleLabel = (module) => LABELS[module] ?? String(module);

/** One short line on what to do about an error, from its text. */
export function failureHint(error) {
    const e = String(error ?? '');
    if (/spent its whole answer limit/.test(e)) return "The model thinks too long for this module's answer limit: raise the limit in the settings, or give the module a model that thinks less.";
    if (/automatic retries stopped/.test(e)) return 'Automatic retries have stopped. Check the connection, then press Retry.';
    if (/empty answer|socket hang up|ECONNRESET|ETIMEDOUT|response status 5\d\d|failed to fetch|network/i.test(e)) return 'The connection dropped or returned nothing. The director retries after 20 s, 60 s and 3 minutes.';
    if (/response status 4\d\d|unauthori[sz]ed|forbidden|api key|quota|rate limit/i.test(e)) return "The provider refused the request: check the connection profile's key, model and quota.";
    if (/no JSON|JSON|not an object|needs at least/i.test(e)) return 'The model answered in the wrong shape. A different model for this module usually fixes it.';
    if (/timed out/i.test(e)) return 'The model took too long. It is tried again on the next turn.';
    return 'It is tried again on the next turn; press Retry to try now.';
}
