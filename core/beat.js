import { str } from './util.js';

/** Old beats carry only intent. The observer judges the goal and the narrator receives the pressure. */
export function beatText(beat, fit = str) {
    const pressure = fit(beat?.pressure);
    const goal = fit(beat?.goal) || fit(beat?.intent) || pressure;
    return { goal, pressure: pressure || goal, intent: goal };
}
