import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { setSkillMode } from '../state/skill-store.js';
import { totals } from '../state/store.js';

export interface Lesson {
  id: string;
  title: string;
  body: string;
  /** What switching to the detailed view would show them about this. */
  seeAlso: string;
}

/**
 * The teaching set. Every claim here is one the meter can actually evidence, so
 * a reader who switches to the detailed view finds the thing they were told
 * about — a lesson that cannot be checked is just marketing.
 */
export const METER_LESSONS: Lesson[] = [
  {
    id: 'output-costs-most',
    title: 'Why the reply costs the most',
    body: 'Reading is cheap; writing is not. A model is billed several times more per word it writes than per word it reads, so a long answer usually costs more than a long question — even though the question looks bigger on screen.',
    seeAlso: 'See the four-way cost split',
  },
  {
    id: 'cache-is-the-discount',
    title: 'Staying in one chat is cheaper',
    body: 'Everything already said in a conversation gets re-sent on every follow-up. The second time round it is billed at roughly a tenth of the price — but only if you keep the same chat open. Starting fresh pays full price for the same context again.',
    seeAlso: 'See your cache-hit rate per loop',
  },
  {
    id: 'first-call-is-expensive',
    title: 'The first message of a session is the pricey one',
    body: 'Opening a new chat sends your instructions and project context from scratch, with nothing cached yet. That first call can cost more than the whole rest of the conversation, which is the real argument for fewer, longer sessions.',
    seeAlso: 'See per-step context growth',
  },
  {
    id: 'name-the-file',
    title: 'Naming the file saves a search',
    body: 'Given a vague prompt, the agent hunts: it searches, opens a few files, and every one of those lands in the context you pay for on the next call. Saying which file and what outcome you want skips most of that hunting.',
    seeAlso: 'See which tools ran and how often',
  },
  {
    id: 'a-credit-is-a-cent',
    title: 'What a credit is worth',
    body: 'One AI credit is one US cent, and a seat comes with 5,000 of them a month that do not roll over. So a prompt costing 1.7 credits is under two cents — the number to watch is not any single prompt, but how the month adds up.',
    seeAlso: 'See spend by model and by day',
  },
];

export const ANALYTICS_LESSONS: Lesson[] = [
  {
    id: 'context-pressure',
    title: 'What "running out of context" means',
    body: 'A model can only hold so much of a conversation at once. As a session fills up, each call carries more baggage: it costs more and recalls the earlier parts less well. Splitting the work into a fresh session usually beats pushing through.',
    seeAlso: 'See the context-pressure bands',
  },
  {
    id: 'model-switching',
    title: 'Switching models mid-task has a price',
    body: 'Each model caches your conversation separately. Changing model part-way re-sends the whole thing as new, full-price input. Picking one model up front is normally cheaper than starting small and escalating.',
    seeAlso: 'See your model-switch transitions',
  },
  {
    id: 'repeat-tools',
    title: 'When the agent repeats itself',
    body: 'The same tool running twice in a row usually means the first attempt told it nothing useful — it is searching blind. That is a prompt problem, not a model problem, and it is the cheapest thing on this page to fix.',
    seeAlso: 'See the repeat-tool-call rate',
  },
];

interface LearnCardProps {
  lessons?: Lesson[];
  /** Heading above the card. */
  title?: string;
}

/**
 * One idea at a time, with a way out. The "see the full…" link is the actual
 * point of the card: it turns the detailed view from a wall of jargon into the
 * answer to a question the reader now has.
 */
export function LearnCard({
  lessons = METER_LESSONS,
  title = 'Learn',
}: LearnCardProps): JSX.Element | null {
  const [manual, setManual] = useState<number | null>(null);
  if (!lessons.length) return null;

  // With no explicit pick, rotate by prompt count so the card changes as the
  // session goes on instead of nagging with the same tip forever.
  const auto = totals.value.loops % lessons.length;
  const index = manual ?? auto;
  const lesson = lessons[index] ?? lessons[0];
  if (!lesson) return null;

  return (
    <section class="learnCard" aria-label={title}>
      <div class="learnHead">
        <span class="learnKicker">{title}</span>
        <h3>{lesson.title}</h3>
      </div>
      <p class="learnBody">{lesson.body}</p>
      <div class="learnFoot">
        <div class="learnDots">
          {lessons.map((l, i) => (
            <button
              key={l.id}
              type="button"
              class={`learnDot${i === index ? ' on' : ''}`}
              aria-label={`Lesson ${i + 1}: ${l.title}`}
              aria-current={i === index}
              onClick={() => setManual(i)}
            />
          ))}
        </div>
        <button type="button" class="learnMore" onClick={() => setSkillMode('advanced')}>
          {lesson.seeAlso} →
        </button>
      </div>
    </section>
  );
}

/**
 * The stub left where a section was hidden. Without these, the simple view
 * looks like the tool has less to offer rather than more to reveal.
 */
export function MoreDetail({ label }: { label: string }): JSX.Element {
  return (
    <button type="button" class="moreDetail" onClick={() => setSkillMode('advanced')}>
      <span>{label}</span>
      <span class="moreDetailArrow" aria-hidden="true">
        →
      </span>
    </button>
  );
}
