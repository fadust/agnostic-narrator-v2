import { arr, str } from './util.js';

/** Old beats carry only intent. The observer judges the goal and the narrator receives the pressure. */
export function beatText(beat, fit = str) {
    const pressure = fit(beat?.pressure);
    const goal = fit(beat?.goal) || fit(beat?.intent) || pressure;
    return { goal, pressure: pressure || goal, intent: goal };
}

/** The optional conditions the director can assess before sending the opening. */
export function beatConditions(when) {
    const after = when?.after;
    return {
        place: str(when?.place, 80),
        people: arr(when?.people).map(name => str(name, 80)).filter(Boolean).slice(0, 4),
        after: Number.isInteger(after) && after > 0 ? after : str(after, 100),
    };
}
