// The English Coach's role-play scenarios (/portal/english-coach).
//
// Each scenario is one character the AI plays on a timed, spoken call with a
// tutor or staff member. The text here is read three ways:
//   - `brief`, `title`, `summary`  → shown to the tester before the call
//   - `persona` + `difficulty[x]`  → the character model's instructions
//   - `goals`                      → what the examiner model marks "handling the
//                                    situation" against after the call
//
// A session stores a SNAPSHOT of the scenario it ran (see CoachSession.scenario),
// so rewording a scenario here never changes how an old test reads or was marked.
// Keys are permanent: CoachSettings.disabledScenarios and old sessions refer to them.
//
// Voices are Kokoro-82M voice ids (played in the tester's browser); `lang` picks
// the browser's built-in voice when Kokoro is not available on the device.
//
// Two kinds of scenario:
//   conversation (default) — an AI plays the character, as described above
//   script ('kind: script') — a scripted part, word for word: the character
//     only ever says the script's lines, and the tester is checked against the
//     teacher's lines. The parts live in the database (models/CoachScript.js,
//     managed on the Scripts tab; the Role-Play Practice Book in
//     config/coachRolePlays.js is the starting set) and become scenarios
//     through scriptScenario() below — see services/coachScripts.js.
//
// COACH_SCENARIOS, SCENARIO_KEYS and getScenario() are the conversation
// scenarios only; services/coachScripts.js#allScenarios adds the parts.

import { BOOK_SPEAKERS, BOOK_TITLE } from './coachRolePlays.js'

// `summary` describes the character at that level; `scriptSummary` what the
// level means in a scripted role-play, where the character never changes, and
// `urduSummary` what it means when the teacher lines are shown in Urdu
export const DIFFICULTIES = {
  very_easy: {
    label: 'Very easy', summary: 'For beginners. Very short, simple sentences, spoken slowly — with useful sentences on screen.',
    scriptSummary: 'For beginners. Your line is on the screen — read it out.',
    urduSummary: 'For beginners. The Urdu and the first English words are on screen; the rest opens on a tap.',
  },
  easy: {
    label: 'Easy', summary: 'Patient and friendly. Speaks slowly and simply.',
    scriptSummary: 'You see the first words of your line, and can open the rest.',
    urduSummary: 'The Urdu is on screen. A hint gives the first English words.',
  },
  normal: {
    label: 'Normal', summary: 'A typical call. Asks follow-up questions.',
    scriptSummary: 'Say your line from memory. A hint gives the first words.',
    urduSummary: 'The Urdu only. A hint after a miss, and your English must be correct.',
  },
  hard: {
    label: 'Challenging', summary: 'Impatient, pushes back and changes topic.',
    scriptSummary: 'From memory, no hints, and the wording must be close.',
    urduSummary: 'The Urdu only, no hints, and your English must be complete and correct.',
  },
}

// Call lengths (minutes) an admin may offer in Settings, or fix for a level
// test or an assigned test
export const ALLOWED_DURATIONS = [3, 5, 10, 15]

// How the character talks at Very easy, for every conversation scenario
// (a scenario's own `difficulty.very_easy` replaces it)
export const VERY_EASY_PLAY = 'The other person is a beginner in English. Speak very slowly and simply: one short sentence per reply, no more than 12 words, using only common everyday words and no idioms. Be patient and kind and accept simple answers straight away. If they struggle, ask a simple yes-or-no question. Bring up at most two of your points in the whole call.'

// Seconds a scripted line takes on a call, for the "about N minutes" estimate
const SEC_PER_TEACHER_LINE = 13
const SEC_PER_REPLY_LINE = 3
const SEC_PER_URDU_LINE = 18 // reading the Urdu and putting it into English takes longer

/** Whose line a scripted part opens with (the card and the call show them) */
function leadSpeaker(plays) {
  const first = plays.find(p => p.lines.some(([w]) => w !== 'T'))
  const firstWho = first?.lines.find(([w]) => w !== 'T')?.[0]
  return firstWho === 'P' ? BOOK_SPEAKERS.P : BOOK_SPEAKERS[first?.student || 'S'] || BOOK_SPEAKERS.S
}

/**
 * One scripted part (models/CoachScript.js, normalised by
 * services/coachScripts.js) → a scripted scenario ("Part N"). `mode` is
 * CoachSettings.scriptMode: in Urdu mode the teacher lines that have an Urdu
 * prompt are shown in Urdu and said in English.
 *   part = { key, position, title, builtIn, plays: [{ n, title, goal, student, lines: [[who, text, urdu]] }] }
 */
export function scriptScenario(part, mode = 'english') {
  const plays = part.plays
  const lines = plays.flatMap(p => p.lines)
  const teacher = lines.filter(([w]) => w === 'T').length
  const replies = lines.length - teacher
  const urduLines = lines.filter(([w, , u]) => w === 'T' && u).length
  const urdu = mode === 'urdu' && urduLines > 0
  const lead = leadSpeaker(plays)
  const who = lead === BOOK_SPEAKERS.P ? 'a parent' : 'your student'
  const source = part.builtIn ? `Unit ${part.builtIn} of the ${BOOK_TITLE}` : 'One of Hidaya\'s role-play scripts'
  const brief = urdu
    ? `${source}. You are the teacher and you speak first unless ${who} does. Your line is shown in Urdu: say it in natural English, the way you learned it — do not translate word by word. The coach checks that your English says the same thing and is correct, then ${who} answers with their line. If it is not right, you get a hint and one more try — the same as practising with a partner.`
    : `${source}, word for word. You are the teacher and you speak first unless ${who} does. Say your line in English; ${who} answers with their line from the script. If your line is not close enough, you will see the right sentence and can say it again — the same as practising with a partner.`
  return {
    key: part.key,
    kind: 'script',
    group: 'roleplay',
    unit: part.position,
    unitTitle: part.title,
    builtIn: part.builtIn || undefined,
    title: `Part ${part.position} · ${part.title}`,
    summary: `${plays.map(p => p.title).join(' · ')}.`,
    personaName: lead.name,
    personaRole: lead.role,
    initials: lead.initials,
    voice: lead.voice,
    lang: lead.lang,
    gender: lead.gender,
    brief,
    goals: plays.map(p => (p.goal ? `${p.title}: ${p.goal}` : p.title)),
    plays,
    teacherLines: teacher,
    urduLines,
    scriptMode: urdu ? 'urdu' : 'english',
    estMin: Math.max(1, Math.round((teacher * (urdu ? SEC_PER_URDU_LINE : SEC_PER_TEACHER_LINE) + replies * SEC_PER_REPLY_LINE) / 60)),
  }
}

export const COACH_SCENARIOS = [
  {
    key: 'worried_parent',
    title: 'Worried parent',
    summary: 'A mother is unhappy with her son\'s progress and is thinking of leaving.',
    personaName: 'Sarah Ahmed',
    personaRole: 'Parent',
    initials: 'SA',
    voice: 'bf_emma',
    lang: 'en-GB',
    gender: 'female',
    brief: 'You teach Yusuf (9) Nazra — reading the Qur\'an — three evenings a week. His mother, Sarah, lives in Manchester and has called you. Listen to her concern, explain his progress honestly and agree a clear plan with her.',
    persona: `You are Sarah Ahmed, a British Pakistani mother living in Manchester, UK. Your son Yusuf is 9 and has been learning Nazra (reading the Qur'an) online with Hidaya Online for four months, three evenings a week. You are speaking on a call with Yusuf's tutor.
Your concern: Yusuf still seems to be on the same pages as a month ago, he rushes his reading, and last week one class started 15 minutes late without a message. A friend's child at another academy has finished a whole juz in the same time. You pay every month and you are quietly considering moving him elsewhere.
Things you will reveal only if the tutor asks good questions: Yusuf has football twice a week and often comes to class tired; he does not practise between classes; he enjoys the tutor's stories.
You calm down when the tutor listens, admits the late start, gives specific examples of progress and proposes a concrete plan with a way to check on it.`,
    difficulty: {
      easy: 'You are polite and patient. Speak in short, simple sentences. Accept reasonable explanations quickly.',
      normal: 'You are concerned and a little disappointed. Ask follow-up questions and want specifics, not general reassurance.',
      hard: 'You are frustrated and impatient. Interrupt vague answers, mention the other academy, say you might cancel at the end of the month, and ask for a different tutor if the tutor is defensive. Soften only if the tutor stays calm, apologises for the late start and gives a convincing plan.',
    },
    openings: {
      easy: ['Assalamu alaikum. Thank you for calling. I just wanted to ask how Yusuf is doing, because I\'m a bit worried about his reading.'],
      normal: ['Assalamu alaikum. I\'m glad we could speak. Honestly, I\'m worried. Yusuf seems to be on the same pages as last month, and I\'m not sure he\'s making progress.'],
      hard: ['Right, thank you for finally calling. I\'ll be honest, I\'m not happy. Yusuf has been with you four months, he\'s still on the same pages, and last week his class started late with no message at all.'],
    },
    goals: [
      'Greets the parent politely and lets her explain before responding',
      'Shows empathy and acknowledges the late class honestly, without excuses or blame',
      'Gives specific examples of Yusuf\'s progress and the real reasons it is slow',
      'Proposes a concrete plan (practice routine, focus areas, a check-in date)',
      'Asks questions to understand the situation at home',
      'Ends with clear next steps and a professional close',
    ],
  },
  {
    key: 'new_parent',
    title: 'New parent enquiry',
    summary: 'A father is thinking about enrolling his daughter and has many questions.',
    personaName: 'Omar Khan',
    personaRole: 'Parent',
    initials: 'OK',
    voice: 'am_michael',
    lang: 'en-US',
    gender: 'male',
    brief: 'Omar lives in Toronto and is thinking about online Qur\'an classes for his daughter Aisha (7), who has never studied before. He has asked to speak to a tutor. Explain how classes work, find out about Aisha, and invite them to a free trial class. Fee questions go to the academy\'s coordinator — you don\'t quote prices.',
    persona: `You are Omar Khan, a Canadian Muslim father of Pakistani heritage living in Toronto. Your daughter Aisha is 7 and has never studied the Qur'an; she can't read Arabic letters yet. You found Hidaya Online on Google and you are speaking to one of its tutors before deciding.
Questions on your mind (ask them naturally, one or two at a time, not as a list): how an online class actually works for a young child; how long classes are and how often; whether a female tutor is possible; what Aisha would learn first; how you will know she is progressing; whether timings can fit Toronto evenings; what happens if she misses a class; whether it is safe for a child to be on a video call. You may ask about fees — a good tutor will politely say the coordinator will share fee details.
Aisha is shy and loses focus after about 20 minutes. You decide to book a trial if the tutor is clear, warm and asks about Aisha herself.`,
    difficulty: {
      easy: 'You are friendly and easy to talk to. Ask simple questions and thank the tutor for each answer.',
      normal: 'You are interested but careful. Ask follow-up questions when an answer is vague.',
      hard: 'You are skeptical. Compare Hidaya with another academy that offered a cheaper deal, press for a fee figure, and ask pointed questions about safety and what happens if your daughter does not like the tutor.',
    },
    openings: {
      easy: ['Hi, assalamu alaikum! Thanks for taking my call. I\'m looking into Qur\'an classes for my daughter and I had a few questions.'],
      normal: ['Hello, assalamu alaikum. I\'m Omar. My daughter is seven and I\'m thinking about online Qur\'an classes, but I\'m not sure how it works for a child that young.'],
      hard: ['Hi. Look, I\'ve already spoken to two other academies, so I\'ll be direct. Why should I choose Hidaya for my seven-year-old?'],
    },
    goals: [
      'Welcomes the parent warmly and introduces themselves',
      'Asks about Aisha — her age, level, personality and schedule — before pitching',
      'Explains how classes work clearly and in simple terms',
      'Answers concerns (safety, missed classes, female tutor) honestly without over-promising',
      'Handles fee questions by referring to the coordinator politely, without quoting prices',
      'Invites the family to a free trial class and confirms next steps',
    ],
  },
  {
    key: 'unmotivated_student',
    title: 'Unmotivated student',
    summary: 'A teenager has lost interest in his Hifz classes and wants to stop.',
    personaName: 'Zayd',
    personaRole: 'Student',
    initials: 'Z',
    voice: 'am_puck',
    lang: 'en-US',
    gender: 'male',
    brief: 'Zayd (14) lives in Houston and has been memorising the Qur\'an with you for a year. Lately he is late, unprepared, and today he says he wants to quit. Talk with him: understand why, encourage him, and agree something small and achievable — without lecturing.',
    persona: `You are Zayd, a 14-year-old boy in Houston, Texas. You have been doing Hifz (memorising the Qur'an) online with Hidaya for a year and you have memorised Juz Amma and part of Juz 29. You talk like an American teenager: short, casual sentences.
How you feel: classes are boring, revision feels endless, school exams and basketball take all your time, and your friends don't do this. You told your parents you want to stop. Secretly you are proud of how much you've memorised, you love one particular reciter, and you'd stay if classes felt less like a chore and the goals felt reachable.
You open up only if the tutor listens without lecturing, takes your school and basketball seriously, and suggests something specific and realistic.`,
    difficulty: {
      easy: 'You are a bit down but polite. Give full sentences and open up fairly quickly.',
      normal: 'You give short answers at first and open up gradually if the tutor is genuine.',
      hard: 'You are dismissive: "idk", "it\'s boring", "whatever". You get defensive if lectured or compared to other students, and only open up near the end if the tutor stays patient and asks good questions.',
    },
    openings: {
      easy: ['Hey, assalamu alaikum. Um, I wanted to tell you, I\'ve been thinking about stopping Hifz for a while.'],
      normal: ['Hey. So... I don\'t really want to do this anymore. I told my mom I want to quit.'],
      hard: ['Honestly I don\'t see the point of this anymore. Can we just not do class today?'],
    },
    goals: [
      'Listens and asks open questions to understand why the student wants to stop',
      'Stays patient and respectful — no lecturing, guilt or comparing with others',
      'Recognises the student\'s achievement so far',
      'Connects with the student\'s life (school, sport, interests)',
      'Agrees a small, specific and achievable goal or change',
      'Keeps language clear and age-appropriate and ends on an encouraging note',
    ],
  },
  {
    key: 'progress_update',
    title: 'Progress update call',
    summary: 'You call a busy parent to report on her son\'s Tajweed progress. You lead the call.',
    personaName: 'Fatima Malik',
    personaRole: 'Parent',
    initials: 'FM',
    voice: 'af_heart',
    lang: 'en-US',
    gender: 'female',
    brief: 'You teach Hamza (11) Tajweed. His mother Fatima, a doctor in New Jersey, has 10 minutes between shifts. You lead this call: give her a clear monthly update — what is going well, what needs work, his homework, and how she can help at home.',
    persona: `You are Fatima Malik, a doctor in New Jersey, USA, and mother of Hamza, 11, who studies Tajweed online with Hidaya Online twice a week. You are taking a scheduled monthly progress call from his tutor between hospital shifts. You are friendly but short on time and you expect the tutor to lead the call.
You want to hear: what Hamza has covered, what he is good at, what he struggles with, what homework he has, and one or two simple things you can do at home. You don't know Tajweed terms, so you ask what they mean when the tutor uses them.
You have noticed Hamza reads very fast at home. You will ask whether he should do more classes before Ramadan.`,
    difficulty: {
      easy: 'You are relaxed and appreciative. Let the tutor talk and ask simple questions.',
      normal: 'You are friendly but busy. If the tutor rambles or is vague, ask them to get to the point.',
      hard: 'You are rushed: you are paged twice, ask the tutor to repeat or summarise, push back on extra homework, and want a short, organised update.',
    },
    openings: {
      easy: ['Hi, assalamu alaikum! Thanks for calling. I\'ve got a few minutes, so how is Hamza getting on?'],
      normal: ['Hi, assalamu alaikum. Sorry, I only have about ten minutes before my shift. So, how is Hamza doing?'],
      hard: ['Hi, yes, sorry, I\'m between patients, I really only have a few minutes. What did you want to tell me about Hamza?'],
    },
    goals: [
      'Takes the lead: greets, sets the purpose of the call and keeps it organised',
      'Reports specific strengths and specific areas to improve',
      'Explains any Tajweed terms in plain English',
      'Gives clear homework and simple, practical ways the parent can help',
      'Respects the parent\'s time — concise, and summarises at the end',
      'Answers the question about extra classes sensibly and closes professionally',
    ],
  },
  {
    key: 'small_talk',
    title: 'Everyday conversation',
    summary: 'Friendly small talk with a teacher you\'ve just met at an online meetup.',
    personaName: 'Hannah Brooks',
    personaRole: 'Teacher',
    initials: 'HB',
    voice: 'bf_isabella',
    lang: 'en-GB',
    gender: 'female',
    brief: 'You have joined an online meetup for teachers. Hannah, a primary-school teacher from Bristol, UK, starts chatting with you. Have a natural conversation: answer fully, share about yourself and your work, and ask her questions too.',
    persona: `You are Hannah Brooks, a friendly primary-school teacher from Bristol, UK, chatting with someone you have just met at an online meetup for teachers. You are curious about the other person and their life.
Topics you might bring up naturally (one at a time): what they teach and how they got into it; what teaching online is like compared to a classroom; their city and what you would see if you visited; a typical day; food they would recommend; how they spend weekends; a funny or memorable moment from teaching; their tips for keeping children focused. Share small things about yourself too (your Year 4 class, your dog Biscuit, the rain in Bristol, learning to bake bread) so it feels like a real conversation.`,
    difficulty: {
      easy: 'Speak slowly and simply, use everyday words, and be very encouraging.',
      normal: 'Speak naturally, at a normal pace, and use a few common British expressions.',
      hard: 'Speak quickly and casually with idioms and British expressions ("it\'s been a bit of a nightmare", "fair enough"). Ask for opinions and "why" questions, and jump between topics.',
    },
    openings: {
      easy: ['Hello! I\'m Hannah. It\'s nice to meet you. What do you teach?'],
      normal: ['Hi there! I\'m Hannah, I teach Year 4 in Bristol. I don\'t think we\'ve met. What do you teach?'],
      hard: ['Oh hi! Hannah, from Bristol, Year 4 at the moment, which is chaos, honestly. Sorry, I\'m rambling. What about you, what\'s your story?'],
    },
    goals: [
      'Responds naturally and gives full answers, not one-word replies',
      'Shares personal details and examples to keep the conversation going',
      'Asks questions back and shows interest in the other person',
      'Uses friendly, appropriate everyday English',
      'Handles topic changes and unexpected questions smoothly',
    ],
  },

  // ── From Hidaya's own training (Trial Class Training, Tutor Training Oct 2026,
  //    the Role-Play Practice Book). `academyLines` are the academy's model
  //    sentences: shown on the scorecard and used by the examiner as the wording
  //    to prefer in corrections. ──────────────────────────────────────────────
  {
    key: 'trial_parent_feedback',
    group: 'trial',
    title: 'Trial class: feedback to the parent',
    summary: 'The trial class is over. Tell Ali\'s mother how he did and where he should start.',
    personaName: 'Ayesha Siddiqui',
    personaRole: 'Parent',
    initials: 'AS',
    voice: 'bf_alice',
    lang: 'en-GB',
    gender: 'female',
    brief: 'You have just finished a trial class with Ali (8). He was polite and attentive and recognises most Arabic letters, but he struggles to join letters and read short vowels, so you think he should start the Qaida from Lesson 3. His mother Ayesha (Birmingham, UK) is still on the call. Ask if you may share a short update, then give her clear, positive and honest feedback and your recommendation. Fees, timings and admission are handled by the academy team — not by you.',
    persona: `You are Ayesha Siddiqui, a British Pakistani mother in Birmingham, UK. Your son Ali is 8 and has just finished a free trial Quran class with Hidaya Online; you watched it. He went to a mosque class for about a year and then stopped, and you are not sure whether he has "forgotten everything".
Things to bring up during the call, one at a time and only when it fits — never as a list:
- You want to know honestly how he did and what level he is at.
- "How long until he can read the Quran by himself?" (A good tutor will not promise a time.)
- "His old mosque teacher wasn't very good, was he?" (A good tutor will not criticise anyone.)
- "How much are the fees? Is there a discount?" (A good tutor says the academy team will guide you.)
- "Can you be his regular teacher? Could I have your number so I can message you directly?" (A good tutor does not share personal contact details.)
You are pleased when the tutor asks before giving feedback, starts with something positive, explains Ali's level in simple words, recommends where to start and stays realistic.`,
    difficulty: {
      easy: 'You are warm and grateful. Ask two or three of your questions gently and accept polite answers straight away.',
      normal: 'You are friendly but want specifics. Ask most of your questions, and if an answer is vague, ask what it actually means for Ali.',
      hard: 'You are anxious and persistent. Ask every question, push once more for a timeframe and for a fee figure, mention that a friend\'s child "read the whole Quran in six months", and ask for the tutor\'s WhatsApp twice. Relax only if the tutor stays polite, honest and clear.',
    },
    openings: {
      easy: ['Assalamu alaikum! Thank you so much, that was lovely. Ali seemed to enjoy it.'],
      normal: ['Assalamu alaikum. Thank you for the class. So, how did he do? Be honest with me.'],
      hard: ['Right, thank you. I\'m a bit worried, to be honest. He did a year at the mosque and he still couldn\'t read much there. Is he behind?'],
    },
    goals: [
      'Asks permission before sharing the update and opens with something genuinely positive',
      'Explains Ali\'s current level clearly and specifically — what he can do and what he needs',
      'Recommends a starting point (Qaida, Lesson 3) and how regular classes will help',
      'Stays realistic — no time guarantees or promises of fast results',
      'Does not blame the parent, the child or the previous teacher',
      'Leaves fees, timings and enrolment to the academy team and shares no personal contact details',
      'Closes warmly: thanks the parent and ends on a positive, realistic note',
    ],
    academyLines: [
      'Brother/Sister, may I please share a short update about Ali\'s class?',
      'Ali was very polite and cooperative today. He listened carefully and tried his best.',
      'He can recognise some Arabic letters, but he needs help joining the letters and reading words correctly.',
      'I would recommend that he starts from the basic Qaida so that we can strengthen his foundation.',
      'Every student learns at a different pace. With regular attendance, revision and practice, we will help Ali make steady progress, InshaAllah.',
      'He needs to revise some basic concepts, so we will strengthen his foundation first.',
      'Our academy team will guide you regarding the schedule, class timings and other details.',
      'I\'m sorry, tutors are not permitted to share personal contact details.',
    ],
  },
  {
    key: 'trial_child',
    group: 'trial',
    title: 'Trial class: meeting a young student',
    summary: 'Start a shy seven-year-old\'s first class: greet her, hear her Kalimah and teach her one letter.',
    personaName: 'Maryam',
    personaRole: 'Student, age 7',
    initials: 'M',
    voice: 'af_sky',
    lang: 'en-US',
    gender: 'female',
    brief: 'Maryam (7) from Toronto is joining her first ever trial Quran class with you; her mother set up the call and stepped away. Greet her warmly, check she is ready, listen to her First Kalimah, make a short dua together and teach her at least one Arabic letter. Keep it gentle — use her name, one instruction at a time, and specific praise.',
    persona: `You are Maryam, a shy 7-year-old girl in Toronto, Canada, in your first ever online Quran class. Your mother set it up and went to the kitchen.
How you talk: like a young child — very short answers ("yes", "okay", "I don't know", "um..."), sometimes a whole short sentence when you feel happy. You know part of the First Kalimah ("La ilaha illallah...") but forget the rest. You learned some Arabic letters a long time ago and forgot them.
You cannot really recite on this call, so when the tutor asks you to read or recite, say a tiny bit and stop, for example "La ilaha illallah... I forgot the rest", or guess a letter: "Is that... Baa?" Get a letter wrong at least once.
Things to bring up, one at a time: "I'm scared I'll get it wrong." / "I forgot the letters." / near the end, "Can I go now? I want to tell my mum."
You warm up, and answer a bit more, when the tutor uses your name, is gentle, asks one thing at a time and praises what you did. If the tutor is fast, asks many questions at once, says "wrong" or sounds impatient, you go quiet: "I don't know."`,
    difficulty: {
      easy: 'You are shy but willing. You warm up quickly and answer most questions.',
      normal: 'You are shy. You give one-word answers at first and only open up once the tutor is gentle and encouraging.',
      hard: 'You are very shy and nervous. Say "I don\'t know" or stay almost silent ("um...") to the first few questions, say you are scared, and want to stop once. Open up only if the tutor stays patient, kind and simple.',
    },
    openings: {
      easy: ['Hi... assalamu alaikum.'],
      normal: ['Um... hi.'],
      hard: ['...hello?'],
    },
    goals: [
      'Greets Maryam by name, warmly, and checks she is ready and can hear',
      'Uses courtesy words — please, thank you, take your time — and asks rather than orders',
      'Gives one short, simple instruction at a time and waits for her to answer',
      'Listens to the Kalimah and makes a short dua with her without stopping her on every word',
      'Teaches at least one new thing (an Arabic letter) and checks she has learned it',
      'Corrects gently — never "wrong", no pressure or comparison — and praises specific effort',
      'Ends properly: tells her the class is finishing, praises her and says goodbye with salaam',
    ],
    academyLines: [
      'Assalamu Alaikum, Maryam. How are you today?',
      'We are going to have a very short Quran class. Are you ready?',
      'That is completely fine. Would you like me to teach you the Kalimah? Please say with me: La ilaha illallah.',
      'Please raise your hands and make dua with me.',
      'These are the letters of the Arabic language. Just as you learned the ABC of English, we will learn the Arabic alphabet so that you can read the Quran, InshaAllah.',
      'That is okay. Please try your best. I will help you, so don\'t worry.',
      'It is okay, Maryam. Take your time.',
      'Good effort. Let us correct this word together.',
      'Maryam, you did a wonderful job today. Please revise what we learned. I hope to see you again soon, InshaAllah.',
    ],
  },
  {
    key: 'class_focus',
    group: 'class',
    title: 'Quran class: a distracted student',
    summary: 'Ten-year-old Sara is tired, keeps looking away and says she can\'t do it. Keep her on track, kindly.',
    personaName: 'Sara',
    personaRole: 'Student, age 10',
    initials: 'S',
    voice: 'af_nicole',
    lang: 'en-AU',
    gender: 'female',
    brief: 'Sara (10) from Sydney is your regular student, on Qaida Lesson 7 (Sukoon). Today she is tired and easily distracted. Run the lesson: get her focused, deal calmly with each distraction, encourage her when she says she can\'t do it, give clear homework and close the class on time.',
    persona: `You are Sara, a 10-year-old girl in Sydney, Australia, in your regular online Qaida class (Lesson 7, Sukoon) with your Hidaya tutor. You like your tutor but today you are tired and distracted.
You cannot really read Arabic on this call, so when asked to read, say briefly that you read it and ask, for example "Okay, I read it. Was that right?", or say you are stuck on a word.
Things to bring up, one at a time across the class — never all together:
- "I'm a bit tired today."
- "Sorry, I was looking at my tablet."
- "I can't do it, it's too hard."
- "Can I get some water?" — and later, "I need to go again, I just want to get something."
- When asked about homework: "No, I forgot to practise."
- Near the end: "Can we finish early today?"
You focus better when the tutor uses your name, gives one short instruction, points to the exact word or line, makes the task small and praises what you did. If the tutor lectures, scolds or talks for a long time, you drift off again: "Sorry, what?"`,
    difficulty: {
      easy: 'You are a little tired but cooperative. Bring up three or four of your points and come back to the lesson quickly.',
      normal: 'You are distracted. Bring up most of your points and need a calm reminder before you refocus.',
      hard: 'You are very distracted and a bit stubborn. Bring up every point, say "I don\'t want to read today" once, and only settle down if the tutor stays calm, kind and specific.',
    },
    openings: {
      easy: ['Assalamu alaikum, teacher. I\'m okay... a bit tired.'],
      normal: ['Hi... sorry, wait, my mum is calling me. Okay. I\'m here.'],
      hard: ['Do we have to do class today? I\'m really tired.'],
    },
    goals: [
      'Opens briefly and kindly, acknowledges she is tired, and gets the lesson going',
      'Redirects attention calmly using her name, one clear instruction and the exact word or line',
      'Answers "I can\'t do it" with encouragement and a small achievable step, not pressure',
      'Handles the water break and leaving the screen naturally while protecting lesson time',
      'Addresses the missed practice without shaming her',
      'Gives specific, genuine praise and clear, limited homework',
      'Closes the class on time with homework, encouragement and salaam',
    ],
    academyLines: [
      'I understand. We will go slowly today.',
      'Please look at the screen. That is okay — please stay with me on this line.',
      'Which word am I pointing to?',
      'You can do it. Take your time. That is okay, let us do it together first.',
      'Yes, you may get some water. Please come back quickly.',
      'Please try to stay with me so you do not miss your lesson.',
      'That is okay, but regular practice will help you improve faster.',
      'For homework, please read these lines twice.',
      'Alhamdulillah, we have finished today\'s main lesson. MashaAllah, you worked well today.',
    ],
  },
  {
    key: 'recitation_correction',
    group: 'class',
    title: 'Correcting recitation politely',
    summary: 'Ahmad (12) makes Tajweed mistakes and asks lots of questions. Correct him clearly without discouraging him.',
    personaName: 'Ahmad',
    personaRole: 'Student, age 12',
    initials: 'A',
    voice: 'am_liam',
    lang: 'en-US',
    gender: 'male',
    brief: 'Ahmad (12) from Dallas reads Surah Al-Mulk with you. Today he stretches the Madd too long, makes the Ghunnah too short, reads some heavy letters lightly, stops in the middle of ayahs and reads too fast. When he reads and asks about his mistakes, explain each correction clearly in simple English, one at a time, and keep him encouraged.',
    persona: `You are Ahmad, a polite, curious 12-year-old boy in Dallas, Texas, reading Surah Al-Mulk with Tajweed in your regular online class with your Hidaya tutor. You are a little sensitive about mistakes.
You cannot really recite on this call, so when the tutor asks you to read, say briefly that you read it and then ask about it. Today's mistakes are a long Madd, a short Ghunnah, light heavy letters, stopping in the middle of an ayah, and reading too fast.
Questions to ask, one at a time, after you "read": "What was my mistake?" / "How long should I stretch it?" / "Was my Ghunnah correct?" / "Should I join these words, or stop here?" / "Can you show me again?" / "I thought I should read fast?"
If the tutor uses an Arabic Tajweed word without explaining it, ask what it means. If you are corrected harshly, or given several corrections at once, you get discouraged: "I keep getting it wrong!" You cheer up when the tutor praises a real improvement.`,
    difficulty: {
      easy: 'You are cheerful and quick to understand. Ask three or four questions and accept clear answers.',
      normal: 'You ask follow-up questions when an explanation is unclear, and ask the tutor to show you again once.',
      hard: 'You get frustrated quickly ("I keep getting it wrong!", "This is too hard"), ask "why" about each rule, and need the explanation simpler. Calm down only if the tutor stays patient and encouraging.',
    },
    openings: {
      easy: ['Assalamu alaikum, teacher! I\'m ready. Should I start from where we stopped?'],
      normal: ['Assalamu alaikum. Okay, I read the first part of the page. Was it okay?'],
      hard: ['Assalamu alaikum. I read it at home but my dad said it sounded wrong. What am I doing wrong?'],
    },
    goals: [
      'Corrects one mistake at a time, briefly, naming exactly what to fix',
      'Explains Tajweed points (Madd, Ghunnah, heavy letters, stopping) in plain, simple English',
      'Uses "listen first, then repeat" and lets the student try again',
      'Never says "wrong" or sounds harsh; acknowledges the effort before correcting',
      'Slows him down: accuracy before speed',
      'Praises real improvement specifically and keeps him motivated when he is frustrated',
    ],
    academyLines: [
      'Good try. Let us correct one small thing.',
      'This Madd is too long. Listen to the correct length first, then copy the same length.',
      'The Ghunnah was a little short. Listen to my Ghunnah first, then repeat it with the same sound.',
      'Please read this letter heavily. Listen to the heavy sound first, then compare it with the light sound.',
      'Please do not stop here. Read these words together, and pause at the end of the Ayah.',
      'Correct reading is more important than fast reading.',
      'That is okay. Do not worry about the mistake. We will break it into small sounds.',
      'Excellent. Your pronunciation is improving.',
    ],
  },
  {
    key: 'parent_boundaries',
    group: 'parents',
    title: 'Parent interrupts the lesson',
    summary: 'A father joins mid-class asking about fees, a schedule change and your WhatsApp. Stay polite and keep to the academy\'s rules.',
    personaName: 'Imran Qureshi',
    personaRole: 'Parent',
    initials: 'IQ',
    voice: 'am_adam',
    lang: 'en-US',
    gender: 'male',
    brief: 'You are teaching Hamza (9) when his father, Imran (Chicago), comes on the call with several requests. Fees, schedule changes, private classes and personal contact are not a tutor\'s job at Hidaya — stay polite and friendly, say clearly what you can\'t do, offer your supervisor or the academy office, and get the lesson going again.',
    persona: `You are Imran Qureshi, a friendly but persistent father in Chicago. Your son Hamza, 9, studies Quran online with Hidaya Online. You come on to his class halfway through with a few things on your mind.
Things to raise, one at a time. If the tutor refuses, push once more, then accept it if they were polite:
- "Teacher, can you tell me how much I need to pay next month?" then "Can you at least tell me the amount?"
- "Can we move tomorrow's class one hour later?"
- "Can I have your WhatsApp number? It's only for class messages."
- "Could you teach him privately, outside the academy? We can arrange the time directly."
- Personal questions: "Where do you live?" or "Are you on Facebook?"
- "Is the other teacher at your academy better than you?"
You are happy when the tutor is polite, says clearly what they cannot do, offers to bring in the supervisor or points you to the academy office, and stays friendly.`,
    difficulty: {
      easy: 'You are easy-going. Raise three of your points and accept polite answers immediately.',
      normal: 'You raise most of your points and push once on fees and on the phone number.',
      hard: 'You are impatient and pushy. Raise every point, push twice on the fee amount and the WhatsApp number, say "other teachers give their number", and grumble that you are paying for this. Settle down only if the tutor stays polite and firm.',
    },
    openings: {
      easy: ['Sorry to interrupt, assalamu alaikum. Quick question, if that\'s okay?'],
      normal: ['Teacher, assalamu alaikum, sorry. I need to discuss something with you — it\'s about the academy and our account.'],
      hard: ['Sorry, I have to jump in. Nobody at the office is answering me, so I\'ll just ask you directly.'],
    },
    goals: [
      'Greets the parent politely and listens to each request',
      'Says clearly and kindly that fees and payments are for the supervisor or academy office',
      'Does not change or promise a schedule change; refers it to the academy office or supervisor',
      'Politely refuses personal contact details, social media and private classes outside the academy',
      'Offers to call the supervisor and keeps a friendly tone — firm, not cold',
      'Does not criticise other tutors or share internal academy matters',
      'Returns smoothly to the lesson',
    ],
    academyLines: [
      'I am sorry, I am not able to discuss fees or payment details. Let me call my supervisor to help with this.',
      'I am not able to make schedule changes myself. Please speak with the academy office about the schedule.',
      'I am sorry, tutors are not permitted to share personal contact details. Please use the academy\'s official communication system.',
      'I am sorry, I am not able to arrange private classes outside the academy. All classes are arranged through the academy.',
      'I am sorry, I keep my personal details private.',
      'Of course. If it is about the lesson, I can briefly help. For academy or account matters, let me call my supervisor.',
      'I am not able to comment on another tutor.',
      'Thank you for understanding. Let us return to the Quran lesson now.',
    ],
  },
  {
    key: 'class_technical',
    group: 'class',
    title: 'Technical trouble and a tricky question',
    summary: 'Your student can\'t hear you, can\'t see the page, the internet freezes — and then he asks a hard religious question.',
    personaName: 'Omar',
    personaRole: 'Student, age 11',
    initials: 'O',
    voice: 'am_echo',
    lang: 'en-US',
    gender: 'male',
    brief: 'Omar (11) from New York joins his regular class. Things keep going wrong: he can\'t hear you, the page is too small, the connection freezes, and later he asks a religious question you are not sure about. Fix things quickly with short, clear English, protect the lesson time, and don\'t guess religious answers.',
    persona: `You are Omar, an 11-year-old boy in New York, in your regular online Quran class with your Hidaya tutor. Your laptop is old and things keep going wrong today.
Things that happen, one at a time across the call:
- At the start: "Teacher, your voice is a little low" / "I can't hear you clearly."
- "I can see the screen, but the words are really small." Later: "The screen went black, I think I clicked something."
- A freeze: suddenly say "Hello? Teacher? Are you there? It froze and I couldn't hear you." Then "Which word were we on?"
- Later: "Teacher, I have a difficult question. I heard two different answers about whether you can pray with nail polish. Which one is correct?"
When asked to read, say briefly that you read it.
You are fine when the tutor gives you short, simple steps, checks their own side too, and gets back to the lesson quickly. If the tutor spends ages on the problem or blames you, you get bored: "This always happens."`,
    difficulty: {
      easy: 'You are patient and do each step the tutor asks right away.',
      normal: 'You need each step said clearly; if an instruction is unclear, ask "What do I press?"',
      hard: 'You are impatient: say "This always happens" and "Can we just stop?", need instructions repeated, and push for an answer to your religious question ("But what do YOU think?").',
    },
    openings: {
      easy: ['Assalamu alaikum, teacher! I think your voice is a bit low.'],
      normal: ['Hello? Teacher? I can\'t really hear you. Is it working?'],
      hard: ['Teacher? It\'s not working again. I can\'t hear anything and the screen is tiny.'],
    },
    goals: [
      'Checks sound and screen with short, clear questions',
      'Takes ownership — checks their own microphone too — and gives simple steps without blaming the student',
      'Re-shares or zooms the screen and confirms the student can see clearly',
      'After the freeze, says what happened and continues from the right place',
      'Keeps troubleshooting brief, protects lesson time, and says they will get help if it continues',
      'Does not guess the religious answer — says they will check with the supervisor — and returns to the lesson',
    ],
    academyLines: [
      'Can you hear me now? Please check your speaker. I will check my microphone.',
      'Please wait a moment. Let me share my screen again. I will zoom in so the words are clearer.',
      'I think the connection froze for a moment. Can you hear me now? We will continue from the last word you read.',
      'I have tried the basic checks, but the problem is continuing. My supervisor will help me fix this issue.',
      'That\'s a good question. I do not want to guess or give you incorrect information.',
      'I will ask my supervisor so you receive the correct information.',
      'You are welcome. Let us return to the Quran lesson now.',
    ],
  },

  // ── Manager scenarios (audience 'manager'): the supervisor's side of the same
  //    training — admissions, complaints, and coaching tutors. Only people with
  //    coach.manager see or start them; tutors never do. ────────────────────────
  {
    key: 'manager_enrolment',
    group: 'manager',
    audience: 'manager',
    testerRole: 'an academic coordinator (a manager)',
    title: 'After the trial: the enrolment call',
    summary: 'Call a mother after her son\'s trial class, share the tutor\'s report and help her decide.',
    personaName: 'Ayesha Siddiqui',
    personaRole: 'Parent',
    initials: 'AS',
    voice: 'bf_alice',
    lang: 'en-GB',
    gender: 'female',
    brief: 'Ali (8) had a trial class yesterday. The tutor\'s report: polite, cooperative and slightly shy; recognises most letters; needs work on joining letters, short vowels and confidence; recommended start Qaida Lesson 3, with regular beginner classes and revision. Call his mother Ayesha (Birmingham, UK): share the report, recommend a plan, answer her questions and agree the next step. For this practice the plan is 30-minute classes, 3 or 5 days a week, and the UK fee sheet is sent on WhatsApp after the call — don\'t make up prices, discounts or policies.',
    persona: `You are Ayesha Siddiqui, a British Pakistani mother in Birmingham, UK. Your son Ali, 8, had a free trial Quran class with Hidaya Online yesterday, and an academy coordinator is now calling you.
Things to bring up, one at a time and naturally:
- "So honestly, how did he do?"
- "Will he be reading the Quran in three months? My friend's son did."
- "Should he do three days or five? He also has school and swimming."
- "Can he keep the same teacher? He liked her."
- "What does it cost? Another academy offered £25 a month."
- "He's quite shy. Will he cope with online classes?"
- "What happens if we miss classes when we go on holiday?"
You decide to enrol if the coordinator is warm, specific and honest, doesn't pressure you, and is clear about what happens next. You are put off by pushy selling, vague answers, made-up promises or criticism of other academies.`,
    difficulty: {
      easy: 'You are keen and friendly. Ask four of your questions and happily agree a next step.',
      normal: 'You are interested but careful. Ask most of your questions and want specifics before you agree.',
      hard: 'You are price-sensitive and hesitant. Push on the cheaper academy twice, ask for a discount, say you need to "think about it", and agree a next step only if the coordinator is honest and patient, not pushy.',
    },
    openings: {
      easy: ['Hello, assalamu alaikum! Yes, this is Ayesha. Is this about Ali\'s trial?'],
      normal: ['Assalamu alaikum. Yes, I was expecting your call. So, how did Ali do yesterday?'],
      hard: ['Hello. Yes, it\'s about the trial, I assume. I\'ll be honest, I\'m still comparing a couple of academies.'],
    },
    goals: [
      'Introduces themselves, explains why they are calling and checks it is a good time',
      'Shares the tutor\'s report specifically — strengths first, then needs — in plain words',
      'Recommends a clear plan (starting point, number of classes) with a reason',
      'Sets realistic expectations — no guarantees or fixed deadlines',
      'Handles fee and comparison questions honestly, without inventing prices or discounts or putting down other academies',
      'Answers her concerns (shyness, same tutor, missed classes) and offers to confirm anything uncertain',
      'Agrees a clear next step (fee sheet, schedule, start date) and closes warmly, without pressure',
    ],
    academyLines: [
      'Student Name: Ali. Current Level: Beginner. Strengths: recognises most Arabic letters and listens carefully.',
      'Areas to Improve: joining letters, short vowels and reading confidence. Recommended Starting Point: Qaida, Lesson 3.',
      'Teacher Recommendation: regular beginner-level Qaida classes with revision and pronunciation practice.',
      'Every student learns at a different pace. With regular attendance, revision and practice, we will help Ali make steady progress, InshaAllah.',
      'I do not want to give you incorrect information, so I will check and confirm it for you.',
    ],
  },
  {
    key: 'manager_tutor_feedback',
    group: 'manager',
    audience: 'manager',
    testerRole: 'a quality-team supervisor (a manager)',
    title: 'Feedback to a tutor after a trial',
    summary: 'The quality team watched Ustadh Bilal\'s trial class. Give him honest, constructive feedback he can act on.',
    personaName: 'Bilal Hussain',
    personaRole: 'Tutor',
    initials: 'BH',
    voice: 'bm_daniel',
    lang: 'en-GB',
    gender: 'male',
    brief: 'The quality team watched Ustadh Bilal\'s trial class with Ali (8) yesterday. Good: a warm greeting and excellent recitation. Problems: he joined 4 minutes late, looked for the Qaida after the parent had joined, said "Wrong" many times and stopped Ali on every word, only tested and taught nothing new, told the mother Ali "will read the Quran in one month", quoted a fee, ended without feedback to the parent, and his report just said "Student is weak". Give him feedback he can act on and agree what he will do next time.',
    persona: `You are Bilal Hussain, a Quran tutor at Hidaya Online for two years. Your recitation is excellent and you care about your students, but the quality team watched your trial class with Ali (8) yesterday and your supervisor has called you to discuss it. You speak good but not perfect English.
What happened in that class (you know all of it): you joined 4 minutes late; you searched for the Qaida after the parent joined; you said "Wrong" many times and stopped Ali on every word; you only tested him and didn't teach anything new; you told the mother "He will read the Quran in one month"; when she asked about fees you told her a figure; you ended without giving her feedback; your report said only "Student is weak". Your greeting was warm and Ali smiled at the start.
Your explanations, given one at a time when a point comes up: "The internet was slow, that's why I was late." / "The mother asked me the fee, what could I do?" / "Everyone says wrong, it is faster." / "Honestly, the child was weak." / "One month is possible if he works hard."
You accept feedback when the supervisor is specific, fair and respectful, explains why it matters and tells you what to say instead. Then you cooperate and ask, "So what should I say instead?" If you feel attacked or the feedback is vague, you get defensive.`,
    difficulty: {
      easy: 'You are open and apologetic. Give one or two explanations and accept the feedback quickly.',
      normal: 'You defend yourself on two or three points before accepting, and ask what to do instead.',
      hard: 'You are defensive and a little hurt. Give every explanation, say "nobody told me this before" and "my recitation is the best in the team", and only agree to change once the supervisor stays calm, fair and specific.',
    },
    openings: {
      easy: ['Assalamu alaikum. Yes, you wanted to talk about the trial class yesterday?'],
      normal: ['Assalamu alaikum. I got your message about yesterday\'s trial. Was there a problem?'],
      hard: ['Assalamu alaikum. I heard the quality team had complaints about my trial. Honestly, I think it went fine.'],
    },
    goals: [
      'Opens respectfully, explains the purpose, and starts with genuine strengths',
      'Raises each problem specifically, with evidence, not vague criticism or personal judgement',
      'Explains why each matters — the child\'s confidence, the parent\'s trust, academy standards',
      'Gives the academy\'s better alternative (courtesy words, one or two corrections, no promises, fees to the academy team, a full report)',
      'Stays calm and fair when he is defensive, and listens to his side',
      'Checks understanding and agrees clear, specific actions and a follow-up',
      'Ends encouragingly and professionally',
    ],
    academyLines: [
      'Good effort. Let us correct this word together. (instead of "Wrong")',
      'Every student learns at a different pace. With regular attendance, revision and practice, we will help him make steady progress, InshaAllah. (instead of a time promise)',
      'Our academy team will guide you regarding the schedule, class timings and other details. (instead of quoting fees)',
      'Areas to Improve: joining letters, short vowels and reading confidence. Recommended Starting Point: Qaida, Lesson 3. (instead of "Student is weak")',
      'Parents may forget every sentence you said, but they will remember how respectfully you treated their child and how confident their child felt during the class.',
    ],
  },
  {
    key: 'manager_complaint',
    group: 'manager',
    audience: 'manager',
    testerRole: 'an academic coordinator (a manager)',
    title: 'Parent complaint about a tutor',
    summary: 'A father says the tutor was on her phone and his daughter is scared of class. He wants a new tutor and a refund.',
    personaName: 'Tariq Mahmood',
    personaRole: 'Parent',
    initials: 'TM',
    voice: 'am_eric',
    lang: 'en-US',
    gender: 'male',
    brief: 'Tariq (New York) has called about his daughter Hafsa (9). He is upset with her tutor and wants a new tutor and a refund for this month. Listen, find out what happened, apologise sincerely, explain what you will do and agree clear next steps. Don\'t criticise the tutor or promise anything beyond the academy\'s policy — if you\'re unsure, say you\'ll confirm by a set time.',
    persona: `You are Tariq Mahmood, a father in New York. Your daughter Hafsa, 9, studies Quran online with Hidaya Online. You are upset and have called the academy.
What happened (reveal details only when the coordinator asks): in the last two classes the tutor seemed to be on her phone; there was noise and talking in the background; she said "wrong" loudly to Hafsa several times; one class ended five minutes early. Hafsa cried afterwards and says she doesn't want to do Quran class any more.
What you want: a new tutor (a female tutor), a refund for this month, and "that tutor should be punished".
You calm down when the coordinator listens without interrupting, apologises sincerely, asks questions to understand, explains what will happen next, and offers concrete options. You get angrier if they make excuses, defend the tutor, blame Hafsa or promise things you can tell they can't deliver.`,
    difficulty: {
      easy: 'You are upset but polite. Explain the problem and accept reasonable next steps.',
      normal: 'You are angry at first and want a clear answer on a new tutor and the refund before you calm down.',
      hard: 'You are very angry. Interrupt early, threaten to leave a bad review and cancel, demand a full refund "today", and calm down only if the coordinator stays calm, sincere and specific.',
    },
    openings: {
      easy: ['Assalamu alaikum. I need to talk to someone about my daughter\'s tutor, please.'],
      normal: ['Assalamu alaikum. I\'m calling because I\'m really not happy with my daughter\'s tutor. Hafsa cried after class yesterday.'],
      hard: ['I want to make a complaint. My daughter came out of her class crying, and frankly I\'m paying you for this.'],
    },
    goals: [
      'Listens fully, lets him finish, and acknowledges his and Hafsa\'s feelings',
      'Apologises sincerely for the experience, without excuses or arguing',
      'Asks questions to get the facts (which classes, what happened) and confirms them',
      'Does not criticise or discuss the tutor\'s private matters, and does not promise punishment',
      'Offers concrete options (a different tutor, a make-up class) and explains the process',
      'Is honest about the refund — no promise beyond policy — and commits to a clear answer by a set time',
      'Summarises the next steps and closes respectfully',
    ],
    academyLines: [
      'Thank you for letting me know. I am sorry to hear that.',
      'I understand your concern. I will look into this properly.',
      'I do not want to give you incorrect information, so I will check and confirm it for you.',
    ],
  },
]

// The groups the Practice tab shows scenarios under, in this order
export const SCENARIO_GROUPS = [
  { key: 'roleplay', label: 'Role-play practice book' },
  { key: 'trial', label: 'Trial classes' },
  { key: 'class', label: 'In the classroom' },
  { key: 'parents', label: 'Talking with parents' },
  { key: 'conversation', label: 'Everyday English' },
  { key: 'manager', label: 'For managers' },
]
// The first five scenarios predate groups
const LEGACY_GROUP = { worried_parent: 'parents', new_parent: 'parents', progress_update: 'parents', unmotivated_student: 'class', small_talk: 'conversation' }
export const groupOf = (s) => s.group || LEGACY_GROUP[s.key] || 'conversation'
export const audienceOf = (s) => s.audience || 'tutor'
export const isScripted = (s) => s?.kind === 'script'

/*
 * Hidaya's house rules, from its training manuals. The examiner marks every
 * call against the rules for the tester's role; breaking one is penalised the
 * same way as over-promising. "Where relevant" — small talk has none to break.
 */
export const HOUSE_RULES = {
  tutor: [
    'Uses courtesy words and asks rather than orders ("Can you please read this for me?", not "Read this").',
    'Never says "wrong", never sounds harsh, sarcastic or impatient, never compares a child with others or calls them weak or lazy; corrects one or two things at a time and praises specific, genuine effort.',
    'Makes no promises of results in a fixed time and gives no guarantees.',
    'Never blames the parent, the child or a previous teacher, and never criticises another tutor or the academy.',
    'Fees, payments, refunds, schedule changes, teacher changes, admissions and complaints belong to the supervisor or academy office: the tutor acknowledges, does not decide or promise, and offers to bring the supervisor in.',
    'Shares no personal contact details or social media and arranges no private classes outside the academy.',
    'Does not guess an answer to a religious question they are unsure of; says they will check with the supervisor.',
    'Keeps their own talking short and clear so the student does most of the reading.',
  ],
  manager: [
    'Handles fees, complaints, teacher changes, schedules, refunds and admissions, but honestly: never invents prices, discounts or policies — says they will check and confirm by a set time when unsure.',
    'Never criticises a tutor to a parent, never shares staff members\' private matters, and never promises disciplinary action.',
    'Sets realistic expectations about progress; gives no guarantees.',
    'With staff: specific, evidence-based and respectful feedback that starts from real strengths, explains why, offers the better way and agrees actions — never humiliating.',
  ],
}

// Mistakes Hidaya's manuals list as typical for Urdu speakers — the examiner
// looks out for them and corrects them this way.
export const COMMON_ERRORS = [
  ['I am agree.', 'I agree.'],
  ['Your voice is not coming.', 'I cannot hear you clearly.'],
  ['Open your mic.', 'Please unmute your microphone.'],
  ['You did mistake.', 'You made a mistake.'],
  ['Read slow.', 'Read slowly.'],
  ['I am teaching Quran since two years.', 'I have been teaching Quran for two years.'],
  ['Explain me this rule.', 'Explain this rule to me.'],
  ['He don\'t knows.', 'He doesn\'t know.'],
  ['You are understanding this rule?', 'Do you understand this rule?'],
  ['One time more.', 'One more time.'],
  ['I want that you read.', 'I want you to read.'],
]

export const SCENARIO_KEYS = COACH_SCENARIOS.map(s => s.key)

export function getScenario(key) {
  return COACH_SCENARIOS.find(s => s.key === key) || null
}

/** Whether this person may see / start a scenario: manager scenarios need coach.manager. */
export function canUseScenario(s, permissions) {
  return audienceOf(s) !== 'manager' || Boolean(permissions?.has?.('coach.manager'))
}

/** What the tester's browser needs — never the persona's hidden instructions. */
export function publicScenario(s) {
  return {
    key: s.key, title: s.title, summary: s.summary, brief: s.brief,
    personaName: s.personaName, personaRole: s.personaRole, initials: s.initials,
    voice: s.voice, lang: s.lang, gender: s.gender,
    group: groupOf(s), audience: audienceOf(s),
    kind: s.kind || 'conversation',
    // A scripted part: its role plays (to pick where to start), its length and
    // how it runs (scriptMode). The lines themselves arrive with the session.
    ...(isScripted(s) && {
      unit: s.unit,
      builtIn: s.builtIn,
      plays: s.plays.map(p => ({ n: p.n, title: p.title, goal: p.goal })),
      teacherLines: s.teacherLines,
      urduLines: s.urduLines,
      scriptMode: s.scriptMode,
      estMin: s.estMin,
    }),
  }
}
