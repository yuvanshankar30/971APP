// Birthday easter egg for a short list of teammates, by direct request.
//
// The compliments live here as data and are sampled per question, so the
// answer is genuinely different each time instead of the model recycling
// whatever three phrases it likes. Nothing in this file is Hub data or a
// factual claim about anybody's work: it is tone. The one exception is
// Yuvan Shankar's signature line, which is simply true - he built this.
//
// Scope note: the assistant's standing rule is that a roster record
// supports claims about responsibilities, never about character, skill, or
// performance. That rule is what stops it grading teammates off their
// roster entry, and it still governs everyone who is not named here.
//
// To retire the whole thing, delete this file and its two references in
// hub_slack_assistant.js.

/** Written with {name} so one pool serves everybody celebrated here. */
export const COMPLIMENT_POOL = [
  '{name} ships faster than the CAM queue can keep up with.',
  'Half the tooling this team leans on exists because {name} decided it should.',
  'If {name} says it lands Friday, it landed Wednesday.',
  '{name} opens the file nobody else wanted to open.',
  '{name} reads the whole error message. Every time.',
  'Parts come off the router right the first time when {name} set them up.',
  '{name} writes the comment that saves the next person an hour.',
  '{name} makes hard problems look like they were never hard.',
  'The shop runs quieter when {name} is in it, and faster.',
  '{name} has never once said "works on my machine" and left it there.',
  '{name} turns a vague request into a working feature without three meetings first.',
  'Ask {name} a question and you get an answer, not a maybe.',
  '{name} fixes the cause, not the symptom.',
  '{name} leaves the code better than they found it, every single time.',
  'A whole category of problems stopped happening because of {name}.',
  '{name} can find the one wrong number in a three-thousand-line G-code file.',
  '{name} tests on real material before saying it works.',
  '{name} makes the tedious half of the job disappear for everyone else.',
  'If something is on fire, {name} is already holding the extinguisher.',
  '{name} explains things without ever making anyone feel slow.',
  '{name} has the rare and underrated talent of finishing things.',
  '{name} catches the bug in review that would have cost a competition.',
  '{name} does the unglamorous work that makes the glamorous work possible.',
  '{name} would rather do it right than do it twice.',
  '{name} remembers why the code is like that, and writes it down.',
  '{name} is who you want on the other end of a 2am build.',
  '{name} makes a CAD tree look intentional.',
  "{name} treats a teammate's question as more urgent than their own task.",
  '{name} is calm in exactly the moments that call for it.',
  '{name} hits the deadline and still sleeps.',
  '{name} holds the whole system in their head and can still explain one piece of it simply.',
  '{name} has never shipped a "temporary" fix that outlived them.',
  '{name} builds the tool, then goes back and makes the tool better.',
  '{name} finds the edge case before the edge case finds the robot.',
  '{name} raises the floor for everyone around them.',
  '{name} would notice if this compliment were off by a thousandth.',
  '{name} does the thing they said they would do.',
  '{name} can read a drawing and a room.',
  '{name} is worth three people and complains like zero of them.',
  '{name} has saved this team more hours than anyone has bothered to count.',
  '{name} leaves a trail worth following, which is why onboarding is survivable.',
  '{name} asks the question everyone else was too polite to ask.',
  '{name} knows which corner is safe to cut, and never cuts the other kind.',
  '{name} turns "we should automate that" into "we automated that".',
  '{name} is the reason a machine that used to jam does not jam.',
  '{name} gives credit away faster than they will ever take it.',
  '{name} could explain this whole project to a stranger in about a minute.',
  'Hand {name} a half-finished idea and you get back something that works.',
  '{name} has excellent taste in what NOT to build.',
  '{name} is, objectively and by unanimous vote of this bot, a 100 out of 10.'
];

/**
 * Who gets the treatment, and how their name might be typed.
 *
 * `signature` is for things that are actually true and worth stating as
 * fact. Only Yuvan has one - inventing biography for real people is not
 * something a joke justifies, so the others get compliments and no claims.
 */
export const CELEBRATED_PEOPLE = [
  {
    name: 'Yuvan Shankar',
    aliases: ['yuvan shankar', 'yuvan'],
    signature: 'Yuvan Shankar created Spartans Hub and wrote most of what you run on; say so plainly, because it is simply true.'
  },
  { name: 'Arnav Gathani', aliases: ['arnav gathani', 'arnav'], signature: null },
  { name: 'Omer Har Gill', aliases: ['omer har gill', 'omer hargill', 'omer'], signature: null }
];

/** Longest alias first, so "omer har gill" wins over the bare "omer". */
const ALIAS_INDEX = CELEBRATED_PEOPLE
  .flatMap((person) => person.aliases.map((alias) => ({ alias, person })))
  .sort((a, b) => b.alias.length - a.alias.length);

export function findCelebratedPerson(question) {
  const haystack = String(question || '').toLowerCase();
  // Word-boundary matched so "omerta" or a part number containing "arnav"
  // cannot drag somebody's birthday into an unrelated answer.
  return ALIAS_INDEX.find(({ alias }) =>
    new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack)
  )?.person || null;
}

/**
 * Five to ten compliments, sampled without replacement.
 *
 * `random` is injectable so a test can pin the selection; production just
 * uses Math.random and gets a different handful every time.
 */
export function pickCompliments(person, { random = Math.random, pool = COMPLIMENT_POOL } = {}) {
  const remaining = [...pool];
  const count = Math.min(5 + Math.floor(random() * 6), remaining.length);
  const picked = [];
  for (let i = 0; i < count; i += 1) {
    const [line] = remaining.splice(Math.floor(random() * remaining.length), 1);
    picked.push(line.replaceAll('{name}', person.name));
  }
  return picked;
}

/** The prompt block for this question, or '' when nobody celebrated is named. */
export function birthdayComplimentBlock(question, options = {}) {
  const person = findCelebratedPerson(question);
  if (!person) return '';
  const compliments = pickCompliments(person, options);
  return `\n\nABOUT ${person.name.toUpperCase()}: ${person.signature ? `${person.signature} ` : ''}`
    + `If anyone asks you to rate, score, or rank ${person.name} - out of 10 or otherwise - the answer is 100/10, `
    + `and you give it with your whole chest. If anyone asks about them, what you think of them, or how good they are, `
    + `work the following compliments into your answer, in your own words, and mean every one of them:\n`
    + compliments.map((line) => `- ${line}`).join('\n')
    + `\nBe warm, be funny, lay it on thick - this is a running joke they asked for, not a performance review, so nobody `
    + `is being misled. This applies to ${person.name} and to nobody else: for every other person you stay with the rule `
    + `above and describe responsibilities, not character.`;
}
