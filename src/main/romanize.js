'use strict';

/**
 * Rule-based romanized-Hindi → Devanagari transliteration.
 *
 * This exists to close a loop. The offline translator (localtranslate.js) reads
 * Devanagari only — on romanized Hindi it returns confident nonsense — and most
 * of what LRCLIB carries for Indian songs is romanized. So the local, key-free
 * path currently covers native-script songs and little else. Converting the
 * script first feeds those lyrics into a translator that already works.
 *
 * Rule-based rather than a model, because Devanagari is phonetic: the mapping
 * from sound to glyph is near-deterministic, so a table plus a few positional
 * rules gets most of the way with no download, no key, and no inference cost.
 *
 * WHAT IT CANNOT DO. Romanization is lossy in ways no rule can recover:
 *
 *   - Dental vs retroflex is simply not written. "tha" is both थ and ठ; this
 *     always picks the dental, which is the commoner of the two in lyrics.
 *   - Nasals collapse to anusvara rather than the specific nasal consonant.
 *   - Spelling is not standardised ("mai"/"main"/"mein" all appear for मैं).
 *
 * So the output is a good approximation, not a faithful rendering, and it is
 * offered as an input to translation rather than as text to display. The
 * LLM-backed transliterator in transliterate.js remains the better choice when
 * a provider is configured.
 */

/** Consonants, longest-first so digraphs win over their prefixes. */
const CONSONANTS = [
  ['chh', 'छ'], ['shh', 'ष'],
  ['kh', 'ख'], ['gh', 'घ'], ['ch', 'च'], ['jh', 'झ'], ['th', 'थ'], ['dh', 'ध'],
  ['ph', 'फ'], ['bh', 'भ'], ['sh', 'श'], ['ng', 'ङ'], ['ny', 'ञ'],
  ['k', 'क'], ['g', 'ग'], ['j', 'ज'], ['t', 'त'], ['d', 'द'], ['n', 'न'],
  ['p', 'प'], ['b', 'ब'], ['m', 'म'], ['y', 'य'], ['r', 'र'], ['l', 'ल'],
  ['v', 'व'], ['w', 'व'], ['s', 'स'], ['h', 'ह'],
  // Perso-Arabic sounds, written with a nukta. Common in film and rap lyrics.
  ['z', 'ज़'], ['f', 'फ़'], ['q', 'क़'],
];

/** Vowels as [independent, matra], longest-first. */
const VOWELS = [
  ['aa', 'आ', 'ा'], ['ai', 'ऐ', 'ै'], ['au', 'औ', 'ौ'],
  ['ee', 'ई', 'ी'], ['ii', 'ई', 'ी'], ['oo', 'ऊ', 'ू'], ['uu', 'ऊ', 'ू'],
  ['a', 'अ', ''], ['i', 'इ', 'ि'], ['u', 'उ', 'ु'],
  ['e', 'ए', 'े'], ['o', 'ओ', 'ो'],
];

const VIRAMA = '्';
const ANUSVARA = 'ं';

/**
 * Longest matching entry from a table at a position.
 * @param {string} s
 * @param {number} i
 * @param {Array} table
 * @returns {Array|null} the matching row
 */
function matchAt(s, i, table) {
  for (const row of table) {
    if (s.startsWith(row[0], i)) return row;
  }
  return null;
}

/**
 * Transliterate one romanized word into Devanagari.
 * @param {string} word
 * @returns {string}
 */
function wordToDevanagari(word) {
  const s = String(word || '').toLowerCase();
  let out = '';
  let i = 0;
  let atStart = true;

  while (i < s.length) {
    const cons = matchAt(s, i, CONSONANTS);

    if (!cons) {
      const vow = matchAt(s, i, VOWELS);
      if (vow) {
        // A vowel with no consonant before it takes its independent form.
        out += vow[1];
        i += vow[0].length;
        atStart = false;
        continue;
      }
      i += 1;              // unmappable character; skip it
      continue;
    }

    /*
      A nasal directly before another consonant becomes anusvara rather than a
      full consonant — "zindagi" is ज़िंदगी, not ज़िनदगी. Only when a consonant
      actually follows, so a word-final "n" stays न.
    */
    if ((cons[0] === 'n' || cons[0] === 'm') && !atStart) {
      const after = i + cons[0].length;
      const nextCons = matchAt(s, after, CONSONANTS);
      const nextVow = matchAt(s, after, VOWELS);
      if (nextCons && !nextVow) {
        out += ANUSVARA;
        i = after;
        continue;
      }
    }

    out += cons[1];
    i += cons[0].length;
    atStart = false;

    const vow = matchAt(s, i, VOWELS);
    if (!vow) {
      /*
        No vowel follows. At the end of a word that is schwa deletion — Hindi
        drops the inherent "a" there and writes the consonant bare ("dil" is
        दिल, not दिल्).

        Mid-word, two consonants in a row are NOT automatically a conjunct: in
        "apna" the प keeps its inherent schwa (अपना), while in "pyaar" the प
        genuinely binds to the य (प्यार). What separates them is the SECOND
        consonant — a glide or liquid forms a true onset cluster, anything else
        is just a syllable boundary. Binding everything gave अप्ना.
      */
      const next = matchAt(s, i, CONSONANTS);
      const bindsAsCluster = next && ['y', 'r', 'l', 'v', 'w'].includes(next[0]);
      /*
        An "r" closing a syllable also binds, from the other side: "dard" is
        दर्द, not दरद. Same for a doubled consonant, where the gemination is
        written as a conjunct — "shradhdha" is श्रद्धा.
      */
      const isCodaR = cons[0] === 'r' && next;
      const isGeminate = next && next[0] === cons[0];
      if (i < s.length && (bindsAsCluster || isCodaR || isGeminate)) out += VIRAMA;
      continue;
    }

    /*
      Word-final "a" is the long ā in practice: romanized lyrics write मेरा as
      "mera" and अपना as "apna". Word-internally the same letter is the
      inherent schwa and gets no matra at all, which is why "kalam" is कलम.
    */
    const isFinal = i + vow[0].length >= s.length;
    if (vow[0] === 'a') out += isFinal ? 'ा' : '';
    // Word-final short vowels are written long in practice: "zindagi" is
    // ज़िंदगी, "kabhi" is कभी, "tu" is तू. Mid-word they stay short.
    else if (isFinal && vow[0] === 'i') out += 'ी';
    else if (isFinal && vow[0] === 'u') out += 'ू';
    else out += vow[2];
    i += vow[0].length;
  }

  return out;
}

/**
 * Transliterate a line, leaving anything that is not a romanized word alone.
 * @param {string} text
 * @returns {string}
 */
function lineToDevanagari(text) {
  return String(text || '').replace(/[A-Za-z]+/g, (w) => wordToDevanagari(w));
}

/**
 * Transliterate a cue list, preserving timing and any word-level spans.
 * @param {Array<{timeMs: number, text: string}>} cues
 * @returns {Array<{timeMs: number, text: string}>}
 */
function cuesToDevanagari(cues) {
  if (!Array.isArray(cues)) return [];
  return cues.map((cue) => ({ ...cue, text: lineToDevanagari(cue.text) }));
}

module.exports = { wordToDevanagari, lineToDevanagari, cuesToDevanagari, CONSONANTS, VOWELS };
